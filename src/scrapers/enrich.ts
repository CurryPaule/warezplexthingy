import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezDetailRelease } from '../warez/types';
import type { NtfyClient } from '../ntfy/client';
import { formatErrorMessage, safeNotifyError } from '../ntfy/client';
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
import {
  extractReleaseProfile,
  formatAutoTags,
  hasManualTags,
  hasRelaxableAutoTags,
  isReleaseOlderThanGracePeriod,
  matchesAutoTags,
  sortReleasesByPreference,
} from '../release-profile';
import { sleep } from '../utils';

/** Timeout in ms for each hoster online-check request */
const ONLINE_CHECK_TIMEOUT_MS = 5000;

export interface EnrichOptions {
  sleepFn?: (ms: number) => Promise<void>;
  isHosterOnlineFn?: (stateUrl: string) => Promise<boolean>;
  /** Override current time (for deterministic grace-period testing) */
  now?: Date;
  /** Optional ntfy client — sends an emergency error ping if any item fails during enrichment */
  ntfy?: NtfyClient;
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Inspect an indexed-color PNG's `PLTE` palette chunk (used by filecrypt.cc status icons)
 * to determine if the badge is solid green (online) rather than red/yellow (offline/partial).
 */
export function isPngPaletteGreen(buf: Buffer): boolean {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;

    if (type === 'PLTE') {
      let greenCount = 0;
      let nonGreenSignalCount = 0;

      for (let i = dataStart; i + 2 < dataEnd; i += 3) {
        const r = buf[i]!;
        const g = buf[i + 1]!;
        const b = buf[i + 2]!;

        if (g >= 120 && g > r + 40 && g > b + 40) {
          greenCount++;
        } else if (
          (r >= 120 && r > g + 40) || // red
          (r >= 150 && g >= 100 && b < 80 && r >= g) // yellow / orange (partial)
        ) {
          nonGreenSignalCount++;
        }
      }

      return greenCount > 0 && nonGreenSignalCount === 0;
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip 4-byte CRC
  }

  return false;
}

/**
 * Check if a single hoster's links are online by fetching its status badge:
 * - `hide.cx/state/...` returns an SVG containing `stroke="green"` when online.
 * - `filecrypt.cc/Stat/...png` returns an indexed-color PNG with a green `PLTE` palette when online.
 * Any error, timeout, or unparsable response is treated as offline.
 */
export async function isHosterOnline(stateUrl: string): Promise<boolean> {
  if (typeof stateUrl !== 'string' || !stateUrl.trim()) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ONLINE_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(stateUrl, { signal: controller.signal });
      if (!response.ok) return false;
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return isPngPaletteGreen(buf);
      }
      return buf.toString('utf8').includes('stroke="green"');
    } finally {
      clearTimeout(timer);
    }
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
  if (!checkUrls || typeof checkUrls !== 'object' || Array.isArray(checkUrls) || Object.keys(checkUrls).length === 0) {
    // No check info available — assume online (don't block releases without check data)
    return Object.keys(release.links ?? {});
  }

  const entries = Object.entries(checkUrls).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
  );
  if (entries.length === 0) {
    return Object.keys(release.links ?? {});
  }

  const results = await Promise.all(
    entries.map(async ([hoster, url]) => ({
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
    if (release.links?.[hoster]) links[hoster] = release.links[hoster];
    if (release.crypted_links?.[hoster]) cryptedLinks[hoster] = release.crypted_links[hoster];
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
 * Check if a detail release matches a watchlist item's base filters (Quality, Language, Season)
 * without applying manual Tags or AutoTags.
 */
function releaseMatchesBaseFilters(
  release: WarezDetailRelease,
  watchlistItem: WatchlistRow,
): boolean {
  if (!matchesQuality(release.quality, watchlistItem.Quality)) return false;
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired, release.fulltitle)) return false;

  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) return false;
  }

  return true;
}

/**
 * Check if a detail release matches a watchlist item's filters.
 * Applies Quality, Tags, Language, and Season checks.
 */
export function releaseMatchesFilters(
  release: WarezDetailRelease,
  watchlistItem: WatchlistRow,
): boolean {
  if (!releaseMatchesBaseFilters(release, watchlistItem)) return false;
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) return false;
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

function sanitizeReleaseLangs(lang: WarezDetailRelease['lang']): string[] {
  if (!Array.isArray(lang)) return [];
  return lang.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
}

function buildReleaseFields(
  online: OnlineRelease,
  season: number | undefined,
  episode: number | undefined,
  seasonEpisodeKey: string | undefined,
): Partial<MatchRow> {
  return {
    WarezId: online.release.id,
    Fulltitle: online.release.fulltitle ?? '',
    Quality: online.release.quality ?? '',
    Lang: JSON.stringify(sanitizeReleaseLangs(online.release.lang)),
    Links: JSON.stringify(online.links),
    CryptedLinks: JSON.stringify(online.cryptedLinks),
    SizeBytes: online.release.size ?? 0,
    ReleaseGroup: online.release.group ?? '',
    Season: season,
    Episode: episode,
    SeasonEpisodeKey: seasonEpisodeKey,
    WarezCreatedAt: online.release.created_at ?? '',
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
    Fulltitle: online.release.fulltitle ?? '',
    Type: template.Type || watchlistItem.Type || 'series',
    Season: season,
    Episode: episode,
    SeasonEpisodeKey: seasonEpisodeKey,
    Quality: online.release.quality ?? '',
    Lang: JSON.stringify(sanitizeReleaseLangs(online.release.lang)),
    Links: JSON.stringify(online.links),
    CryptedLinks: JSON.stringify(online.cryptedLinks),
    SizeBytes: online.release.size ?? 0,
    ReleaseGroup: online.release.group ?? '',
    ImdbId: template.ImdbId || watchlistItem.ImdbId || '',
    TmdbId: template.TmdbId || watchlistItem.TmdbId || 0,
    WarezCreatedAt: online.release.created_at ?? '',
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
  config: Config,
  checkOnline: (stateUrl: string) => Promise<boolean>,
): Promise<'enriched' | 'skipped'> {
  const candidateReleases = sortReleasesByPreference(
    releases.filter(r => releaseMatchesFilters(r, watchlistItem)),
    config.PREFERRED_GROUPS,
  );

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

interface SeriesAttemptResult {
  enriched: number;
  updated: number;
  hadAnyNewCandidates: boolean;
  matchedRelease?: WarezDetailRelease;
}

/**
 * Attempt to match season packs or individual episodes from `candidateReleases`
 * for one series + season bucket.
 *
 * Candidates are ranked using `sortReleasesByPreference` (HDR → 265 → 264 → fallback).
 * If `pinAutoTagsOnMatch` is true, once the first release matches, its profile is pinned
 * into `AutoTags` (and immediately enforced on remaining episodes in the same batch).
 */
async function attemptSeriesMatch(
  candidateReleases: WarezDetailRelease[],
  foundEntries: MatchEntry[],
  recheckEntries: MatchEntry[],
  bucketSeason: number | null,
  lastEp: number,
  watchlistItem: WatchlistRow & { Id: number },
  nocodb: NocoDbClient,
  config: Config,
  checkOnline: (stateUrl: string) => Promise<boolean>,
  pinAutoTagsMode: 'none' | 'initial' | 'fallback',
): Promise<SeriesAttemptResult> {
  const hasRecheck = recheckEntries.length > 0;
  const baseMatch = (foundEntries[0] ?? recheckEntries[0])!.match;

  const pinProfile = async (release: WarezDetailRelease): Promise<string | undefined> => {
    if (pinAutoTagsMode === 'none') return undefined;
    const newAutoTags = formatAutoTags(extractReleaseProfile(release));
    if (!newAutoTags) return undefined;

    if (pinAutoTagsMode === 'fallback') {
      const prev = watchlistItem.AutoTags ?? '';
      if (newAutoTags !== prev) {
        await nocodb.updateWatchlistAutoTags(watchlistItem.Id, newAutoTags);
        watchlistItem.AutoTags = newAutoTags;
        console.log(`  🔄 AutoTags fallback: [${watchlistItem.Title}] "${prev}" → "${newAutoTags}"`);
      }
    } else if (!watchlistItem.AutoTags?.trim()) {
      await nocodb.updateWatchlistAutoTags(watchlistItem.Id, newAutoTags);
      watchlistItem.AutoTags = newAutoTags;
      console.log(`  📌 Pinned AutoTags: [${watchlistItem.Title}] → "${newAutoTags}"`);
    }
    return newAutoTags;
  };

  // Split into season packs vs individual episodes, ranked by preference ladder
  const seasonPackCandidates = sortReleasesByPreference(
    candidateReleases
      .filter(r => isSeasonPackFulltitle(r.fulltitle))
      .filter(r => {
        const count = getEpisodeCount(r);
        if (count != null) return count > lastEp;
        // Season pack without episode_count_in_season: only eligible on initial enrichment with no prior eps
        return !hasRecheck && lastEp === 0;
      }),
    config.PREFERRED_GROUPS,
  );

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
      await pinProfile(online.release);

      if (foundEntries.length > 0) {
        console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${online.release.fulltitle}" (${seasonEpisodeKey ?? 'pack'})`);
        return { enriched: 1, updated: 0, hadAnyNewCandidates: true, matchedRelease: online.release };
      } else {
        console.log(`  🆕 New episodes: [${watchlistItem.Title}] — ${seasonEpisodeKey ?? 'pack'} (was E${String(lastEp).padStart(2, '0')})`);
        return { enriched: 0, updated: 1, hadAnyNewCandidates: true, matchedRelease: online.release };
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
    let firstMatchedRelease: WarezDetailRelease | undefined;
    let sessionPinnedAutoTags: string | undefined;

    for (const epNum of sortedEpNumbers) {
      let mirrors = episodesMap.get(epNum)!;
      // Once the first episode in this batch pins AutoTags, keep remaining episodes in the batch consistent
      if (sessionPinnedAutoTags) {
        const pinnedMirrors = mirrors.filter(r => matchesAutoTags(r, sessionPinnedAutoTags, 'strict'));
        if (pinnedMirrors.length > 0) {
          mirrors = pinnedMirrors;
        } else {
          continue;
        }
      }

      const sortedMirrors = sortReleasesByPreference(mirrors, config.PREFERRED_GROUPS);
      const online = await findFirstOnlineRelease(sortedMirrors, checkOnline);
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

      if (!firstMatchedRelease) {
        firstMatchedRelease = online.release;
        sessionPinnedAutoTags = await pinProfile(online.release);
      }

      if (epNum > highestMatched) highestMatched = epNum;
    }

    if (enriched > 0 || updated > 0) {
      await nocodb.updateWatchlistLastMatched(watchlistItem.Id, new Date().toISOString());
      if (highestMatched > (watchlistItem.LastEpisodeFound ?? 0)) {
        await nocodb.updateWatchlistEpisode(watchlistItem.Id, highestMatched);
        watchlistItem.LastEpisodeFound = highestMatched;
      }
      return { enriched, updated, hadAnyNewCandidates: true, matchedRelease: firstMatchedRelease };
    }
  }

  return {
    enriched: 0,
    updated: 0,
    hadAnyNewCandidates: seasonPackCandidates.length > 0 || sortedEpNumbers.length > 0,
  };
}

/**
 * Process all matches for one series + season bucket against available releases.
 *
 * Handles:
 * 1. Manual `Tags` (highest priority — overrides and never touches `AutoTags`).
 * 2. Pinned `AutoTags` (strict match first; if nothing new is found and `AUTOTAGS_FALLBACK_HOURS`
 *    has elapsed on a matching DynamicRange+Codec release from another group, falls back and updates `AutoTags`).
 * 3. Initial match without `Tags`/`AutoTags`: ranks via preference ladder (HDR → 265 → 264 → fallback)
 *    and pins the matched release profile into `AutoTags`.
 */
async function processSeriesBucket(
  entries: MatchEntry[],
  bucketSeason: number | null,
  releases: WarezDetailRelease[],
  watchlistItem: WatchlistRow & { Id: number },
  nocodb: NocoDbClient,
  config: Config,
  checkOnline: (stateUrl: string) => Promise<boolean>,
  now: Date,
): Promise<{ enriched: number; updated: number; skipped: number }> {
  const foundEntries = entries.filter(e => !e.isRecheck);
  const recheckEntries = entries.filter(e => e.isRecheck);
  const hasRecheck = recheckEntries.length > 0;
  const baseMatch = (foundEntries[0] ?? recheckEntries[0])!.match;

  // Base filters: Quality, LangRequired, and Season
  const baseReleases = releases.filter(r => {
    if (!releaseMatchesBaseFilters(r, watchlistItem)) return false;
    if (hasRecheck && bucketSeason != null) {
      const relSeason = extractSeason(r.fulltitle);
      if (relSeason !== null && relSeason !== bucketSeason) return false;
    }
    return true;
  });

  // Highest episode already tracked for this bucket.
  // On re-check, use the minimum of match.Episode and watchlist.LastEpisodeFound (when set)
  // so manually lowering LastEpisodeFound in the Watchlist table triggers a re-download,
  // while multi-season shows with a lower match.Episode still track their own season accurately.
  const maxMatchEp = hasRecheck
    ? Math.max(...recheckEntries.map(e => e.match.Episode ?? 0))
    : 0;
  const lastEp = hasRecheck
    ? (watchlistItem.LastEpisodeFound != null
      ? Math.min(maxMatchEp, watchlistItem.LastEpisodeFound)
      : maxMatchEp)
    : (watchlistItem.LastEpisodeFound ?? 0);

  const manualTagsActive = hasManualTags(watchlistItem.Tags);
  const autoTagsValue = !manualTagsActive ? watchlistItem.AutoTags?.trim() : undefined;

  let primaryCandidates: WarezDetailRelease[];
  let pinMode: 'none' | 'initial' | 'fallback';

  if (manualTagsActive) {
    primaryCandidates = baseReleases.filter(r => matchesTags(r.fulltitle, watchlistItem.Tags));
    pinMode = 'none';
  } else if (autoTagsValue) {
    primaryCandidates = baseReleases.filter(r => matchesAutoTags(r, autoTagsValue, 'strict'));
    pinMode = 'none';
  } else {
    primaryCandidates = baseReleases;
    pinMode = 'initial';
  }

  let primaryAttempt: SeriesAttemptResult = { enriched: 0, updated: 0, hadAnyNewCandidates: false };

  if (primaryCandidates.length > 0) {
    primaryAttempt = await attemptSeriesMatch(
      primaryCandidates,
      foundEntries,
      recheckEntries,
      bucketSeason,
      lastEp,
      watchlistItem,
      nocodb,
      config,
      checkOnline,
      pinMode,
    );
    if (primaryAttempt.enriched > 0 || primaryAttempt.updated > 0) {
      return { enriched: primaryAttempt.enriched, updated: primaryAttempt.updated, skipped: 0 };
    }
  }

  // Pass 2: Grace-period fallback when AutoTags is active and strict group/source match yielded nothing new
  if (autoTagsValue && hasRelaxableAutoTags(autoTagsValue)) {
    const fallbackHours = config.AUTOTAGS_FALLBACK_HOURS ?? 48;
    const fallbackCandidates = baseReleases.filter(
      r => matchesAutoTags(r, autoTagsValue, 'relaxed') && isReleaseOlderThanGracePeriod(r, now, fallbackHours),
    );

    if (fallbackCandidates.length > 0) {
      const fallbackAttempt = await attemptSeriesMatch(
        fallbackCandidates,
        foundEntries,
        recheckEntries,
        bucketSeason,
        lastEp,
        watchlistItem,
        nocodb,
        config,
        checkOnline,
        'fallback',
      );
      if (fallbackAttempt.enriched > 0 || fallbackAttempt.updated > 0) {
        return { enriched: fallbackAttempt.enriched, updated: fallbackAttempt.updated, skipped: 0 };
      }
    }
  }

  // Nothing new or all matching candidates offline
  if (!hasRecheck) {
    if (primaryCandidates.length === 0) {
      const filters = [
        watchlistItem.Quality ? `Q:${watchlistItem.Quality}` : null,
        manualTagsActive ? `Tags:${watchlistItem.Tags}` : null,
        autoTagsValue ? `AutoTags:${autoTagsValue}` : null,
        watchlistItem.LangRequired ? `Lang:${watchlistItem.LangRequired}` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ⏳ No matching release for "${baseMatch.Title}" (filters: ${filters || 'none'})`);
    } else if (primaryAttempt.hadAnyNewCandidates) {
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
  const now = options.now ?? new Date();

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

  // Pre-load watchlist items and filter out entries belonging to inactive/missing watchlist items
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
  let failed = 0;
  const enrichErrors: { label: string; uid?: string; title?: string; message: string }[] = [];

  // Group active entries by WarezUid to avoid duplicate or wasted API calls
  const byUid = new Map<string, MatchEntry[]>();
  for (const entry of allMatches) {
    const wid = entry.match.WatchlistId;
    const watchlistItem = wid ? watchlistCache.get(wid) : undefined;
    if (!watchlistItem || !watchlistItem.Active) {
      skipped++;
      continue;
    }
    const uid = entry.match.WarezUid;
    if (!uid) {
      skipped++;
      continue;
    }
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(entry);
  }

  if (byUid.size === 0) {
    console.log(`✔ Enrichment done. Enriched: 0, Updated: 0, Skipped: ${skipped} (all watchlist items inactive)`);
    return;
  }

  for (const [uid, entries] of byUid) {
    const firstEntry = entries[0]!;
    const entryTitle = firstEntry.match.Title || uid;
    const label = firstEntry.isRecheck ? '🔄' : '📦';
    console.log(`  ${label} Fetching detail for: ${entryTitle} (${uid})`);

    let releases: WarezDetailRelease[];
    try {
      const detail = await warez.fetchEntryDetail(uid);
      const rawReleases = Array.isArray(detail?.releases) ? detail.releases : [];
      releases = rawReleases.filter(
        (r): r is WarezDetailRelease => Boolean(r && typeof r === 'object'),
      );
      console.log(`     → ${releases.length} release(s) available`);
    } catch (err) {
      const msg = formatErrorMessage(err);
      console.error(`  ⚠ Detail fetch failed for "${entryTitle}" (${uid}):`, err);
      failed++;
      enrichErrors.push({
        label: `${entryTitle} (${uid})`,
        uid,
        title: firstEntry.match.Title,
        message: `Detail fetch failed: ${msg}`,
      });
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
          try {
            const result = await processMovieMatch(match, releases, watchlistItem, nocodb, config, checkOnline);
            if (result === 'enriched') {
              enriched++;
              console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${match.Title}"`);
            } else {
              skipped++;
            }
          } catch (err) {
            const msg = formatErrorMessage(err);
            console.error(`  ❌ Enrich failed for movie "${watchlistItem.Title}" (${uid}):`, err);
            failed++;
            enrichErrors.push({
              label: `${watchlistItem.Title} (${uid})`,
              uid,
              title: watchlistItem.Title,
              message: msg,
            });
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
        try {
          const res = await processSeriesBucket(
            bucketEntries,
            bucketSeason,
            releases,
            watchlistItem,
            nocodb,
            config,
            checkOnline,
            now,
          );
          enriched += res.enriched;
          updated += res.updated;
          skipped += res.skipped;
        } catch (err) {
          const msg = formatErrorMessage(err);
          const seasonSuffix = bucketSeason != null ? ` S${String(bucketSeason).padStart(2, '0')}` : '';
          console.error(`  ❌ Enrich failed for series "${watchlistItem.Title}${seasonSuffix}" (${uid}):`, err);
          failed++;
          enrichErrors.push({
            label: `${watchlistItem.Title}${seasonSuffix} (${uid})`,
            uid,
            title: watchlistItem.Title,
            message: msg,
          });
        }
      }
    }

    await sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(
    `✔ Enrichment done. Enriched: ${enriched}, Updated: ${updated}, Skipped: ${skipped}${failed > 0 ? `, Failed: ${failed}` : ''}`,
  );

  if (enrichErrors.length > 0) {
    const single = enrichErrors.length === 1 ? enrichErrors[0]! : undefined;
    await safeNotifyError(options.ntfy, {
      source: 'enrich',
      summary: single
        ? `${single.label} failed`
        : `${enrichErrors.length} item(s) failed during enrichment`,
      errors: enrichErrors.map(e => `${e.label}: ${e.message}`),
      warezUid: single?.uid,
      title: single?.title,
    });
  }
}
