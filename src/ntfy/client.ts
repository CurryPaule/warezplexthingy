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

    const response = await this.fetchFn(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ntfy POST ${this.baseUrl} → ${response.status}: ${text}`);
    }
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
