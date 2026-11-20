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

const GENERIC_EPISODE_MARKER = /S\d{2}[._-]?E\d{1,3}(?!\d)/i;

export interface PushOptions {
  pollDelayMs?: number;
  maxPollAttempts?: number;
  stablePollsRequired?: number;
  sleepFn?: (ms: number) => Promise<void>;
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

/**
 * Identify newly crawled links in JDownloader's linkgrabber that belong to this push.
 *
 * Primary strategy: match new links (not in `existingLinkUuids`) whose package `saveTo`
 * contains `metadataPath` or whose package `name` matches `packageName`.
 * Fallback strategy: match new links whose normalized filename starts with the normalized
 * first two tokens of `packageName`.
 */
export function findPushedLinks(
  allLinks: CrawledLink[],
  packages: CrawledPackage[],
  existingLinkUuids: Set<number>,
  metadataPath: string,
  packageName: string,
): { links: CrawledLink[]; packageByUuid: Map<string, CrawledPackage> } {
  const packageByUuid = new Map<string, CrawledPackage>();
  for (const pkg of packages) {
    packageByUuid.set(String(pkg.uuid), pkg);
  }

  const newLinks = allLinks.filter(l => !existingLinkUuids.has(l.uuid));
  if (newLinks.length === 0) {
    return { links: [], packageByUuid };
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
    const byPackage = newLinks.filter(l => matchedPackageUuids.has(l.packageUUID));
    if (byPackage.length > 0) {
      return { links: byPackage, packageByUuid };
    }
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

/**
 * Poll JDownloader's linkgrabber until the pushed container finishes crawling AND
 * the set of resolved link UUIDs remains stable across consecutive polls.
 *
 * Waiting for `!isCollecting()` + stability prevents the race condition where only
 * the first part(s) of a multi-part episode archive have been crawled when we move links.
 */
async function waitForResolvedLinks(
  jdownloader: JDownloaderClient,
  existingLinkUuids: Set<number>,
  metadataPath: string,
  packageName: string,
  opts: Required<PushOptions>,
): Promise<{
  resolved: boolean;
  packageLinks: CrawledLink[];
  packageByUuid: Map<string, CrawledPackage>;
}> {
  let lastSignature = '';
  let stableCount = 0;
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
      // Fallback to filename-prefix matching if queryPackages is unavailable
    }

    const allLinks = await jdownloader.queryLinks();
    const { links: packageLinks, packageByUuid } = findPushedLinks(
      allLinks,
      packages,
      existingLinkUuids,
      metadataPath,
      packageName,
    );

    lastLinks = packageLinks;
    lastPackageByUuid = packageByUuid;

    if (packageLinks.length === 0) {
      stableCount = 0;
      lastSignature = '';
      console.log(`  ⏳ No links resolved yet (attempt ${attempt + 1}/${opts.maxPollAttempts})`);
      await opts.sleepFn(opts.pollDelayMs);
      continue;
    }

    const signature = packageLinks
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

    const requiredStablePolls = isCollectingSupported
      ? opts.stablePollsRequired
      : opts.stablePollsRequired + 1;

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
    const selected = selectCryptedLink(match.CryptedLinks, hosterPriority);

    if (!selected) {
      console.log(`  ⚠ No crypted links found for "${match.Fulltitle}" — skipping`);
      skipped++;
      continue;
    }

    const packageName = match.Fulltitle || match.Title;
    const metadataPath = buildMetadataPath(match);
    const filterRange = getEpisodeFilterRange(match);

    try {
      if (filterRange) {
        // Snapshot existing links so we only inspect/modify links from this container push
        const existingLinks = await jdownloader.queryLinks();
        const existingLinkUuids = new Set(existingLinks.map(l => l.uuid));

        // Season pack with specific new episode(s): push without autostart, wait for full resolution, then filter
        await jdownloader.pushLinks({
          links: [selected.url],
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
            }
          } else {
            if (removeLinkIds.length > 0) {
              await jdownloader.removeLinks(removeLinkIds);
              console.log(`  🗑️ Removed ${removeLinkIds.length} link(s) (old episodes)`);
            }
            if (config.JDOWNLOADER_AUTOSTART) {
              await jdownloader.moveToDownloadList(keepLinks.map(l => l.uuid));
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
      } else {
        // Movies, individual episode uploads, or first-time season packs (starting at E01): push directly
        await jdownloader.pushLinks({
          links: [selected.url],
          packageName,
          autostart: config.JDOWNLOADER_AUTOSTART,
          destinationFolder: metadataPath,
        });
        console.log(`  ✅ Pushed: "${packageName}" (via ${selected.hoster})`);
      }

      await nocodb.updateMatchRelease(match.Id, {
        Status: 'pushed',
      });
      pushed++;
    } catch (err) {
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, err instanceof Error ? err.message : err);
    }

    await opts.sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);
}
