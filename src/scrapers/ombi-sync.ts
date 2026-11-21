import type { Config } from '../config';
import type { NocoDbClient } from '../nocodb/client';
import type { WatchlistRow } from '../nocodb/types';
import type { OmbiClient } from '../ombi/client';
import type { OmbiMovieRequest, OmbiTvRequest } from '../ombi/types';
import { normalizeTitle } from '../matcher';

const MS_PER_DAY = 86_400_000;

export interface OmbiSyncOptions {
  /** Override current time (for deterministic testing) */
  now?: Date;
}

export interface OmbiSyncSummary {
  created: number;
  activated: number;
  deactivated: number;
  updated: number;
  unchanged: number;
}

export interface DesiredWatchlistItem {
  type: 'movie' | 'series';
  title: string;
  imdbId?: string;
  tmdbId?: number;
  season?: number;
  isApproved: boolean;
  isAvailable: boolean;
  isReleased: boolean;
  releaseDateLabel?: string;
  want4k: boolean;
  initialLastEpisodeFound?: number;
  highestRequestedEpisode?: number;
}

/**
 * Parse an Ombi date string, returning null for unset/placeholder values
 * (Ombi/.NET serializes default DateTime as "0001-01-01T00:00:00").
 */
export function parseValidDate(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() <= 1900) return null;

  return parsed;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeImdbId(imdbId?: string | null): string | undefined {
  if (!imdbId) return undefined;
  const trimmed = imdbId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Determine whether a movie is within its release window and ready to be scanned.
 * Returns true if:
 * - No release dates are known (don't block), OR
 * - releaseDate <= now, OR
 * - digitalReleaseDate <= now + digitalLookaheadDays
 */
export function isMovieReleased(
  req: Pick<OmbiMovieRequest, 'releaseDate' | 'digitalReleaseDate'>,
  now: Date,
  digitalLookaheadDays: number,
): { released: boolean; earliestKnownDate?: string } {
  const releaseDate = parseValidDate(req.releaseDate);
  const digitalReleaseDate = parseValidDate(req.digitalReleaseDate);

  if (!releaseDate && !digitalReleaseDate) {
    return { released: true };
  }

  const nowMs = now.getTime();
  const digitalThresholdMs = nowMs + digitalLookaheadDays * MS_PER_DAY;

  if (releaseDate && releaseDate.getTime() <= nowMs) {
    return { released: true, earliestKnownDate: formatIsoDate(releaseDate) };
  }

  if (digitalReleaseDate && digitalReleaseDate.getTime() <= digitalThresholdMs) {
    return { released: true, earliestKnownDate: formatIsoDate(digitalReleaseDate) };
  }

  const nextDate = releaseDate && digitalReleaseDate
    ? (releaseDate.getTime() <= digitalReleaseDate.getTime() ? releaseDate : digitalReleaseDate)
    : (releaseDate ?? digitalReleaseDate)!;

  return { released: false, earliestKnownDate: formatIsoDate(nextDate) };
}

/**
 * Evaluate an Ombi movie request into a normalized desired watchlist item.
 */
export function evaluateMovieRequest(
  req: OmbiMovieRequest,
  now: Date,
  digitalLookaheadDays: number,
): DesiredWatchlistItem {
  const stdApproved = Boolean(req.approved) && !req.denied;
  const stdAvailable = Boolean(req.available);

  const fourKRequested = Boolean(req.is4kRequest || req.has4KRequest || req.approved4K);
  const fourKApproved = Boolean(req.approved4K || (req.is4kRequest && req.approved)) && !req.denied4K;
  const fourKAvailable = Boolean(req.available4K || (req.is4kRequest && !req.has4KRequest && req.available));

  let isApproved = false;
  let isAvailable = false;
  let want4k = false;

  if (fourKApproved && !fourKAvailable) {
    // Active approved 4K request takes priority
    isApproved = true;
    isAvailable = false;
    want4k = true;
  } else if (stdApproved && !stdAvailable) {
    // Active approved standard request
    isApproved = true;
    isAvailable = false;
    want4k = fourKRequested && fourKApproved && !fourKAvailable;
  } else if (stdApproved || fourKApproved) {
    // Approved, and all approved variants are already available
    isApproved = true;
    isAvailable = true;
    want4k = fourKApproved;
  }

  const releaseCheck = isMovieReleased(req, now, digitalLookaheadDays);

  return {
    type: 'movie',
    title: req.title.trim(),
    imdbId: normalizeImdbId(req.imdbId),
    tmdbId: req.theMovieDbId && req.theMovieDbId > 0 ? req.theMovieDbId : undefined,
    isApproved,
    isAvailable,
    isReleased: releaseCheck.released,
    releaseDateLabel: releaseCheck.earliestKnownDate,
    want4k,
  };
}

interface AggregatedEpisode {
  episodeNumber: number;
  available: boolean;
  airDate: Date | null;
}

/**
 * Evaluate an Ombi TV request (which may have multiple child requests across users)
 * into one desired watchlist item per requested season.
 */
export function evaluateTvRequest(
  tv: OmbiTvRequest,
  now: Date,
  seriesLookaheadDays: number,
): DesiredWatchlistItem[] {
  const seasonsMap = new Map<number, Map<number, AggregatedEpisode>>();

  for (const child of tv.childRequests ?? []) {
    if (child.denied === true || !child.approved) continue;

    for (const seasonReq of child.seasonRequests ?? []) {
      const seasonNum = seasonReq.seasonNumber;
      if (seasonNum == null || seasonNum < 0) continue;

      for (const ep of seasonReq.episodes ?? []) {
        if (ep.denied === true || ep.approved === false || ep.requested === false) continue;

        let epMap = seasonsMap.get(seasonNum);
        if (!epMap) {
          epMap = new Map<number, AggregatedEpisode>();
          seasonsMap.set(seasonNum, epMap);
        }

        const existing = epMap.get(ep.episodeNumber);
        const airDate = parseValidDate(ep.airDate);
        if (existing) {
          existing.available = existing.available || Boolean(ep.available);
          if (!existing.airDate && airDate) existing.airDate = airDate;
        } else {
          epMap.set(ep.episodeNumber, {
            episodeNumber: ep.episodeNumber,
            available: Boolean(ep.available),
            airDate,
          });
        }
      }
    }
  }

  const items: DesiredWatchlistItem[] = [];
  const thresholdMs = now.getTime() + seriesLookaheadDays * MS_PER_DAY;
  const tvImdbId = normalizeImdbId(tv.imdbId);
  const rawTmdbId = tv.theMovieDbId ?? tv.externalProviderId;
  const tvTmdbId = rawTmdbId && rawTmdbId > 0 ? rawTmdbId : undefined;

  const sortedSeasons = [...seasonsMap.keys()].sort((a, b) => a - b);

  for (const seasonNum of sortedSeasons) {
    const episodes = [...seasonsMap.get(seasonNum)!.values()].sort(
      (a, b) => a.episodeNumber - b.episodeNumber,
    );
    if (episodes.length === 0) continue;

    const neededEpisodes = episodes.filter(e => !e.available);
    const allAvailable = neededEpisodes.length === 0;
    const highestRequestedEpisode = episodes[episodes.length - 1]!.episodeNumber;

    // Seed LastEpisodeFound on initial insert to (first needed episode - 1)
    const initialLastEpisodeFound = neededEpisodes.length > 0
      ? Math.max(0, neededEpisodes[0]!.episodeNumber - 1)
      : highestRequestedEpisode;

    // Check release/air date of the season's first requested episode (keep Active=true while airing)
    const seasonAirDates = episodes
      .map(e => e.airDate)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());

    let isReleased = true;
    let releaseDateLabel: string | undefined;

    if (seasonAirDates.length > 0) {
      const earliest = seasonAirDates[0]!;
      releaseDateLabel = formatIsoDate(earliest);
      isReleased = earliest.getTime() <= thresholdMs;
    } else if (seasonNum === 1) {
      const showRelease = parseValidDate(tv.releaseDate);
      if (showRelease) {
        releaseDateLabel = formatIsoDate(showRelease);
        isReleased = showRelease.getTime() <= thresholdMs;
      }
    }

    items.push({
      type: 'series',
      title: tv.title.trim(),
      imdbId: tvImdbId,
      tmdbId: tvTmdbId,
      season: seasonNum,
      isApproved: true,
      isAvailable: allAvailable,
      isReleased,
      releaseDateLabel,
      want4k: false,
      initialLastEpisodeFound,
      highestRequestedEpisode,
    });
  }

  return items;
}

/**
 * Determine the desired `Active` boolean for a synced watchlist item, taking into account
 * its current NocoDB state (e.g. movie already matched with DeactivateOnMatch, or series
 * whose LastEpisodeFound already reached the highest requested episode).
 */
export function computeDesiredActive(
  desired: DesiredWatchlistItem,
  existing?: WatchlistRow,
): boolean {
  if (!desired.isApproved || desired.isAvailable || !desired.isReleased) {
    return false;
  }

  if (desired.type === 'movie') {
    // Keep movie inactive once matched & deactivated by DeactivateOnMatch (while downloading / awaiting Plex scan)
    if (existing && Boolean(existing.DeactivateOnMatch) && Boolean(existing.LastMatchedAt)) {
      return false;
    }
    return true;
  }

  // Series: deactivate once all requested episodes in this season have been matched
  if (
    existing &&
    desired.highestRequestedEpisode != null &&
    existing.LastEpisodeFound != null &&
    existing.LastEpisodeFound >= desired.highestRequestedEpisode
  ) {
    return false;
  }

  return true;
}

/**
 * Find an existing NocoDB watchlist row corresponding to a desired Ombi item.
 */
function findMatchingWatchlistRow(
  desired: DesiredWatchlistItem,
  allWatchlist: (WatchlistRow & { Id: number })[],
  alreadyMatchedIds: Set<number>,
): (WatchlistRow & { Id: number }) | undefined {
  const candidates = allWatchlist.filter((row) => {
    if (alreadyMatchedIds.has(row.Id)) return false;
    if (row.Type && row.Type !== desired.type) return false;
    if (desired.type === 'series' && row.Season !== desired.season) return false;
    return true;
  });

  // 1. Exact IMDB ID match
  if (desired.imdbId) {
    const targetImdb = desired.imdbId.toLowerCase();
    const byImdb = candidates.find(r => r.ImdbId?.trim().toLowerCase() === targetImdb);
    if (byImdb) return byImdb;
  }

  // 2. Exact TMDB ID match
  if (desired.tmdbId) {
    const byTmdb = candidates.find(r => r.TmdbId != null && Number(r.TmdbId) === desired.tmdbId);
    if (byTmdb) return byTmdb;
  }

  // 3. Normalized title match
  const targetTitle = normalizeTitle(desired.title);
  if (targetTitle) {
    const byTitle = candidates.find(r => normalizeTitle(r.Title) === targetTitle);
    if (byTitle) return byTitle;
  }

  return undefined;
}

/**
 * Build the initial NocoDB watchlist record for a newly synced Ombi item.
 */
export function buildNewWatchlistRow(
  desired: DesiredWatchlistItem,
  config: Pick<Config, 'DEFAULT_QUALITY' | 'DEFAULT_LANG' | 'DEFAULT_TAGS'>,
): Omit<WatchlistRow, 'Id'> {
  const quality = desired.want4k ? '2160p' : config.DEFAULT_QUALITY;
  const lang = config.DEFAULT_LANG.trim();
  const tags = config.DEFAULT_TAGS
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const active = computeDesiredActive(desired);

  let notes = 'Synced from Ombi';
  if (desired.type === 'series' && desired.season != null) {
    const sLabel = `S${String(desired.season).padStart(2, '0')}`;
    notes = !desired.isReleased && desired.releaseDateLabel
      ? `Synced from Ombi (${sLabel}, premieres ${desired.releaseDateLabel})`
      : `Synced from Ombi (${sLabel})`;
  } else if (!desired.isReleased && desired.releaseDateLabel) {
    notes = `Synced from Ombi (unreleased, release: ${desired.releaseDateLabel})`;
  }

  const row: Omit<WatchlistRow, 'Id'> = {
    Title: desired.title,
    Type: desired.type,
    Active: active,
    DeactivateOnMatch: desired.type === 'movie',
    Notes: notes,
  };

  if (desired.imdbId) row.ImdbId = desired.imdbId;
  if (desired.tmdbId) row.TmdbId = desired.tmdbId;
  if (quality) row.Quality = quality;
  if (lang) row.LangRequired = lang;
  if (tags.length > 0) row.Tags = tags;
  if (desired.type === 'series' && desired.season != null) {
    row.Season = desired.season;
    row.LastEpisodeFound = desired.initialLastEpisodeFound ?? 0;
  }

  return row;
}

/**
 * Sync approved Movie and TV requests from Ombi into the NocoDB watchlist table.
 *
 * Ombi is the sole source of truth for `Active`:
 * - New approved, non-available requests are inserted with configured defaults
 *   (and `Active = false` until release/air date arrives).
 * - Existing rows keep their manual filter overrides (`Quality`, `LangRequired`, `Tags`,
 *   `LastEpisodeFound`), while `Active` is kept in sync with Ombi status + release dates.
 * - Any active NocoDB row that is removed, denied, unapproved, or marked available in Ombi
 *   is automatically deactivated (`Active = false`).
 */
export async function runOmbiSync(
  ombi: OmbiClient,
  nocodb: NocoDbClient,
  config: Config,
  options: OmbiSyncOptions = {},
): Promise<OmbiSyncSummary> {
  const now = options.now ?? new Date();
  console.log('▶ Ombi watchlist sync starting...');

  const [movieRequests, tvRequests, allWatchlist] = await Promise.all([
    ombi.getMovieRequests(),
    ombi.getTvRequests(),
    nocodb.getAllWatchlist(),
  ]);

  console.log(
    `  Fetched ${movieRequests.length} movie request(s), ${tvRequests.length} TV request(s) from Ombi; ${allWatchlist.length} existing watchlist row(s) in NocoDB`,
  );

  const desiredItems: DesiredWatchlistItem[] = [];

  for (const movie of movieRequests) {
    desiredItems.push(
      evaluateMovieRequest(movie, now, config.OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS),
    );
  }

  for (const tv of tvRequests) {
    desiredItems.push(
      ...evaluateTvRequest(tv, now, config.OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS),
    );
  }

  const summary: OmbiSyncSummary = {
    created: 0,
    activated: 0,
    deactivated: 0,
    updated: 0,
    unchanged: 0,
  };

  const matchedWatchlistIds = new Set<number>();

  for (const desired of desiredItems) {
    const existing = findMatchingWatchlistRow(desired, allWatchlist, matchedWatchlistIds);
    const label = desired.type === 'series' && desired.season != null
      ? `${desired.title} S${String(desired.season).padStart(2, '0')}`
      : desired.title;

    if (existing) {
      matchedWatchlistIds.add(existing.Id);

      const currentActive = Boolean(existing.Active);
      const desiredActive = computeDesiredActive(desired, existing);
      const updates: Partial<WatchlistRow> = {};

      if (currentActive !== desiredActive) {
        updates.Active = desiredActive;
      }
      if (!existing.ImdbId && desired.imdbId) {
        updates.ImdbId = desired.imdbId;
      }
      if (!existing.TmdbId && desired.tmdbId) {
        updates.TmdbId = desired.tmdbId;
      }

      if (Object.keys(updates).length > 0) {
        await nocodb.updateWatchlistItem(existing.Id, updates);
        if (updates.Active === true) {
          summary.activated++;
          console.log(`  🟢 Activated: [${label}]`);
        } else if (updates.Active === false) {
          summary.deactivated++;
          const reason = !desired.isApproved
            ? 'denied/unapproved'
            : desired.isAvailable
              ? 'available in Ombi'
              : !desired.isReleased
                ? `unreleased (${desired.releaseDateLabel ?? 'tbd'})`
                : 'all episodes matched';
          console.log(`  🔕 Deactivated: [${label}] (${reason})`);
        } else {
          summary.updated++;
          console.log(`  📝 Backfilled IDs for: [${label}]`);
        }
      } else {
        summary.unchanged++;
      }
    } else {
      // Do not clutter NocoDB with denied, unapproved, or already-available requests
      if (!desired.isApproved || desired.isAvailable) {
        continue;
      }

      const newRow = buildNewWatchlistRow(desired, config);
      const created = await nocodb.createWatchlistItem(newRow);
      matchedWatchlistIds.add(created.Id);
      summary.created++;

      const statusIcon = newRow.Active ? '✅' : '⏳';
      const statusText = newRow.Active
        ? 'Active'
        : `Inactive (waiting for ${desired.releaseDateLabel ?? 'release'})`;
      console.log(
        `  ${statusIcon} Created: [${label}] (${newRow.Quality || 'any'}, ${newRow.LangRequired || 'any'}) → ${statusText}`,
      );
    }
  }

  // Deactivate any remaining active NocoDB watchlist rows not backed by Ombi
  for (const row of allWatchlist) {
    if (matchedWatchlistIds.has(row.Id)) continue;
    if (!row.Active) continue;

    await nocodb.updateWatchlistItem(row.Id, { Active: false });
    summary.deactivated++;
    const label = row.Type === 'series' && row.Season != null
      ? `${row.Title} S${String(row.Season).padStart(2, '0')}`
      : row.Title;
    console.log(`  🔕 Deactivated: [${label}] (no longer requested/approved in Ombi)`);
  }

  console.log(
    `✔ Ombi sync done. Created: ${summary.created}, Activated: ${summary.activated}, Deactivated: ${summary.deactivated}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}`,
  );

  return summary;
}
