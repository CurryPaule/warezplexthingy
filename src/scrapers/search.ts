import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezSearchEntry } from '../warez/types';
import type { NtfyClient } from '../ntfy/client';
import { formatErrorMessage, safeNotifyError } from '../ntfy/client';
import type { Config } from '../config';
import {
  normalizeTitle,
  meetsLanguage,
} from '../matcher';
import { sleep } from '../utils';

export interface SearchOptions {
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional ntfy client — sends an emergency error ping if any watchlist search fails */
  ntfy?: NtfyClient;
}

/**
 * Build the search query for a watchlist item.
 * For series with a specific season, include the season marker.
 */
function buildSearchQuery(item: WatchlistRow): string {
  // Prefer IMDB ID for precise search when available
  if (item.ImdbId) return item.ImdbId;
  if (item.Type === 'series' && item.Season != null) {
    const s = String(item.Season).padStart(2, '0');
    return `${item.Title} S${s}`;
  }
  return item.Title;
}

/**
 * Check if a search entry matches a watchlist item.
 * Reuses shared filter functions from matcher.ts.
 *
 * Note: search entries are entry-level (no quality, no release-specific fulltitle),
 * so Quality and Tags filters are NOT applied here — those are enforced by the
 * enrichment scraper which has release-level detail.
 */
function entryMatchesWatchlistItem(entry: WarezSearchEntry, item: WatchlistRow): boolean {
  // Type must match
  if (item.Type && entry.type !== item.Type) return false;

  // Language filter — search entries do carry language info
  if (!meetsLanguage(entry.lang, item.LangRequired, entry.fulltitle)) return false;

  // Quality and Tags are intentionally NOT checked here:
  // search entries have no quality field and their fulltitle is just the
  // media title (e.g. "Dutton Ranch"), not a release name with codec/format info.

  // ID-based match (most reliable)
  if (item.ImdbId && entry.options?.imdb_id) {
    return entry.options.imdb_id === item.ImdbId;
  }
  if (item.TmdbId && entry.options?.tmdb_id) {
    return Number(entry.options.tmdb_id) === item.TmdbId;
  }

  // Title-based match
  const watchTitle = normalizeTitle(item.Title);
  if (!watchTitle) return false;
  const entryTitle = normalizeTitle(entry.title);
  const entryOriginal = normalizeTitle(entry.original_title || '');

  return (Boolean(entryTitle) && (entryTitle === watchTitle || entryTitle.includes(watchTitle) || watchTitle.includes(entryTitle)))
    || (Boolean(entryOriginal) && entryOriginal === watchTitle);
}

/**
 * Search-based scraper: for each active watchlist item, query the warez
 * search API (/start/search) and write any matches to the matches table.
 *
 * Note: Search results are entry-level (no download links).
 * Download links are resolved by the enrichment scraper via the detail API.
 */
export async function runSearchScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
  options: SearchOptions = {},
): Promise<void> {
  const sleepFn = options.sleepFn ?? sleep;
  console.log('▶ Search scraper starting...');

  const watchlist = await nocodb.getActiveWatchlist();
  const alreadyMatched = await nocodb.getWatchlistIdsWithActiveMatches();
  const toSearch = watchlist.filter(item => !alreadyMatched.has(item.Id));

  console.log(`  Watchlist: ${watchlist.length} active item(s), ${alreadyMatched.size} already matched → ${toSearch.length} to search`);

  if (toSearch.length === 0) {
    console.log('  Nothing to search.');
    return;
  }

  let totalMatched = 0;
  let failed = 0;
  const searchErrors: string[] = [];

  for (const item of toSearch) {
    const query = buildSearchQuery(item);
    console.log(`  🔍 Searching: "${query}" (${item.Type ?? 'any'})`);

    try {
      const rawEntries = await warez.searchEntries(query);
      const entries = Array.isArray(rawEntries)
        ? rawEntries.filter((e): e is WarezSearchEntry => Boolean(e && typeof e === 'object'))
        : [];

      console.log(`     → ${entries.length} result(s)`);

      const matched = entries.filter(e => entryMatchesWatchlistItem(e, item));

      for (const entry of matched) {
        const cleanLang = Array.isArray(entry.lang)
          ? entry.lang.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          : [];
        const matchRecord: Omit<MatchRow, 'Id'> = {
          WatchlistId: item.Id,
          WarezId: entry.id,
          WarezUid: entry.uid,
          Title: entry.title || item.Title,
          Fulltitle: entry.fulltitle || entry.title || item.Title,
          Type: entry.type || item.Type || 'movie',
          Quality: '',
          Lang: JSON.stringify(cleanLang),
          Links: '{}',
          CryptedLinks: '{}',
          SizeBytes: 0,
          ReleaseGroup: '',
          ImdbId: entry.options?.imdb_id ?? '',
          TmdbId: Number(entry.options?.tmdb_id) || 0,
          WarezCreatedAt: '',
          MatchedAt: new Date().toISOString(),
          Status: 'found',
        };

        const isNew = await nocodb.upsertMatch(matchRecord);
        if (!isNew) {
          console.log(`  ⏩ Skipped (already exists): "${matchRecord.Title}"`);
          continue;
        }

        await nocodb.updateWatchlistLastMatched(item.Id, matchRecord.MatchedAt);
        totalMatched++;
        console.log(`  ✅ Match: [${item.Title}] ← "${matchRecord.Title}" (${matchRecord.Type}, IMDB: ${entry.options?.imdb_id ?? 'n/a'})`);
      }
    } catch (err) {
      const msg = formatErrorMessage(err);
      console.error(`  ⚠ Search failed for "${item.Title}" (query "${query}"):`, err);
      failed++;
      searchErrors.push(`${item.Title} ("${query}"): ${msg}`);
    }

    await sleepFn(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Search done. Total new matches: ${totalMatched}${failed > 0 ? `, Failed: ${failed}` : ''}`);

  if (searchErrors.length > 0) {
    await safeNotifyError(options.ntfy, {
      source: 'search',
      summary: `${searchErrors.length} watchlist search(es) failed`,
      errors: searchErrors,
    });
  }
}
