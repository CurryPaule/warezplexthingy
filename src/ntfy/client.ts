import type { Config } from '../config';
import type { MatchRow } from '../nocodb/types';

export interface NtfyAction {
  action: 'view';
  label: string;
  url: string;
  clear?: boolean;
}

export interface NtfyMessage {
  title: string;
  message: string;
  tags?: string[];
  priority?: 1 | 2 | 3 | 4 | 5;
  click?: string;
  actions?: NtfyAction[];
}

export interface ManualDownloadNotification {
  reason: string;
  metadataPath: string;
  containerUrl?: string;
}

export interface ErrorNotification {
  /** Subsystem or pipeline step where the error occurred (e.g. "enrich", "search", "push", "ombi-sync", "sort", "workflow") */
  source: string;
  /** Short summary shown in the notification title */
  summary: string;
  /** Detailed error lines (one per failed item/step) */
  errors?: string[];
  /** Optional warez.cx entry UID to attach a clickable deeplink */
  warezUid?: string;
  /** Optional media title for building the warez.cx URL slug */
  title?: string;
}

const NTFY_TIMEOUT_MS = 10_000;
const MAX_ERROR_LINES = 10;
const MAX_ERROR_LINE_LENGTH = 300;

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Best-effort error alert via ntfy. Never throws so notification outages can never break scraping.
 */
export async function safeNotifyError(
  ntfy: NtfyClient | undefined,
  details: ErrorNotification,
): Promise<void> {
  if (!ntfy) return;
  try {
    await ntfy.notifyError(details);
    console.log(`  🔔 Sent ntfy error notification (${details.source})`);
  } catch (err) {
    console.warn(
      `  ⚠ Failed to send ntfy error notification (${details.source}):`,
      formatErrorMessage(err),
    );
  }
}

/**
 * Build a clickable warez.cx detail page deeplink from a match's WarezUid and Title.
 * Example: ("HLCmGK0UmWMt", "The House That Jack Built")
 *   → "https://warez.cx/detail/HLCmGK0UmWMt/The-House-That-Jack-Built"
 */
export function buildWarezDetailUrl(warezUid: string, title?: string): string {
  const uid = warezUid.trim();
  const slug = (title ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9\u00C0-\u024F]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug
    ? `https://warez.cx/detail/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}`
    : `https://warez.cx/detail/${encodeURIComponent(uid)}`;
}

export function isNtfyConfigured(config: Pick<Config, 'NTFY_TOPIC'>): boolean {
  return Boolean(config.NTFY_TOPIC?.trim());
}

/**
 * Minimal client for publishing rich notifications via ntfy (public ntfy.sh or self-hosted).
 * Uses the JSON publish API (`POST {baseUrl}` with `topic` in the JSON body) so titles and
 * messages support full UTF-8 (umlauts, punctuation) without HTTP header encoding issues.
 */
export class NtfyClient {
  private baseUrl: string;
  private topic: string;
  private token?: string;
  private fetchFn: typeof fetch;

  constructor(
    config: Pick<Config, 'NTFY_URL' | 'NTFY_TOPIC' | 'NTFY_TOKEN'>,
    fetchFn: typeof fetch = fetch,
  ) {
    if (!config.NTFY_TOPIC?.trim()) {
      throw new Error('ntfy config missing. Set NTFY_TOPIC.');
    }
    this.baseUrl = (config.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
    this.topic = config.NTFY_TOPIC.trim();
    this.token = config.NTFY_TOKEN?.trim() || undefined;
    this.fetchFn = fetchFn;
  }

  async publish(msg: NtfyMessage): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const payload: Record<string, unknown> = {
      topic: this.topic,
      title: msg.title,
      message: msg.message,
    };
    if (msg.tags && msg.tags.length > 0) payload.tags = msg.tags;
    if (msg.priority !== undefined) payload.priority = msg.priority;
    if (msg.click) payload.click = msg.click;
    if (msg.actions && msg.actions.length > 0) payload.actions = msg.actions;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ntfy POST ${this.baseUrl} → ${response.status}: ${text}`);
    }
  }

  /**
   * Send a high-priority emergency ping when a scraper step or item fails with an unexpected error.
   */
  async notifyError(details: ErrorNotification): Promise<void> {
    const rawErrors = (details.errors ?? [])
      .map(line => line.trim())
      .filter(Boolean);

    const visibleLines = rawErrors.slice(0, MAX_ERROR_LINES).map(line =>
      line.length > MAX_ERROR_LINE_LENGTH
        ? `${line.slice(0, MAX_ERROR_LINE_LENGTH - 1)}…`
        : line,
    );

    if (rawErrors.length > MAX_ERROR_LINES) {
      visibleLines.push(`…and ${rawErrors.length - MAX_ERROR_LINES} more error(s)`);
    }

    const message = visibleLines.length > 0 ? visibleLines.join('\n') : details.summary;
    const warezUrl = details.warezUid
      ? buildWarezDetailUrl(details.warezUid, details.title)
      : undefined;

    const actions: NtfyAction[] = [];
    if (warezUrl) {
      actions.push({
        action: 'view',
        label: 'Open on warez.cx',
        url: warezUrl,
      });
    }

    await this.publish({
      title: `Scraper error (${details.source}): ${details.summary}`,
      message,
      tags: ['rotating_light', 'x'],
      priority: 4,
      ...(warezUrl ? { click: warezUrl } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    });
  }

  /**
   * Send a rich notification requesting manual download when automated JDownloader pushing fails.
   */
  async notifyManualDownload(
    match: Pick<MatchRow, 'Title' | 'Fulltitle' | 'Type' | 'WarezUid' | 'SeasonEpisodeKey'>,
    details: ManualDownloadNotification,
  ): Promise<void> {
    const displayTitle = match.Title || match.Fulltitle;
    const isSeries = match.Type === 'series';
    const episodeSuffix = isSeries && match.SeasonEpisodeKey ? ` (${match.SeasonEpisodeKey})` : '';
    const warezUrl = match.WarezUid ? buildWarezDetailUrl(match.WarezUid, match.Title) : undefined;

    const lines: string[] = [];
    if (match.Fulltitle) lines.push(`Release: ${match.Fulltitle}`);
    if (isSeries && match.SeasonEpisodeKey) lines.push(`Episodes: ${match.SeasonEpisodeKey}`);
    lines.push(`Reason: ${details.reason}`);
    lines.push(`Download folder: ${details.metadataPath}`);

    const actions: NtfyAction[] = [];
    if (warezUrl) {
      actions.push({
        action: 'view',
        label: 'Open on warez.cx',
        url: warezUrl,
      });
    }
    if (details.containerUrl) {
      actions.push({
        action: 'view',
        label: 'Open Container',
        url: details.containerUrl,
      });
    }

    await this.publish({
      title: `${displayTitle}${episodeSuffix} — Manual download needed`,
      message: lines.join('\n'),
      tags: ['warning', isSeries ? 'tv' : 'movie_camera'],
      priority: 4,
      click: warezUrl ?? details.containerUrl,
      actions,
    });
  }
}
