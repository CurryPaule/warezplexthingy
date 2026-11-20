import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezDetailRelease } from '../warez/types';
import type { Config } from '../config';
import {
  matchesQuality,
  meetsLanguage,
  matchesTags,
  extractSeason,
  extractEpisode,
  extractSeasonEpisodeKey,
  isSeasonPackFulltitle,
  formatSeasonEpisodeKey,
  parseEpisodeRange,
} from '../matcher';
import { sleep } from '../utils';

/** Timeout in ms for each hoster online-check request */
const ONLINE_CHECK_TIMEOUT_MS = 5000;

export interface EnrichOptions {
  sleepFn?: (ms: number) => Promise<void>;
  isHosterOnlineFn?: (stateUrl: string) => Promise<boolean>;
}

interface OnlineRelease {
  release: WarezDetailRelease;
  links: Record<string, string[]>;
  cryptedLinks: Record<string, string>;
}

interface MatchEntry {
  match: MatchRow & { Id: number };
  isRecheck: boolean;
}

/**
 * Check if a single hoster's links are online by fetching the hide.cx state SVG.
 * Returns true (online) only when the response contains stroke="green".
 * Any error, timeout, or unparsable response is treated as offline.
 */
export async function isHosterOnline(stateUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ONLINE_CHECK_TIMEOUT_MS);
    const response = await fetch(stateUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes('stroke="green"');
  } catch {
    return false;
  }
}

/**
 * Check if a release has at least one online hoster.
 * Uses the `options.check` URLs that return SVGs with stroke color indicating status.
 * Returns the list of online hoster names, or an empty array if all are offline.
 */
export async function getOnlineHosters(
  release: WarezDetailRelease,
  checkOnline: (stateUrl: string) => Promise<boolean> = isHosterOnline,
): Promise<string[]> {
  const checkUrls = release.options?.check;
  if (!checkUrls || Object.keys(checkUrls).length === 0) {
    // No check info available — assume online (don't block releases without check data)
    return Object.keys(release.links ?? {});
  }

  const results = await Promise.all(
    Object.entries(checkUrls).map(async ([hoster, url]) => ({
      hoster,
      online: await checkOnline(url),
    })),
  );

  return results.filter(r => r.online).map(r => r.hoster);
}

/**
 * Filter a release's links/cryptedLinks to only include online hosters.
 * Returns a new links & cryptedLinks with offline hosters removed.
 */
function filterLinksToOnlineHosters(
  release: WarezDetailRelease,
  onlineHosters: string[],
): { links: Record<string, string[]>; cryptedLinks: Record<string, string> } {
  const links: Record<string, string[]> = {};
  const cryptedLinks: Record<string, string> = {};

  for (const hoster of onlineHosters) {
    if (release.links[hoster]) links[hoster] = release.links[hoster];
    if (release.crypted_links[hoster]) cryptedLinks[hoster] = release.crypted_links[hoster];
  }

  return { links, cryptedLinks };
}

/**
 * Pick the first release from `candidates` that has at least one online hoster.
 */
async function findFirstOnlineRelease(
  candidates: WarezDetailRelease[],
  checkOnline: (stateUrl: string) => Promise<boolean>,
): Promise<OnlineRelease | null> {
  for (const candidate of candidates) {
    const onlineHosters = await getOnlineHosters(candidate, checkOnline);
    if (onlineHosters.length > 0) {
      const { links, cryptedLinks } = filterLinksToOnlineHosters(candidate, onlineHosters);
      return { release: candidate, links, cryptedLinks };
    }
    console.log(`  ⛔ Offline: "${candidate.fulltitle}" (user ${candidate.user_id}) — all hosters down`);
  }
  return null;
}

/**
 * Check if a detail release matches a watchlist item's filters.
 * Applies Quality, Tags, Language, and Season checks.
 */
export function releaseMatchesFilters(
  release: WarezDetailRelease,
  watchlistItem: WatchlistRow,
): boolean {
  if (!matchesQuality(release.quality, watchlistItem.Quality)) return false;
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired, release.fulltitle)) return false;
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) return false;

  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) return false;
  }

  return true;
}

/**
 * Get the episode count from a detail release's options.
 */
export function getEpisodeCount(release: WarezDetailRelease): number | null {
  const epCount = release.options?.episode_count_in_season;
  if (!epCount) return null;
  const count = parseInt(String(epCount), 10);
  return count > 0 ? count : null;
}

function buildReleaseFields(
  online: OnlineRelease,
  season: number | undefined,
  episode: number | undefined,
  seasonEpisodeKey: string | undefined,
): Partial<MatchRow> {
  return {
    WarezId: online.release.id,
    Fulltitle: online.release.fulltitle,
    Quality: online.release.quality ?? '',
    Lang: JSON.stringify(online.release.lang),
    Links: JSON.stringify(online.links),
    CryptedLinks: JSON.stringify(online.cryptedLinks),
    SizeBytes: online.release.size,
    ReleaseGroup: online.release.group,
    Season: season,
    Episode: episode,
    SeasonEpisodeKey: seasonEpisodeKey,
    WarezCreatedAt: online.release.created_at,
    Status: 'matched',
  };
}

function buildNewMatchRecord(
  template: MatchRow,
  watchlistItem: WatchlistRow & { Id: number },
  online: OnlineRelease,
  season: number | undefined,
  episode: number | undefined,
  seasonEpisodeKey: string | undefined,
): Omit<MatchRow, 'Id'> {
  return {
    WatchlistId: watchlistItem.Id,
    WarezId: online.release.id,
    WarezUid: template.WarezUid,
    Title: template.Title,
    Fulltitle: online.release.fulltitle,
    Type: template.Type || watchlistItem.Type || 'series',
    Season: season,
    Episode: episode,
    SeasonEpisodeKey: seasonEpisodeKey,
    Quality: online.release.quality ?? '',
    Lang: JSON.stringify(online.release.lang),
    Links: JSON.stringify(online.links),
    CryptedLinks: JSON.stringify(online.cryptedLinks),
    SizeBytes: online.release.size,
    ReleaseGroup: online.release.group,
    ImdbId: template.ImdbId || watchlistItem.ImdbId || '',
    TmdbId: template.TmdbId || watchlistItem.TmdbId || 0,
    WarezCreatedAt: online.release.created_at,
    MatchedAt: new Date().toISOString(),
    Status: 'matched',
  };
}

/**
 * Process a single movie match against available releases.
 */
async function processMovieMatch(
  match: MatchRow & { Id: number },
  releases: WarezDetailRelease[],
  watchlistItem: WatchlistRow & { Id: number },
  nocodb: NocoDbClient,
  checkOnline: (stateUrl: string) => Promise<boolean>,
): Promise<'enriched' | 'skipped'> {
  const candidateReleases = releases.filter(r => releaseMatchesFilters(r, watchlistItem));

  if (candidateReleases.length === 0) {
    const filters = [
      watchlistItem.Quality ? `Q:${watchlistItem.Quality}` : null,
      watchlistItem.Tags ? `Tags:${watchlistItem.Tags}` : null,
      watchlistItem.LangRequired ? `Lang:${watchlistItem.LangRequired}` : null,
    ].filter(Boolean).join(', ');
    console.log(`  ⏳ No matching release for "${match.Title}" (filters: ${filters || 'none'})`);
    return 'skipped';
  }

  const online = await findFirstOnlineRelease(candidateReleases, checkOnline);
  if (!online) {
    console.log(`  ⛔ All ${candidateReleases.length} matching release(s) for "${match.Title}" are offline`);
    return 'skipped';
  }

  await nocodb.updateMatchRelease(
    match.Id,
    buildReleaseFields(online, undefined, undefined, undefined),
  );
  await nocodb.updateWatchlistLastMatched(watchlistItem.Id, new Date().toISOString());

  if (watchlistItem.DeactivateOnMatch) {
    await nocodb.deactivateWatchlistItem(watchlistItem.Id);
    console.log(`  🔕 Deactivated: "${watchlistItem.Title}" (DeactivateOnMatch)`);
  }

  return 'enriched';
}

/**
 * Process all matches for one series + season bucket against available releases.
 *
 * Handles both:
 * 1. Season packs (`episode_count_in_season`): computes the full newly released episode range
 *    (e.g. `S02E05-E07` when episodes 5..7 dropped since last check at E04), and preserves any
 *    unpushed range start if the match is still in `matched` status.
 * 2. Individual episode uploads (`S02E05`, `S02E06`, `S02E07`): matches ALL episodes higher than
 *    `lastEp` (in ascending order) rather than stopping at the first/highest one.
 */
async function processSeriesBucket(
  entries: MatchEntry[],
  bucketSeason: number | null,
  releases: WarezDetailRelease[],
  watchlistItem: WatchlistRow & { Id: number },
  nocodb: NocoDbClient,
  checkOnline: (stateUrl: string) => Promise<boolean>,
): Promise<{ enriched: number; updated: number; skipped: number }> {
  const foundEntries = entries.filter(e => !e.isRecheck);
  const recheckEntries = entries.filter(e => e.isRecheck);
  const hasRecheck = recheckEntries.length > 0;
  const baseMatch = (foundEntries[0] ?? recheckEntries[0])!.match;

  // Filter releases by watchlist filters and (during re-check) keep within the same season
  const candidateReleases = releases.filter(r => {
    if (!releaseMatchesFilters(r, watchlistItem)) return false;
    if (hasRecheck && bucketSeason != null) {
      const relSeason = extractSeason(r.fulltitle);
      if (relSeason !== null && relSeason !== bucketSeason) return false;
    }
    return true;
  });

  if (candidateReleases.length === 0) {
    if (!hasRecheck) {
      const filters = [
        watchlistItem.Quality ? `Q:${watchlistItem.Quality}` : null,
        watchlistItem.Tags ? `Tags:${watchlistItem.Tags}` : null,
        watchlistItem.LangRequired ? `Lang:${watchlistItem.LangRequired}` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ⏳ No matching release for "${baseMatch.Title}" (filters: ${filters || 'none'})`);
    }
    return { enriched: 0, updated: 0, skipped: 1 };
  }

  // Highest episode already tracked for this bucket
  const lastEp = hasRecheck
    ? Math.max(...recheckEntries.map(e => e.match.Episode ?? 0))
    : (watchlistItem.LastEpisodeFound ?? 0);

  // Split into season packs vs individual episodes
  const seasonPackCandidates = candidateReleases
    .filter(r => isSeasonPackFulltitle(r.fulltitle))
    .filter(r => {
      const count = getEpisodeCount(r);
      if (count != null) return count > lastEp;
      // Season pack without episode_count_in_season: only eligible on initial enrichment with no prior eps
      return !hasRecheck && lastEp === 0;
    })
    // Prefer the season pack with the highest episode count
    .sort((a, b) => (getEpisodeCount(b) ?? 0) - (getEpisodeCount(a) ?? 0));

  // ── 1. Try season packs first ────────────────────────────────────────────────
  if (seasonPackCandidates.length > 0) {
    const online = await findFirstOnlineRelease(seasonPackCandidates, checkOnline);
    if (online) {
      const count = getEpisodeCount(online.release);
      const season = extractSeason(online.release.fulltitle) ?? bucketSeason ?? undefined;

      // Prefer updating an existing season-pack recheck record if present
      const existingPackMatch = recheckEntries.find(e => isSeasonPackFulltitle(e.match.Fulltitle))?.match;

      // If an existing season-pack match is STILL 'matched' (not pushed yet),
      // keep its range start so newly dropped episodes extend the unpushed range instead of dropping old ones.
      let pendingFromEpisode: number | undefined;
      if (existingPackMatch && existingPackMatch.Status === 'matched') {
        const existingRange = parseEpisodeRange(
          existingPackMatch.SeasonEpisodeKey,
          existingPackMatch.Season,
          existingPackMatch.Episode,
        );
        if (existingRange) {
          pendingFromEpisode = existingRange.fromEpisode;
        }
      }

      let episode: number | undefined;
      let seasonEpisodeKey: string | undefined;

      if (count != null) {
        const fromEpisode = pendingFromEpisode ?? (lastEp + 1);
        episode = count;
        seasonEpisodeKey = formatSeasonEpisodeKey(season, fromEpisode, count);
      } else {
        seasonEpisodeKey = extractSeasonEpisodeKey(online.release.fulltitle) ?? undefined;
      }

      if (foundEntries.length > 0) {
        await nocodb.updateMatchRelease(
          foundEntries[0]!.match.Id,
          buildReleaseFields(online, season, episode, seasonEpisodeKey),
        );
      } else if (existingPackMatch) {
        await nocodb.updateMatchRelease(
          existingPackMatch.Id,
          buildReleaseFields(online, season, episode, seasonEpisodeKey),
        );
      } else {
        await nocodb.upsertMatch(
          buildNewMatchRecord(baseMatch, watchlistItem, online, season, episode, seasonEpisodeKey),
        );
      }

      await nocodb.updateWatchlistLastMatched(watchlistItem.Id, new Date().toISOString());
      if (episode != null && episode > (watchlistItem.LastEpisodeFound ?? 0)) {
        await nocodb.updateWatchlistEpisode(watchlistItem.Id, episode);
        watchlistItem.LastEpisodeFound = episode;
      }

      if (foundEntries.length > 0) {
        console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${online.release.fulltitle}" (${seasonEpisodeKey ?? 'pack'})`);
        return { enriched: 1, updated: 0, skipped: 0 };
      } else {
        console.log(`  🆕 New episodes: [${watchlistItem.Title}] — ${seasonEpisodeKey ?? 'pack'} (was E${String(lastEp).padStart(2, '0')})`);
        return { enriched: 0, updated: 1, skipped: 0 };
      }
    }
  }

  // ── 2. Try individual episode releases (> lastEp) ────────────────────────────
  const episodesMap = new Map<number, WarezDetailRelease[]>();
  for (const r of candidateReleases) {
    const ep = extractEpisode(r.fulltitle);
    if (ep != null && ep > lastEp) {
      if (!episodesMap.has(ep)) episodesMap.set(ep, []);
      episodesMap.get(ep)!.push(r);
    }
  }

  const sortedEpNumbers = [...episodesMap.keys()].sort((a, b) => a - b);

  if (sortedEpNumbers.length > 0) {
    let enriched = 0;
    let updated = 0;
    let highestMatched = lastEp;
    let consumedFound = false;

    for (const epNum of sortedEpNumbers) {
      const mirrors = episodesMap.get(epNum)!;
      const online = await findFirstOnlineRelease(mirrors, checkOnline);
      if (!online) continue;

      const season = extractSeason(online.release.fulltitle) ?? bucketSeason ?? undefined;
      const seasonEpisodeKey = formatSeasonEpisodeKey(season, epNum, epNum);

      if (!consumedFound && foundEntries.length > 0) {
        await nocodb.updateMatchRelease(
          foundEntries[0]!.match.Id,
          buildReleaseFields(online, season, epNum, seasonEpisodeKey),
        );
        consumedFound = true;
        enriched++;
        console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${online.release.fulltitle}" (${seasonEpisodeKey})`);
      } else {
        const created = await nocodb.upsertMatch(
          buildNewMatchRecord(baseMatch, watchlistItem, online, season, epNum, seasonEpisodeKey),
        );
        if (created) {
          if (foundEntries.length > 0) {
            enriched++;
          } else {
            updated++;
          }
          console.log(`  🆕 New episode: [${watchlistItem.Title}] ← "${online.release.fulltitle}" (${seasonEpisodeKey})`);
        }
      }

      if (epNum > highestMatched) highestMatched = epNum;
    }

    if (enriched > 0 || updated > 0) {
      await nocodb.updateWatchlistLastMatched(watchlistItem.Id, new Date().toISOString());
      if (highestMatched > (watchlistItem.LastEpisodeFound ?? 0)) {
        await nocodb.updateWatchlistEpisode(watchlistItem.Id, highestMatched);
        watchlistItem.LastEpisodeFound = highestMatched;
      }
      return { enriched, updated, skipped: 0 };
    }
  }

  // Nothing new or all matching candidates offline
  if (!hasRecheck) {
    const hadAnyNewCandidates = seasonPackCandidates.length > 0 || sortedEpNumbers.length > 0;
    if (hadAnyNewCandidates) {
      console.log(`  ⛔ All matching release(s) for "${baseMatch.Title}" are offline`);
    } else {
      console.log(`  ⏩ No new episodes for "${baseMatch.Title}" (last found: E${String(lastEp).padStart(2, '0')})`);
    }
  }
  return { enriched: 0, updated: 0, skipped: 1 };
}

/**
 * Enrichment scraper:
 * 1. Processes "found" matches — applies Quality/Tags/Language filters, promotes to "matched"
 * 2. Re-checks series (matched/pushed/processed) — detects new episodes via episode_count_in_season
 *    or new individual episode uploads
 */
export async function runEnrichScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
  options: EnrichOptions = {},
): Promise<void> {
  const sleepFn = options.sleepFn ?? sleep;
  const checkOnline = options.isHosterOnlineFn ?? isHosterOnline;

  console.log('▶ Enrichment scraper starting...');

  // Phase 1: Enrich "found" matches
  const foundMatches = await nocodb.getMatchesByStatus('found');

  // Phase 2: Re-check series for new episodes (matched, pushed, or processed)
  const recheckSeries = await nocodb.getSeriesMatchesForRecheck();

  const allMatches: MatchEntry[] = [
    ...foundMatches.map(m => ({ match: m, isRecheck: false })),
    ...recheckSeries.map(m => ({ match: m, isRecheck: true })),
  ];

  console.log(`  Found: ${foundMatches.length} to enrich, ${recheckSeries.length} series to re-check`);

  if (allMatches.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  // Group by WarezUid to avoid duplicate API calls
  const byUid = new Map<string, MatchEntry[]>();
  for (const entry of allMatches) {
    const uid = entry.match.WarezUid;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(entry);
  }

  // Pre-load watchlist items
  const watchlistCache = new Map<number, WatchlistRow & { Id: number }>();
  for (const entry of allMatches) {
    const wid = entry.match.WatchlistId;
    if (wid && !watchlistCache.has(wid)) {
      const item = await nocodb.getWatchlistItemById(wid);
      if (item) watchlistCache.set(wid, item);
    }
  }

  let enriched = 0;
  let updated = 0;
  let skipped = 0;

  for (const [uid, entries] of byUid) {
    const label = entries[0]!.isRecheck ? '🔄' : '📦';
    console.log(`  ${label} Fetching detail for: ${entries[0]!.match.Title} (${uid})`);

    let releases: WarezDetailRelease[];
    try {
      const detail = await warez.fetchEntryDetail(uid);
      releases = detail.releases ?? [];
      console.log(`     → ${releases.length} release(s) available`);
    } catch (err) {
      console.error(`  ⚠ Detail fetch failed for "${uid}":`, err);
      await sleepFn(config.SEARCH_DELAY_MS);
      continue;
    }

    // Group entries under this UID by WatchlistId
    const byWatchlist = new Map<number, MatchEntry[]>();
    for (const entry of entries) {
      const wid = entry.match.WatchlistId;
      if (!wid) {
        skipped++;
        continue;
      }
      if (!byWatchlist.has(wid)) byWatchlist.set(wid, []);
      byWatchlist.get(wid)!.push(entry);
    }

    for (const [wid, watchlistEntries] of byWatchlist) {
      const watchlistItem = watchlistCache.get(wid);
      if (!watchlistItem) {
        skipped += watchlistEntries.length;
        continue;
      }

      if (watchlistItem.Type !== 'series') {
        for (const { match } of watchlistEntries) {
          const result = await processMovieMatch(match, releases, watchlistItem, nocodb, checkOnline);
          if (result === 'enriched') {
            enriched++;
            console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${match.Title}"`);
          } else {
            skipped++;
          }
        }
        continue;
      }

      // Series: group by season bucket so multiple episode records for the same season
      // are evaluated together against their highest known episode.
      const bySeason = new Map<number | null, MatchEntry[]>();
      for (const entry of watchlistEntries) {
        const seasonKey = entry.match.Season ?? watchlistItem.Season ?? null;
        if (!bySeason.has(seasonKey)) bySeason.set(seasonKey, []);
        bySeason.get(seasonKey)!.push(entry);
      }

      for (const [bucketSeason, bucketEntries] of bySeason) {
        const res = await processSeriesBucket(
          bucketEntries,
          bucketSeason,
          releases,
          watchlistItem,
          nocodb,
          checkOnline,
        );
        enriched += res.enriched;
        updated += res.updated;
        skipped += res.skipped;
      }
    }

    await sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Enrichment done. Enriched: ${enriched}, Updated: ${updated}, Skipped: ${skipped}`);
}
