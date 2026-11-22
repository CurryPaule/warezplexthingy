import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { CrawledLink, CrawledPackage, JDownloaderClient } from '../jdownloader/client';
import type { Config } from '../config';
import {
  buildEpisodesPattern,
  formatSeasonEpisodeKey,
  isSeasonPackFulltitle,
  parseEpisodeRange,
  type EpisodeRange,
} from '../matcher';
import { sleep } from '../utils';

/** Default delay in ms between polls for JDownloader to resolve container links */
const DEFAULT_POLL_DELAY_MS = 1500;
/** Default max attempts to poll linkgrabber (~60s at 1.5s interval) */
const DEFAULT_POLL_MAX_ATTEMPTS = 40;
/** Consecutive polls with unchanged link UUIDs (while not collecting) required before acting */
const DEFAULT_STABLE_POLLS_REQUIRED = 2;
/** Consecutive idle polls with 0 crawled direct links before concluding JDownloader discarded them */
const DEFAULT_MAX_EMPTY_IDLE_POLLS = 5;

const GENERIC_EPISODE_MARKER = /S\d{2}[._-]?E\d{1,3}(?!\d)/i;

export interface PushOptions {
  pollDelayMs?: number;
  maxPollAttempts?: number;
  stablePollsRequired?: number;
  maxEmptyIdlePolls?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface PushCandidate {
  urls: string[];
  hoster: string;
  source: 'direct' | 'crypted';
}

/**
 * Build a metadata-encoded download path for JDownloader.
 * Format: {imdbId}-{type}[-{seasonEpisodeKey}]
 * Examples:
 *   tt1234567-movie
 *   tt7631058-series-S02E05
 *   tt7631058-series-S02E04-E06
 */
export function buildMetadataPath(match: MatchRow): string {
  const parts: string[] = [];

  const imdbId = match.ImdbId || 'unknown';
  parts.push(imdbId);
  parts.push(match.Type || 'movie');

  if (match.SeasonEpisodeKey) {
    parts.push(match.SeasonEpisodeKey);
  }

  return parts.join('-');
}

/**
 * Select a crypted container link from a match record based on hoster priority.
 * CryptedLinks is a JSON-serialized Record<string, string> (hoster → container URL).
 * JDownloader can resolve the actual download links from the container URL.
 */
export function selectCryptedLink(
  cryptedLinksJson: string | undefined,
  hosterPriority: string[],
): { url: string; hoster: string } | null {
  if (!cryptedLinksJson) return null;

  let links: Record<string, string>;
  try {
    links = JSON.parse(cryptedLinksJson);
  } catch {
    return null;
  }

  if (!links || typeof links !== 'object' || Object.keys(links).length === 0) return null;

  // Try hosters in priority order
  for (const hoster of hosterPriority) {
    const normalized = hoster.trim().toLowerCase();
    const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
    if (matchingKey && links[matchingKey]) {
      return { url: links[matchingKey], hoster: matchingKey };
    }
  }

  // Fallback: use first available hoster
  for (const [hoster, url] of Object.entries(links)) {
    if (url) return { url, hoster };
  }

  return null;
}

/**
 * Select direct hoster links from a match record based on hoster priority.
 * Links is a JSON-serialized Record<string, string[]> (hoster → array of direct part URLs).
 */
export function selectDirectLinks(
  linksJson: string | undefined,
  hosterPriority: string[],
): { urls: string[]; hoster: string } | null {
  if (!linksJson) return null;

  let links: Record<string, unknown>;
  try {
    links = JSON.parse(linksJson);
  } catch {
    return null;
  }

  if (!links || typeof links !== 'object' || Object.keys(links).length === 0) return null;

  const extractValidUrls = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  };

  // Try hosters in priority order
  for (const hoster of hosterPriority) {
    const normalized = hoster.trim().toLowerCase();
    const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
    if (matchingKey) {
      const urls = extractValidUrls(links[matchingKey]);
      if (urls.length > 0) return { urls, hoster: matchingKey };
    }
  }

  // Fallback: use first available hoster with valid URLs
  for (const [hoster, val] of Object.entries(links)) {
    const urls = extractValidUrls(val);
    if (urls.length > 0) return { urls, hoster };
  }

  return null;
}

function parseCryptedLinksMap(cryptedLinksJson: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!cryptedLinksJson) return result;

  let links: unknown;
  try {
    links = JSON.parse(cryptedLinksJson);
  } catch {
    return result;
  }

  if (!links || typeof links !== 'object') return result;

  for (const [hoster, url] of Object.entries(links as Record<string, unknown>)) {
    if (typeof url === 'string' && url.trim().length > 0) {
      result.set(hoster, url.trim());
    }
  }
  return result;
}

function parseDirectLinksMap(linksJson: string | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!linksJson) return result;

  let links: unknown;
  try {
    links = JSON.parse(linksJson);
  } catch {
    return result;
  }

  if (!links || typeof links !== 'object') return result;

  for (const [hoster, val] of Object.entries(links as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const urls = val
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim());
    if (urls.length > 0) {
      result.set(hoster, urls);
    }
  }
  return result;
}

/**
 * Build an ordered list of download candidates to try when pushing a match to JDownloader:
 * - For movies and individual episode releases: for each hoster in priority order, try direct
 *   hoster URLs from `Links` first (avoids container redirectors like filecrypt.cc that may
 *   trigger Cloudflare blocks), followed by that hoster's `CryptedLinks` container (which stays
 *   up-to-date when uploaders re-upload deleted parts into the same container without warez.cx
 *   refreshing its cached `Links` array).
 * - For series season packs: always prefer `CryptedLinks` across all hosters first, because
 *   warez.cx's direct `Links` array only contains Episode 1's parts while the container holds
 *   the full season.
 */
export function buildPushCandidates(
  match: Pick<MatchRow, 'Type' | 'Fulltitle' | 'Links' | 'CryptedLinks'>,
  hosterPriority: string[],
): PushCandidate[] {
  const isSeasonPack = match.Type === 'series'
    && Boolean(match.Fulltitle)
    && isSeasonPackFulltitle(match.Fulltitle);

  const directMap = parseDirectLinksMap(match.Links);
  const cryptedMap = parseCryptedLinksMap(match.CryptedLinks);

  const usedDirect = new Set<string>();
  const usedCrypted = new Set<string>();
  const candidates: PushCandidate[] = [];

  if (isSeasonPack) {
    for (const priority of hosterPriority) {
      const normalized = priority.trim().toLowerCase();
      if (!normalized) continue;
      for (const [hoster, url] of cryptedMap) {
        if (!usedCrypted.has(hoster) && hoster.toLowerCase().includes(normalized)) {
          usedCrypted.add(hoster);
          candidates.push({ urls: [url], hoster, source: 'crypted' });
        }
      }
    }
    for (const [hoster, url] of cryptedMap) {
      if (!usedCrypted.has(hoster)) {
        usedCrypted.add(hoster);
        candidates.push({ urls: [url], hoster, source: 'crypted' });
      }
    }
    for (const priority of hosterPriority) {
      const normalized = priority.trim().toLowerCase();
      if (!normalized) continue;
      for (const [hoster, urls] of directMap) {
        if (!usedDirect.has(hoster) && hoster.toLowerCase().includes(normalized)) {
          usedDirect.add(hoster);
          candidates.push({ urls, hoster, source: 'direct' });
        }
      }
    }
    for (const [hoster, urls] of directMap) {
      if (!usedDirect.has(hoster)) {
        usedDirect.add(hoster);
        candidates.push({ urls, hoster, source: 'direct' });
      }
    }
    return candidates;
  }

  for (const priority of hosterPriority) {
    const normalized = priority.trim().toLowerCase();
    if (!normalized) continue;
    for (const [hoster, urls] of directMap) {
      if (!usedDirect.has(hoster) && hoster.toLowerCase().includes(normalized)) {
        usedDirect.add(hoster);
        candidates.push({ urls, hoster, source: 'direct' });
      }
    }
    for (const [hoster, url] of cryptedMap) {
      if (!usedCrypted.has(hoster) && hoster.toLowerCase().includes(normalized)) {
        usedCrypted.add(hoster);
        candidates.push({ urls: [url], hoster, source: 'crypted' });
      }
    }
  }

  const remainingHosters = new Set<string>();
  for (const hoster of directMap.keys()) {
    if (!usedDirect.has(hoster)) remainingHosters.add(hoster);
  }
  for (const hoster of cryptedMap.keys()) {
    if (!usedCrypted.has(hoster)) remainingHosters.add(hoster);
  }
  for (const hoster of remainingHosters) {
    const urls = directMap.get(hoster);
    if (urls && !usedDirect.has(hoster)) {
      usedDirect.add(hoster);
      candidates.push({ urls, hoster, source: 'direct' });
    }
    const cryptedUrl = cryptedMap.get(hoster);
    if (cryptedUrl && !usedCrypted.has(hoster)) {
      usedCrypted.add(hoster);
      candidates.push({ urls: [cryptedUrl], hoster, source: 'crypted' });
    }
  }

  return candidates;
}

/**
 * Select the primary download candidate to push to JDownloader.
 * See `buildPushCandidates` for the full priority and fallback rules.
 */
export function selectPushLinks(
  match: Pick<MatchRow, 'Type' | 'Fulltitle' | 'Links' | 'CryptedLinks'>,
  hosterPriority: string[],
): PushCandidate | null {
  return buildPushCandidates(match, hosterPriority)[0] ?? null;
}

/**
 * Determine whether a match requires linkgrabber episode filtering and return the target range.
 *
 * Filtering is ONLY needed when:
 * 1. The match is a series season pack (container holds all episodes, not a single episode release)
 * 2. We have a target episode range starting AFTER episode 1 (fromEpisode > 1), meaning earlier
 *    episodes were already downloaded and should be stripped from the linkgrabber.
 *
 * Movies, individual episode uploads, and first-time season packs starting at E01 push directly.
 */
export function getEpisodeFilterRange(match: MatchRow): EpisodeRange | null {
  if (match.Type !== 'series') return null;
  if (match.Fulltitle && !isSeasonPackFulltitle(match.Fulltitle)) return null;

  const range = parseEpisodeRange(match.SeasonEpisodeKey, match.Season, match.Episode);
  if (!range) return null;
  if (range.fromEpisode <= 1) return null;

  return range;
}

function normalizeForPrefix(value: string): string {
  return value.toLowerCase().replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

function matchesPushedUrl(linkUrl: string, normalizedPushedUrls: string[]): boolean {
  if (!linkUrl) return false;
  const normalized = normalizeUrl(linkUrl);
  for (const pushed of normalizedPushedUrls) {
    if (normalized === pushed || normalized.startsWith(`${pushed}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Identify newly crawled links in JDownloader's linkgrabber that belong to this push.
 *
 * Primary strategy:
 * - Match new links (not in `existingLinkUuids`) whose URL matches one of `pushedUrls` (for direct pushes,
 *   even when JDownloader places offline links into an "Offline Files" package with hash filenames)
 * - Match new links whose package `saveTo` contains `metadataPath` or whose package `name` matches `packageName`
 * Fallback strategy: match new links whose normalized filename starts with the normalized
 * first two tokens of `packageName`.
 */
export function findPushedLinks(
  allLinks: CrawledLink[],
  packages: CrawledPackage[],
  existingLinkUuids: Set<number>,
  metadataPath: string,
  packageName: string,
  pushedUrls?: string[],
): { links: CrawledLink[]; packageByUuid: Map<string, CrawledPackage> } {
  const packageByUuid = new Map<string, CrawledPackage>();
  for (const pkg of packages) {
    packageByUuid.set(String(pkg.uuid), pkg);
  }

  const newLinks = allLinks.filter(l => !existingLinkUuids.has(l.uuid));
  if (newLinks.length === 0) {
    return { links: [], packageByUuid };
  }

  const matchedByUuid = new Map<number, CrawledLink>();

  if (pushedUrls && pushedUrls.length > 0) {
    const normalizedPushed = pushedUrls.map(normalizeUrl).filter(Boolean);
    if (normalizedPushed.length > 0) {
      for (const link of newLinks) {
        if (matchesPushedUrl(link.url, normalizedPushed)) {
          matchedByUuid.set(link.uuid, link);
        }
      }
    }
  }

  const metadataLower = metadataPath.toLowerCase();
  const packageNameLower = packageName.toLowerCase();

  // Primary: match by package saveTo (contains our unique metadata path) or exact package name
  const matchedPackageUuids = new Set<string>();
  for (const pkg of packages) {
    const saveToLower = pkg.saveTo.toLowerCase();
    const nameLower = pkg.name.toLowerCase();
    if (
      (metadataLower && saveToLower.includes(metadataLower)) ||
      (packageNameLower && nameLower === packageNameLower)
    ) {
      matchedPackageUuids.add(String(pkg.uuid));
    }
  }

  if (matchedPackageUuids.size > 0) {
    for (const link of newLinks) {
      if (matchedPackageUuids.has(link.packageUUID)) {
        matchedByUuid.set(link.uuid, link);
      }
    }
  }

  if (matchedByUuid.size > 0) {
    return { links: [...matchedByUuid.values()], packageByUuid };
  }

  // Fallback: match by normalized release prefix (handles dots/underscores/spaces variations)
  const prefixTokens = normalizeForPrefix(packageName).split(' ').slice(0, 2).join(' ');
  if (!prefixTokens) {
    return { links: newLinks, packageByUuid };
  }

  const byPrefix = newLinks.filter(l => normalizeForPrefix(l.name).startsWith(prefixTokens));
  return { links: byPrefix, packageByUuid };
}

/**
 * Partition pushed links into links to keep (matching target episodes) and links to remove.
 * Checks `link.name` first; if the filename has no episode marker at all, falls back to its package name.
 */
export function partitionLinksByEpisodes(
  packageLinks: CrawledLink[],
  packageByUuid: Map<string, CrawledPackage>,
  episodePattern: RegExp,
): { keepLinks: CrawledLink[]; removeLinkIds: number[] } {
  const keepLinks: CrawledLink[] = [];
  const removeLinkIds: number[] = [];

  for (const link of packageLinks) {
    if (episodePattern.test(link.name)) {
      keepLinks.push(link);
      continue;
    }

    // If the link filename itself has no SxxExx marker, fall back to its package name
    if (!GENERIC_EPISODE_MARKER.test(link.name)) {
      const pkg = packageByUuid.get(link.packageUUID);
      if (pkg && episodePattern.test(pkg.name)) {
        keepLinks.push(link);
        continue;
      }
    }

    removeLinkIds.push(link.uuid);
  }

  return { keepLinks, removeLinkIds };
}

interface WaitForResolvedLinksOptions {
  pushedUrls?: string[];
  waitForAvailability?: boolean;
  /** Stop waiting early after this many consecutive idle polls with 0 crawled links */
  maxEmptyIdlePolls?: number;
}

/**
 * Poll JDownloader's linkgrabber until the pushed links finish crawling AND
 * the set of resolved link UUIDs (and availability, when requested) remains stable
 * across consecutive polls.
 *
 * Waiting for `!isCollecting()` + stability prevents the race condition where only
 * the first part(s) of a multi-part archive have been crawled or online-checked when we act.
 */
async function waitForResolvedLinks(
  jdownloader: JDownloaderClient,
  existingLinkUuids: Set<number>,
  metadataPath: string,
  packageName: string,
  opts: Required<PushOptions>,
  extra: WaitForResolvedLinksOptions = {},
): Promise<{
  resolved: boolean;
  packageLinks: CrawledLink[];
  packageByUuid: Map<string, CrawledPackage>;
}> {
  let lastSignature = '';
  let stableCount = 0;
  let emptyIdlePolls = 0;
  let isCollectingSupported = true;
  let lastLinks: CrawledLink[] = [];
  let lastPackageByUuid = new Map<string, CrawledPackage>();

  await opts.sleepFn(opts.pollDelayMs);

  for (let attempt = 0; attempt < opts.maxPollAttempts; attempt++) {
    let collecting = false;
    if (isCollectingSupported) {
      try {
        collecting = await jdownloader.isCollecting();
      } catch (err) {
        isCollectingSupported = false;
        console.warn(
          `  ⚠ isCollecting() unavailable, falling back to link-count stability check:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    let packages: CrawledPackage[] = [];
    try {
      packages = await jdownloader.queryPackages();
    } catch {
      // Fallback to URL/filename-prefix matching if queryPackages is unavailable
    }

    const allLinks = await jdownloader.queryLinks();
    const { links: packageLinks, packageByUuid } = findPushedLinks(
      allLinks,
      packages,
      existingLinkUuids,
      metadataPath,
      packageName,
      extra.pushedUrls,
    );

    lastLinks = packageLinks;
    lastPackageByUuid = packageByUuid;

    if (packageLinks.length === 0) {
      stableCount = 0;
      lastSignature = '';
      if (!collecting && extra.maxEmptyIdlePolls !== undefined) {
        emptyIdlePolls++;
        if (emptyIdlePolls >= extra.maxEmptyIdlePolls) {
          return { resolved: true, packageLinks: [], packageByUuid };
        }
      } else {
        emptyIdlePolls = 0;
      }
      console.log(`  ⏳ No links resolved yet (attempt ${attempt + 1}/${opts.maxPollAttempts})`);
      await opts.sleepFn(opts.pollDelayMs);
      continue;
    }

    emptyIdlePolls = 0;

    const signature = extra.waitForAvailability
      ? packageLinks
          .map(l => `${l.uuid}:${(l.availability ?? '').toUpperCase()}`)
          .sort()
          .join(',')
      : packageLinks
          .map(l => l.uuid)
          .sort((a, b) => a - b)
          .join(',');

    if (collecting) {
      // JDownloader is still crawling/checking links — do not finalize partial results!
      stableCount = 0;
      lastSignature = signature;
      console.log(`  ⏳ Still collecting links (${packageLinks.length} found so far, attempt ${attempt + 1}/${opts.maxPollAttempts})`);
      await opts.sleepFn(opts.pollDelayMs);
      continue;
    }

    const baseRequiredStablePolls = isCollectingSupported
      ? opts.stablePollsRequired
      : opts.stablePollsRequired + 1;

    // If JDownloader still reports any link as UNKNOWN, require extra stable polls so
    // the online-status check can finish without hanging on hosters that stay UNKNOWN.
    const hasPendingAvailability = Boolean(extra.waitForAvailability)
      && packageLinks.some(l => l.availability?.toUpperCase() === 'UNKNOWN');
    const requiredStablePolls = hasPendingAvailability
      ? baseRequiredStablePolls + 2
      : baseRequiredStablePolls;

    if (signature === lastSignature) {
      stableCount++;
    } else {
      lastSignature = signature;
      stableCount = 1;
    }

    if (stableCount >= requiredStablePolls) {
      return { resolved: true, packageLinks, packageByUuid };
    }

    console.log(
      `  ⏳ Waiting for links to stabilize (${packageLinks.length} found, stable ${stableCount}/${requiredStablePolls})`,
    );
    await opts.sleepFn(opts.pollDelayMs);
  }

  return { resolved: false, packageLinks: lastLinks, packageByUuid: lastPackageByUuid };
}

/**
 * Push scraper: sends `matched` records to JDownloader and transitions them to `pushed`.
 *
 * For movies and individual episodes with both direct `Links` and a fallback candidate
 * (typically the hoster's `CryptedLinks` container):
 * 1. Pushes direct hoster links to linkgrabber without autostart
 * 2. Waits for JDownloader's online-status check to settle
 * 3. If any direct link is OFFLINE (stale warez.cx `Links` after a container re-upload),
 *    removes the dead links from linkgrabber and automatically falls back to the next candidate
 * 4. Otherwise moves the verified links to the download list (when autostart is enabled)
 *
 * For series season packs that only need newly released episodes (fromEpisode > 1), it:
 * 1. Snapshots existing linkgrabber UUIDs
 * 2. Pushes the crypted container to the linkgrabber WITHOUT autostart
 * 3. Waits until JDownloader finishes collecting (`!isCollecting`) AND resolved links stabilize
 * 4. Removes links that don't match ANY target episode in the new episode range
 * 5. Moves ALL parts of the target episode(s) to the download list
 */
export async function runPushScraper(
  jdownloader: JDownloaderClient,
  nocodb: NocoDbClient,
  config: Config,
  options: PushOptions = {},
): Promise<void> {
  const opts: Required<PushOptions> = {
    pollDelayMs: options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    maxPollAttempts: options.maxPollAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS,
    stablePollsRequired: options.stablePollsRequired ?? DEFAULT_STABLE_POLLS_REQUIRED,
    maxEmptyIdlePolls: options.maxEmptyIdlePolls ?? DEFAULT_MAX_EMPTY_IDLE_POLLS,
    sleepFn: options.sleepFn ?? sleep,
  };

  console.log('▶ Push scraper starting...');

  const matched = await nocodb.getMatchesByStatus('matched');
  console.log(`  Found ${matched.length} matched record(s) to push`);

  if (matched.length === 0) {
    console.log('  Nothing to push.');
    return;
  }

  const hosterPriority = config.JDOWNLOADER_HOSTER_PRIORITY.split(',').map(h => h.trim());

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const match of matched) {
    const candidates = buildPushCandidates(match, hosterPriority);

    if (candidates.length === 0) {
      console.log(`  ⚠ No downloadable links found for "${match.Fulltitle}" — skipping`);
      skipped++;
      continue;
    }

    const packageName = match.Fulltitle || match.Title;
    const metadataPath = buildMetadataPath(match);
    const filterRange = getEpisodeFilterRange(match);

    try {
      let pushSucceeded = false;

      if (filterRange) {
        const selected = candidates[0]!;
        // Snapshot existing links so we only inspect/modify links from this container push
        const existingLinks = await jdownloader.queryLinks();
        const existingLinkUuids = new Set(existingLinks.map(l => l.uuid));

        // Season pack with specific new episode(s): push without autostart, wait for full resolution, then filter
        await jdownloader.pushLinks({
          links: selected.urls,
          packageName,
          autostart: false,
          destinationFolder: metadataPath,
        });

        const rangeLabel = formatSeasonEpisodeKey(
          filterRange.season,
          filterRange.fromEpisode,
          filterRange.toEpisode,
        );
        console.log(`  📦 Container sent for ${rangeLabel}, waiting for full link resolution...`);

        const { resolved, packageLinks, packageByUuid } = await waitForResolvedLinks(
          jdownloader,
          existingLinkUuids,
          metadataPath,
          packageName,
          opts,
        );

        if (resolved) {
          const episodePattern = buildEpisodesPattern(filterRange.season, filterRange.episodes);
          const { keepLinks, removeLinkIds } = partitionLinksByEpisodes(
            packageLinks,
            packageByUuid,
            episodePattern,
          );

          if (keepLinks.length === 0) {
            console.log(`  ⚠ No links match episode pattern ${episodePattern} — keeping all ${packageLinks.length} link(s)`);
            if (config.JDOWNLOADER_AUTOSTART) {
              await jdownloader.moveToDownloadList(packageLinks.map(l => l.uuid));
              await jdownloader.startDownloads();
              console.log(`  🚀 Moved ${packageLinks.length} link(s) to download list and started downloads`);
            } else {
              console.log(`  ⏸️ JDOWNLOADER_AUTOSTART is false — left ${packageLinks.length} link(s) in linkgrabber`);
            }
          } else {
            if (removeLinkIds.length > 0) {
              await jdownloader.removeLinks(removeLinkIds);
              console.log(`  🗑️ Removed ${removeLinkIds.length} link(s) (old episodes)`);
            }
            if (config.JDOWNLOADER_AUTOSTART) {
              await jdownloader.moveToDownloadList(keepLinks.map(l => l.uuid));
              await jdownloader.startDownloads();
              console.log(`  🚀 Moved ${keepLinks.length} link(s) to download list and started downloads`);
            } else {
              console.log(`  ⏸️ JDOWNLOADER_AUTOSTART is false — left ${keepLinks.length} link(s) in linkgrabber`);
            }
            console.log(
              `  ✅ Pushed: "${packageName}" ${rangeLabel} (${keepLinks.length} file(s), filtered from ${packageLinks.length})`,
            );
          }
        } else {
          console.log(
            `  ⚠ Link resolution timed out for "${packageName}" (${packageLinks.length} link(s) seen) — container left in linkgrabber`,
          );
        }
        pushSucceeded = true;
      } else {
        // Movies, individual episode uploads, or first-time season packs (starting at E01)
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          const hasFallback = i < candidates.length - 1;
          const isFallback = i > 0;

          if (candidate.source === 'direct' && (hasFallback || isFallback)) {
            // Verify direct links via JDownloader's linkgrabber before starting so stale warez.cx
            // direct links are cleaned up and automatically fall back to the container/next hoster.
            const existingLinks = await jdownloader.queryLinks();
            const existingLinkUuids = new Set(existingLinks.map(l => l.uuid));

            await jdownloader.pushLinks({
              links: candidate.urls,
              packageName,
              autostart: false,
              destinationFolder: metadataPath,
            });
            console.log(
              `  🔍 Verifying ${candidate.urls.length} direct link(s) via ${candidate.hoster} in linkgrabber...`,
            );

            const { resolved, packageLinks } = await waitForResolvedLinks(
              jdownloader,
              existingLinkUuids,
              metadataPath,
              packageName,
              opts,
              {
                pushedUrls: candidate.urls,
                waitForAvailability: true,
                maxEmptyIdlePolls: opts.maxEmptyIdlePolls,
              },
            );

            const offlineLinks = packageLinks.filter(
              l => l.availability?.toUpperCase() === 'OFFLINE',
            );

            if (offlineLinks.length > 0) {
              await jdownloader.removeLinks(packageLinks.map(l => l.uuid));
              console.log(
                `  ⚠ Direct links via ${candidate.hoster} have ${offlineLinks.length}/${packageLinks.length} offline part(s) — removed from linkgrabber${hasFallback ? ', trying fallback' : ''}`,
              );
              continue;
            }

            if (packageLinks.length === 0) {
              console.log(
                `  ⚠ Direct links via ${candidate.hoster} yielded 0 link(s) in linkgrabber${hasFallback ? ' — trying fallback' : ''}`,
              );
              continue;
            }

            if (resolved) {
              if (config.JDOWNLOADER_AUTOSTART) {
                await jdownloader.moveToDownloadList(packageLinks.map(l => l.uuid));
                await jdownloader.startDownloads();
                console.log(`  🚀 Moved ${packageLinks.length} link(s) to download list and started downloads`);
              } else {
                console.log(`  ⏸️ JDOWNLOADER_AUTOSTART is false — left ${packageLinks.length} link(s) in linkgrabber`);
              }
              const prefix = isFallback ? 'Pushed (fallback)' : 'Pushed';
              console.log(
                `  ✅ ${prefix}: "${packageName}" (${packageLinks.length} verified direct link(s) via ${candidate.hoster})`,
              );
            } else {
              console.log(
                `  ⚠ Direct link verification timed out for "${packageName}" (${packageLinks.length} link(s) seen) — left in linkgrabber`,
              );
            }

            pushSucceeded = true;
            break;
          }

          await jdownloader.pushLinks({
            links: candidate.urls,
            packageName,
            autostart: config.JDOWNLOADER_AUTOSTART,
            destinationFolder: metadataPath,
          });
          const prefix = isFallback ? 'Pushed (fallback)' : 'Pushed';
          const viaLabel = candidate.source === 'direct'
            ? `${candidate.urls.length} direct link(s) via ${candidate.hoster}`
            : `container via ${candidate.hoster}`;
          console.log(`  ✅ ${prefix}: "${packageName}" (${viaLabel})`);
          pushSucceeded = true;
          break;
        }
      }

      if (pushSucceeded) {
        await nocodb.updateMatchRelease(match.Id, {
          Status: 'pushed',
        });
        pushed++;
      } else {
        failed++;
        console.warn(`  ⛔ All download candidates offline for "${packageName}" — not marking as pushed`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, err instanceof Error ? err.message : err);
    }

    await opts.sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);
}
