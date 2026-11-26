import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { CrawledLink, CrawledPackage, JDownloaderClient } from '../jdownloader/client';
import type { WarezClient } from '../warez/api';
import type { WarezDetailRelease } from '../warez/types';
import type { NtfyClient } from '../ntfy/client';
import { formatErrorMessage, safeNotifyError } from '../ntfy/client';
import type { Config } from '../config';
import {
  buildEpisodesPattern,
  extractEpisode,
  extractSeason,
  formatSeasonEpisodeKey,
  isSeasonPackFulltitle,
  parseEpisodeRange,
  type EpisodeRange,
} from '../matcher';
import { sortReleasesByPreference } from '../release-profile';
import { getOnlineHosters, isHosterOnline, releaseMatchesFilters } from './enrich';
import { sleep } from '../utils';

/** Default delay in ms between polls for JDownloader to resolve container links */
const DEFAULT_POLL_DELAY_MS = 1500;
/** Default max attempts to poll linkgrabber (~60s at 1.5s interval) */
const DEFAULT_POLL_MAX_ATTEMPTS = 40;
/** Consecutive polls with unchanged link UUIDs (while not collecting) required before acting */
const DEFAULT_STABLE_POLLS_REQUIRED = 2;
/** Consecutive idle polls with 0 crawled links before concluding JDownloader discarded them */
const DEFAULT_MAX_EMPTY_IDLE_POLLS = 5;

const GENERIC_EPISODE_MARKER = /S\d{2}[._-]?E\d{1,3}(?!\d)/i;
const CLOUDFLARE_CONTAINER_PATTERN = /^https?:\/\/(?:www\.)?filecrypt\.(?:cc|co)\b/i;
const CLOUDFLARE_BLOCK_PATTERN = /cloudflare|site-protection|blocked by/i;

export interface PushOptions {
  pollDelayMs?: number;
  maxPollAttempts?: number;
  stablePollsRequired?: number;
  maxEmptyIdlePolls?: number;
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional warez.cx client — enables falling back to alternate online releases when the matched release fails */
  warez?: WarezClient;
  /** Optional ntfy client — sends a rich manual-download notification when all automated candidates fail */
  ntfy?: NtfyClient;
  /** Override hoster online check for alternate release fallback (for tests) */
  isHosterOnlineFn?: (stateUrl: string) => Promise<boolean>;
}

interface PollOptions {
  pollDelayMs: number;
  maxPollAttempts: number;
  stablePollsRequired: number;
  maxEmptyIdlePolls: number;
  sleepFn: (ms: number) => Promise<void>;
}

export interface PushCandidate {
  urls: string[];
  hoster: string;
  source: 'direct' | 'crypted';
}

export function isCloudflareContainerUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  return CLOUDFLARE_CONTAINER_PATTERN.test(url.trim());
}

export function isCloudflareBlockedLink(link: CrawledLink): boolean {
  return (
    CLOUDFLARE_BLOCK_PATTERN.test(link.name ?? '') ||
    CLOUDFLARE_BLOCK_PATTERN.test(link.status ?? '')
  );
}

/**
 * Determine whether a link crawled in JDownloader's linkgrabber is offline,
 * Cloudflare-blocked, or an undecrypted filecrypt container URL.
 */
export function isBrokenPushLink(link: CrawledLink, source: 'direct' | 'crypted'): boolean {
  if (link.availability?.toUpperCase() === 'OFFLINE') return true;
  if (isCloudflareBlockedLink(link)) return true;
  if (source === 'crypted' && isCloudflareContainerUrl(link.url)) return true;
  return false;
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

function orderEntriesByPriority<T>(
  map: Map<string, T>,
  hosterPriority: string[],
): [string, T][] {
  const ordered: [string, T][] = [];
  const used = new Set<string>();

  for (const priority of hosterPriority) {
    const normalized = priority.trim().toLowerCase();
    if (!normalized) continue;
    for (const [hoster, val] of map) {
      if (!used.has(hoster) && hoster.toLowerCase().includes(normalized)) {
        used.add(hoster);
        ordered.push([hoster, val]);
      }
    }
  }

  for (const [hoster, val] of map) {
    if (!used.has(hoster)) {
      used.add(hoster);
      ordered.push([hoster, val]);
    }
  }

  return ordered;
}

/**
 * Build an ordered list of download candidates to try when pushing a match to JDownloader:
 * - For movies and individual episode releases:
 *   1. All direct hoster `Links` (in hoster priority order) — fastest, avoids container Cloudflare blocks
 *   2. All non-Cloudflare `CryptedLinks` containers (e.g. hide.cx, in hoster priority order)
 *   3. Cloudflare-prone `CryptedLinks` containers (e.g. filecrypt.cc, in hoster priority order)
 * - For series season packs:
 *   1. Non-Cloudflare `CryptedLinks` containers (e.g. hide.cx)
 *   2. Cloudflare-prone `CryptedLinks` containers (e.g. filecrypt.cc)
 *   3. Direct `Links` only as a last-resort fallback (warez.cx's direct array only has Episode 1)
 */
export function buildPushCandidates(
  match: Pick<MatchRow, 'Type' | 'Fulltitle' | 'Links' | 'CryptedLinks'>,
  hosterPriority: string[],
): PushCandidate[] {
  const isSeasonPack = match.Type === 'series'
    && Boolean(match.Fulltitle)
    && isSeasonPackFulltitle(match.Fulltitle);

  const directEntries = orderEntriesByPriority(parseDirectLinksMap(match.Links), hosterPriority);
  const cryptedEntries = orderEntriesByPriority(parseCryptedLinksMap(match.CryptedLinks), hosterPriority);

  const nonCloudflareCrypted: PushCandidate[] = [];
  const cloudflareCrypted: PushCandidate[] = [];
  for (const [hoster, url] of cryptedEntries) {
    const candidate: PushCandidate = { urls: [url], hoster, source: 'crypted' };
    if (isCloudflareContainerUrl(url)) {
      cloudflareCrypted.push(candidate);
    } else {
      nonCloudflareCrypted.push(candidate);
    }
  }

  const directCandidates: PushCandidate[] = directEntries.map(([hoster, urls]) => ({
    urls,
    hoster,
    source: 'direct',
  }));

  if (isSeasonPack) {
    return [...nonCloudflareCrypted, ...cloudflareCrypted, ...directCandidates];
  }

  return [...directCandidates, ...nonCloudflareCrypted, ...cloudflareCrypted];
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
    const hasCloudflarePushedUrl = pushedUrls.some(isCloudflareContainerUrl);
    if (normalizedPushed.length > 0) {
      for (const link of newLinks) {
        if (
          matchesPushedUrl(link.url, normalizedPushed) ||
          (hasCloudflarePushedUrl && (isCloudflareBlockedLink(link) || isCloudflareContainerUrl(link.url)))
        ) {
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
    const saveToLower = (pkg.saveTo ?? '').toLowerCase();
    const nameLower = (pkg.name ?? '').toLowerCase();
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
  opts: PollOptions,
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

interface CandidatePushAttempt {
  ok: boolean;
  candidate?: PushCandidate;
  reasons: string[];
}

/**
 * Try pushing a prioritized list of candidates for a release to JDownloader.
 * - Verifies direct links (whenever a fallback/alternate-release/notification path exists)
 *   and Cloudflare-prone containers (e.g. filecrypt.cc) inside Linkgrabber before moving to
 *   the download list, removing any offline or Cloudflare-blocked entries automatically.
 * - Non-Cloudflare containers (e.g. hide.cx) push directly with configured autostart.
 */
async function tryPushCandidates(
  candidates: PushCandidate[],
  packageName: string,
  metadataPath: string,
  jdownloader: JDownloaderClient,
  config: Config,
  pollOpts: PollOptions,
  alwaysVerifyDirect: boolean,
): Promise<CandidatePushAttempt> {
  const reasons: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const hasFallback = i < candidates.length - 1;
    const isFallback = i > 0;
    const isCfContainer = candidate.source === 'crypted' && candidate.urls.some(isCloudflareContainerUrl);
    const shouldVerify = isCfContainer
      || (candidate.source === 'direct' && (hasFallback || isFallback || alwaysVerifyDirect));

    if (shouldVerify) {
      const existingLinks = await jdownloader.queryLinks();
      const existingLinkUuids = new Set(existingLinks.map(l => l.uuid));

      await jdownloader.pushLinks({
        links: candidate.urls,
        packageName,
        autostart: false,
        destinationFolder: metadataPath,
      });

      const kindLabel = candidate.source === 'direct'
        ? `${candidate.urls.length} direct link(s)`
        : 'container';
      console.log(`  🔍 Verifying ${kindLabel} via ${candidate.hoster} in linkgrabber...`);

      const { resolved, packageLinks } = await waitForResolvedLinks(
        jdownloader,
        existingLinkUuids,
        metadataPath,
        packageName,
        pollOpts,
        {
          pushedUrls: candidate.urls,
          waitForAvailability: true,
          maxEmptyIdlePolls: pollOpts.maxEmptyIdlePolls,
        },
      );

      const brokenLinks = packageLinks.filter(l => isBrokenPushLink(l, candidate.source));

      if (brokenLinks.length > 0) {
        await jdownloader.removeLinks(packageLinks.map(l => l.uuid));
        const hasCloudflareBlock = brokenLinks.some(isCloudflareBlockedLink)
          || (candidate.source === 'crypted' && brokenLinks.some(l => isCloudflareContainerUrl(l.url)));
        const reason = hasCloudflareBlock
          ? `container blocked by Cloudflare (${candidate.hoster})`
          : `${brokenLinks.length}/${packageLinks.length} offline part(s) (${candidate.hoster})`;
        reasons.push(reason);
        console.log(
          `  ⚠ ${candidate.source === 'direct' ? 'Direct links' : 'Container'} via ${candidate.hoster}: ${reason} — removed from linkgrabber${hasFallback ? ', trying next candidate' : ''}`,
        );
        continue;
      }

      if (packageLinks.length === 0) {
        const reason = `0 links resolved via ${candidate.hoster}`;
        reasons.push(reason);
        console.log(
          `  ⚠ ${candidate.source === 'direct' ? 'Direct links' : 'Container'} via ${candidate.hoster} yielded 0 link(s) in linkgrabber${hasFallback ? ' — trying next candidate' : ''}`,
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
        const verifiedLabel = candidate.source === 'direct'
          ? `${packageLinks.length} verified direct link(s) via ${candidate.hoster}`
          : `${packageLinks.length} verified link(s) from container via ${candidate.hoster}`;
        console.log(`  ✅ ${prefix}: "${packageName}" (${verifiedLabel})`);
      } else {
        console.log(
          `  ⚠ Verification timed out for "${packageName}" (${packageLinks.length} link(s) seen) — left in linkgrabber`,
        );
      }

      return { ok: true, candidate, reasons };
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
    return { ok: true, candidate, reasons };
  }

  return { ok: false, reasons };
}

interface AlternateReleaseResult {
  release: WarezDetailRelease;
  links: Record<string, string[]>;
  cryptedLinks: Record<string, string>;
}

/**
 * When the primary matched release fails all download candidates (e.g. stale direct links +
 * Cloudflare-blocked filecrypt.cc container), fetch other matching releases for the same
 * warez.cx entry and attempt to push them in preference order.
 */
async function tryAlternateWarezReleases(
  match: MatchRow & { Id: number },
  jdownloader: JDownloaderClient,
  nocodb: NocoDbClient,
  warez: WarezClient,
  config: Config,
  hosterPriority: string[],
  metadataPath: string,
  pollOpts: PollOptions,
  checkOnline: (stateUrl: string) => Promise<boolean>,
): Promise<AlternateReleaseResult | null> {
  if (!match.WarezUid || !match.WatchlistId) return null;

  const watchlistItem = await nocodb.getWatchlistItemById(match.WatchlistId);
  if (!watchlistItem) return null;

  let releases: WarezDetailRelease[];
  try {
    const detail = await warez.fetchEntryDetail(match.WarezUid);
    const rawReleases = Array.isArray(detail?.releases) ? detail.releases : [];
    releases = rawReleases.filter(
      (r): r is WarezDetailRelease => Boolean(r && typeof r === 'object'),
    );
  } catch (err) {
    console.warn(
      `  ⚠ Could not fetch alternate warez.cx releases for "${match.Title}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const isSingleEpisode = match.Type === 'series'
    && match.Episode != null
    && (!match.Fulltitle || !isSeasonPackFulltitle(match.Fulltitle));

  const alternates = sortReleasesByPreference(
    releases.filter(r => {
      if (r.id === match.WarezId) return false;
      if (!releaseMatchesFilters(r, watchlistItem)) return false;
      if (isSingleEpisode) {
        if (isSeasonPackFulltitle(r.fulltitle)) return false;
        const ep = extractEpisode(r.fulltitle);
        if (ep !== match.Episode) return false;
        if (match.Season != null) {
          const season = extractSeason(r.fulltitle);
          if (season !== null && season !== match.Season) return false;
        }
      }
      return true;
    }),
    config.PREFERRED_GROUPS,
  );

  if (alternates.length === 0) return null;

  console.log(`  🔄 Trying ${alternates.length} alternate release(s) on warez.cx for "${match.Title}"...`);

  for (const rel of alternates) {
    const onlineHosters = await getOnlineHosters(rel, checkOnline);
    if (onlineHosters.length === 0) continue;

    const links: Record<string, string[]> = {};
    const cryptedLinks: Record<string, string> = {};
    for (const hoster of onlineHosters) {
      if (rel.links?.[hoster]) links[hoster] = rel.links[hoster];
      if (rel.crypted_links?.[hoster]) cryptedLinks[hoster] = rel.crypted_links[hoster];
    }

    const altCandidates = buildPushCandidates(
      {
        Type: match.Type,
        Fulltitle: rel.fulltitle,
        Links: JSON.stringify(links),
        CryptedLinks: JSON.stringify(cryptedLinks),
      },
      hosterPriority,
    );
    if (altCandidates.length === 0) continue;

    console.log(`  🔁 Trying alternate release: "${rel.fulltitle}"`);
    const attempt = await tryPushCandidates(
      altCandidates,
      rel.fulltitle || match.Title,
      metadataPath,
      jdownloader,
      config,
      pollOpts,
      true,
    );

    if (attempt.ok) {
      return { release: rel, links, cryptedLinks };
    }
  }

  return null;
}

function buildManualNotifyStateKey(matchId: number): string {
  return `manual_notify:${matchId}`;
}

function buildManualNotifyToken(match: Pick<MatchRow, 'WarezId' | 'SeasonEpisodeKey'>): string {
  return `${match.WarezId}:${match.SeasonEpisodeKey ?? ''}`;
}

async function sendManualDownloadFallback(
  match: MatchRow & { Id: number },
  nocodb: NocoDbClient,
  ntfy: NtfyClient | undefined,
  hosterPriority: string[],
  metadataPath: string,
  reasons: string[],
): Promise<void> {
  const uniqueReasons = [...new Set(reasons)];
  const reasonText = uniqueReasons.length > 0
    ? uniqueReasons.join('; ')
    : 'All download candidates failed or were blocked';

  console.warn(`  ⛔ Manual download needed for "${match.Fulltitle || match.Title}": ${reasonText}`);

  if (!ntfy) return;

  const containerUrl = selectCryptedLink(match.CryptedLinks, hosterPriority)?.url;
  try {
    await ntfy.notifyManualDownload(match, {
      reason: reasonText,
      metadataPath,
      containerUrl,
    });
    console.log(`  🔔 Sent ntfy manual-download notification for "${match.Title || match.Fulltitle}"`);

    if (typeof nocodb.setState === 'function') {
      await nocodb
        .setState(buildManualNotifyStateKey(match.Id), buildManualNotifyToken(match))
        .catch(() => {});
    }
  } catch (err) {
    console.warn(
      `  ⚠ Failed to send ntfy notification for "${match.Title || match.Fulltitle}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Push scraper: sends `matched` records to JDownloader and transitions them to `pushed`.
 *
 * For movies and individual episodes:
 * 1. Tries direct `Links` first, then non-Cloudflare containers (e.g. hide.cx), then filecrypt.cc containers
 * 2. Verifies direct links and filecrypt.cc containers in Linkgrabber before moving to the download list,
 *    automatically removing offline or Cloudflare-blocked links
 * 3. If all candidates for the matched release fail and `warez` is provided, tries alternate matching
 *    online releases on warez.cx in preference order
 * 4. Super fallback: if all automated attempts fail and `ntfy` is configured, sends a rich ntfy
 *    notification with a deeplink to warez.cx (deduplicated via `scraper_state`)
 *
 * For series season packs that only need newly released episodes (fromEpisode > 1), it:
 * 1. Snapshots existing linkgrabber UUIDs
 * 2. Pushes the crypted container to the linkgrabber WITHOUT autostart
 * 3. Waits until JDownloader finishes collecting (`!isCollecting`) AND resolved links stabilize
 * 4. Removes links that don't match ANY target episode in the new episode range (or notifies on Cloudflare block)
 * 5. Moves ALL parts of the target episode(s) to the download list
 */
export async function runPushScraper(
  jdownloader: JDownloaderClient,
  nocodb: NocoDbClient,
  config: Config,
  options: PushOptions = {},
): Promise<void> {
  const pollOpts: PollOptions = {
    pollDelayMs: options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    maxPollAttempts: options.maxPollAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS,
    stablePollsRequired: options.stablePollsRequired ?? DEFAULT_STABLE_POLLS_REQUIRED,
    maxEmptyIdlePolls: options.maxEmptyIdlePolls ?? DEFAULT_MAX_EMPTY_IDLE_POLLS,
    sleepFn: options.sleepFn ?? sleep,
  };
  const checkOnline = options.isHosterOnlineFn ?? isHosterOnline;

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
  const unexpectedErrors: { label: string; uid?: string; title?: string; message: string }[] = [];

  for (const match of matched) {
    const packageName = match.Fulltitle || match.Title || `Match #${match.Id}`;

    try {
      // Avoid re-attempting and spamming ntfy on subsequent cron runs for matches already handed off manually
      if (options.ntfy && typeof nocodb.getState === 'function') {
        const prevNotified = await nocodb.getState(buildManualNotifyStateKey(match.Id)).catch(() => null);
        if (prevNotified === buildManualNotifyToken(match)) {
          console.log(`  ⏭ Skipping "${packageName}" (already notified for manual download)`);
          skipped++;
          continue;
        }
      }

      const candidates = buildPushCandidates(match, hosterPriority);

      if (candidates.length === 0) {
        console.log(`  ⚠ No downloadable links found for "${match.Fulltitle}" — skipping`);
        skipped++;
        continue;
      }

      const metadataPath = buildMetadataPath(match);
      const filterRange = getEpisodeFilterRange(match);

      let pushSucceeded = false;
      let alternateUpdate: Partial<MatchRow> | null = null;
      const failureReasons: string[] = [];

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
          pollOpts,
          {
            pushedUrls: selected.urls,
            waitForAvailability: selected.urls.some(isCloudflareContainerUrl),
            maxEmptyIdlePolls: selected.urls.some(isCloudflareContainerUrl)
              ? pollOpts.maxEmptyIdlePolls
              : undefined,
          },
        );

        const brokenLinks = packageLinks.filter(l => isBrokenPushLink(l, selected.source));
        const allBroken = packageLinks.length > 0 && brokenLinks.length === packageLinks.length;

        if (allBroken) {
          await jdownloader.removeLinks(packageLinks.map(l => l.uuid));
          const hasCloudflareBlock = brokenLinks.some(isCloudflareBlockedLink)
            || brokenLinks.some(l => isCloudflareContainerUrl(l.url));
          failureReasons.push(
            hasCloudflareBlock
              ? `container blocked by Cloudflare (${selected.hoster})`
              : `all ${brokenLinks.length} crawled link(s) offline (${selected.hoster})`,
          );
        } else if (resolved && packageLinks.length === 0) {
          failureReasons.push(`0 links resolved via ${selected.hoster}`);
        } else if (resolved) {
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
          pushSucceeded = true;
        } else {
          console.log(
            `  ⚠ Link resolution timed out for "${packageName}" (${packageLinks.length} link(s) seen) — container left in linkgrabber`,
          );
          pushSucceeded = true;
        }
      } else {
        // Movies, individual episode uploads, or first-time season packs (starting at E01)
        const alwaysVerifyDirect = Boolean(options.warez || options.ntfy);
        const attempt = await tryPushCandidates(
          candidates,
          packageName,
          metadataPath,
          jdownloader,
          config,
          pollOpts,
          alwaysVerifyDirect,
        );
        failureReasons.push(...attempt.reasons);

        if (attempt.ok) {
          pushSucceeded = true;
        } else if (options.warez) {
          // Primary release failed all candidates — try alternate online releases on warez.cx
          const alt = await tryAlternateWarezReleases(
            match,
            jdownloader,
            nocodb,
            options.warez,
            config,
            hosterPriority,
            metadataPath,
            pollOpts,
            checkOnline,
          );
          if (alt) {
            const cleanLang = Array.isArray(alt.release.lang)
              ? alt.release.lang.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
              : [];
            alternateUpdate = {
              WarezId: alt.release.id,
              Fulltitle: alt.release.fulltitle ?? '',
              Quality: alt.release.quality ?? match.Quality,
              Lang: JSON.stringify(cleanLang),
              Links: JSON.stringify(alt.links),
              CryptedLinks: JSON.stringify(alt.cryptedLinks),
              SizeBytes: alt.release.size ?? 0,
              ReleaseGroup: alt.release.group ?? '',
              WarezCreatedAt: alt.release.created_at ?? '',
            };
            pushSucceeded = true;
          }
        }
      }

      if (pushSucceeded) {
        await nocodb.updateMatchRelease(match.Id, {
          ...(alternateUpdate ?? {}),
          Status: 'pushed',
        });
        pushed++;
      } else {
        failed++;
        await sendManualDownloadFallback(
          match,
          nocodb,
          options.ntfy,
          hosterPriority,
          metadataPath,
          failureReasons,
        );
      }
    } catch (err) {
      const msg = formatErrorMessage(err);
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, msg);
      unexpectedErrors.push({
        label: packageName,
        uid: match.WarezUid,
        title: match.Title,
        message: msg,
      });
    }

    await pollOpts.sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);

  if (unexpectedErrors.length > 0) {
    const single = unexpectedErrors.length === 1 ? unexpectedErrors[0]! : undefined;
    await safeNotifyError(options.ntfy, {
      source: 'push',
      summary: single
        ? `${single.label} failed`
        : `${unexpectedErrors.length} item(s) failed during push`,
      errors: unexpectedErrors.map(e => `${e.label}: ${e.message}`),
      warezUid: single?.uid,
      title: single?.title,
    });
  }
}
