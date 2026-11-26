import type { WarezRelease } from './warez/types';
import type { WatchlistRow } from './nocodb/types';

/** Quality tiers in ascending order */
const QUALITY_TIERS: Record<string, number> = {
  '720p': 1,
  '1080p': 2,
  '4k': 3,
  '2160p': 3,
};

/** Normalize a title for comparison: lowercase, replace separators with space, strip trailing year/junk */
export function normalizeTitle(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the clean show/movie title from a warez fulltitle.
 * e.g. "Ladies.First.2026.German.DL.2160p.DV..." → "ladies first"
 * e.g. "Mating.Season.S01.GERMAN.DL..." → "mating season"
 */
export function extractTitleFromFulltitle(fulltitle: string | null | undefined): string {
  const normalized = normalizeTitle(fulltitle);
  if (!normalized) return '';

  // Cut off at common release markers (only when not at start of title, e.g. movie "1917")
  const cutPatterns = [
    /\b\d{4}\b/g,              // year (e.g. 2026)
    /\bs\d{2}(?=e\d|\b)/g,     // season or season+episode marker (e.g. s01, s01e02)
    /\b(?:german|english|french|spanish|italian|dutch)\b/gi,
    /\b(?:dl|multi)\b/gi,
    /\b(?:720p|1080p|2160p|4k|uhd|hd|sd)\b/gi,
    /\b(?:web|bluray|blu-ray|dvd|hdtv|webrip|hdcam)\b/gi,
    /\b(?:h264|h265|x264|x265|hevc|avc|xvid)\b/gi,
  ];

  let cutIdx = normalized.length;
  for (const pattern of cutPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match.index !== undefined && match.index > 0 && match.index < cutIdx) {
        cutIdx = match.index;
        break;
      }
    }
  }

  return normalized.slice(0, cutIdx).trim();
}

/** Check if a release matches the required quality exactly */
export function matchesQuality(
  releaseQuality: string | null | undefined,
  requiredQuality: string | undefined | null,
): boolean {
  if (typeof requiredQuality !== 'string' || !requiredQuality.trim()) return true;
  if (typeof releaseQuality !== 'string' || !releaseQuality.trim()) return false;

  const relLower = releaseQuality.trim().toLowerCase();
  const reqLower = requiredQuality.trim().toLowerCase();
  const relTier = QUALITY_TIERS[relLower] ?? 0;
  const reqTier = QUALITY_TIERS[reqLower] ?? 0;
  if (reqTier === 0) return relLower === reqLower;
  return relTier === reqTier;
}

/**
 * Known language tokens in warez fulltitles → normalized language codes.
 * "DL" (Dual Language) in German scene releases conventionally means GER + ENG.
 */
const FULLTITLE_LANG_MAP: Record<string, string[]> = {
  german: ['GER'],
  deutsch: ['GER'],
  english: ['ENG'],
  french: ['FRE'],
  spanish: ['SPA'],
  italian: ['ITA'],
  dutch: ['DUT'],
  japanese: ['JPN'],
  korean: ['KOR'],
  chinese: ['CHI'],
  russian: ['RUS'],
  portuguese: ['POR'],
  turkish: ['TUR'],
  arabic: ['ARA'],
  hindi: ['HIN'],
  dl: ['GER', 'ENG'],
  multi: ['GER', 'ENG'],
};

/**
 * Extract language codes from a release fulltitle.
 * Fallback when the API's `lang` array is null or empty.
 */
export function extractLangsFromFulltitle(fulltitle: string | null | undefined): string[] {
  if (typeof fulltitle !== 'string' || !fulltitle) return [];
  const normalized = fulltitle.toLowerCase().replace(/[._\-]/g, ' ');
  const langs = new Set<string>();
  for (const [token, codes] of Object.entries(FULLTITLE_LANG_MAP)) {
    const pattern = new RegExp(`\\b${token}\\b`, 'i');
    if (pattern.test(normalized)) {
      for (const code of codes) langs.add(code);
    }
  }
  return [...langs];
}

/**
 * Normalize 2-letter ISO-639-1 or variant language codes to canonical 3-letter codes.
 * warez.cx mixes 3-letter ("GER", "ENG", "FRE") and 2-letter ("DE", "EN", "FR") codes across uploaders.
 */
const LANG_ALIASES: Record<string, string> = {
  DE: 'GER',
  DEU: 'GER',
  GERMAN: 'GER',
  DEUTSCH: 'GER',
  EN: 'ENG',
  ENGLISH: 'ENG',
  FR: 'FRE',
  FRA: 'FRE',
  FRENCH: 'FRE',
  ES: 'SPA',
  ESP: 'SPA',
  SPANISH: 'SPA',
  IT: 'ITA',
  ITALIAN: 'ITA',
  NL: 'DUT',
  NLD: 'DUT',
  DUTCH: 'DUT',
  JA: 'JPN',
  JP: 'JPN',
  JAPANESE: 'JPN',
  KO: 'KOR',
  KR: 'KOR',
  KOREAN: 'KOR',
  ZH: 'CHI',
  CN: 'CHI',
  CHINESE: 'CHI',
  RU: 'RUS',
  RUSSIAN: 'RUS',
  PT: 'POR',
  PORTUGUESE: 'POR',
  TR: 'TUR',
  TURKISH: 'TUR',
  AR: 'ARA',
  ARABIC: 'ARA',
  HI: 'HIN',
  HINDI: 'HIN',
  PL: 'POL',
  POLISH: 'POL',
};

export function normalizeLangCode(code: string | null | undefined): string {
  if (typeof code !== 'string') return '';
  const upper = code.trim().toUpperCase();
  return LANG_ALIASES[upper] ?? upper;
}

/**
 * Check if a release includes all required languages.
 * Normalizes 2-letter ISO codes (e.g. "DE" → "GER"), ignores null/non-string entries
 * (warez.cx sometimes returns `[null]`), and falls back to parsing languages from
 * fulltitle when the API lang array has no valid codes.
 */
export function meetsLanguage(
  releaseLangs: readonly (string | null | undefined)[] | string | null | undefined,
  langRequired: string | readonly (string | null | undefined)[] | undefined | null,
  fulltitle?: string | null,
): boolean {
  if (!langRequired) return true;
  const rawRequired = Array.isArray(langRequired)
    ? langRequired
    : typeof langRequired === 'string'
      ? langRequired.split(',')
      : [];
  const required = rawRequired
    .map(l => normalizeLangCode(l))
    .filter(Boolean);
  if (required.length === 0) return true;

  const rawAvailable = Array.isArray(releaseLangs)
    ? releaseLangs
    : typeof releaseLangs === 'string'
      ? releaseLangs.split(',')
      : [];
  let available = rawAvailable.map(l => normalizeLangCode(l)).filter(Boolean);

  // Fallback: parse language from fulltitle when API lang is missing or contains only nulls
  if (available.length === 0 && fulltitle) {
    available = extractLangsFromFulltitle(fulltitle).map(l => normalizeLangCode(l)).filter(Boolean);
  }

  return required.every(req => available.includes(req));
}

/** Check if a release fulltitle contains all required tags (case-insensitive, AND logic) */
export function matchesTags(
  fulltitle: string | null | undefined,
  tags: string | readonly (string | null | undefined)[] | undefined | null,
): boolean {
  if (!tags) return true;
  // NocoDB may return tags as a comma-separated string or as an array
  const rawTags = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? tags.split(',')
      : [];
  const required = rawTags
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (required.length === 0) return true;
  if (typeof fulltitle !== 'string' || !fulltitle) return false;
  const ft = fulltitle.toLowerCase();
  return required.every(tag => ft.includes(tag));
}

/** Extract season number from fulltitle, e.g. "S02" or "S02E05" → 2, null if not found */
export function extractSeason(fulltitle: string | null | undefined): number | null {
  if (typeof fulltitle !== 'string' || !fulltitle) return null;
  const match = /\bS(\d{2})(?=E\d|\b)/i.exec(fulltitle);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

/** Extract episode number from fulltitle, e.g. "S02E05" → 5, null if not found or season pack */
export function extractEpisode(fulltitle: string | null | undefined): number | null {
  if (typeof fulltitle !== 'string' || !fulltitle) return null;
  const match = /\bS\d{2}E(\d{2,3})\b/i.exec(fulltitle);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

/** Returns true when a release fulltitle represents a season pack rather than an individual episode */
export function isSeasonPackFulltitle(fulltitle: string | null | undefined): boolean {
  if (typeof fulltitle !== 'string' || !fulltitle.trim()) return false;
  return extractEpisode(fulltitle) === null;
}

/** Extract season + episode as a dedup key, e.g. "S02E05" → "S02E05", "S02" → "S02", null if none */
export function extractSeasonEpisodeKey(fulltitle: string | null | undefined): string | null {
  if (typeof fulltitle !== 'string' || !fulltitle) return null;
  // Try S01E05 first
  const full = /\b(S\d{2}E\d{2,3})\b/i.exec(fulltitle);
  if (full) return full[1]!.toUpperCase();
  // Try season-only (season pack)
  const season = /\b(S\d{2})\b/i.exec(fulltitle);
  if (season) return season[1]!.toUpperCase();
  return null;
}

export interface EpisodeRange {
  season?: number;
  fromEpisode: number;
  toEpisode: number;
  episodes: number[];
}

/**
 * Format a season + episode (or episode range) into a SeasonEpisodeKey.
 * Examples:
 *   formatSeasonEpisodeKey(2, 5)       → "S02E05"
 *   formatSeasonEpisodeKey(2, 5, 5)    → "S02E05"
 *   formatSeasonEpisodeKey(2, 4, 6)    → "S02E04-E06"
 *   formatSeasonEpisodeKey(null, 4, 6) → "E04-E06"
 */
export function formatSeasonEpisodeKey(
  season: number | null | undefined,
  fromEpisode: number,
  toEpisode: number = fromEpisode,
): string {
  const seasonPrefix = season != null ? `S${String(season).padStart(2, '0')}` : '';
  const fromStr = `E${String(fromEpisode).padStart(2, '0')}`;
  if (toEpisode > fromEpisode) {
    const toStr = `E${String(toEpisode).padStart(2, '0')}`;
    return `${seasonPrefix}${fromStr}-${toStr}`;
  }
  return `${seasonPrefix}${fromStr}`;
}

/**
 * Parse a SeasonEpisodeKey (single episode or range) into an EpisodeRange.
 * Supports:
 *   "S02E04-E06" / "S02E04-06" → { season: 2, fromEpisode: 4, toEpisode: 6, episodes: [4, 5, 6] }
 *   "S02E05"                   → { season: 2, fromEpisode: 5, toEpisode: 5, episodes: [5] }
 *   "E04-E06"                  → { season: fallbackSeason, fromEpisode: 4, toEpisode: 6, episodes: [4, 5, 6] }
 *   "S02" + fallbackEpisode=5  → { season: 2, fromEpisode: 5, toEpisode: 5, episodes: [5] }
 */
export function parseEpisodeRange(
  seasonEpisodeKey: string | null | undefined,
  fallbackSeason?: number,
  fallbackEpisode?: number,
): EpisodeRange | null {
  if (seasonEpisodeKey) {
    const rangeMatch = /^(?:S(\d{2}))?E(\d{1,3})-E?(\d{1,3})$/i.exec(seasonEpisodeKey.trim());
    if (rangeMatch) {
      const season = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : fallbackSeason;
      const fromEpisode = parseInt(rangeMatch[2]!, 10);
      const toEpisode = parseInt(rangeMatch[3]!, 10);
      if (fromEpisode > 0 && toEpisode >= fromEpisode) {
        const episodes: number[] = [];
        for (let ep = fromEpisode; ep <= toEpisode; ep++) episodes.push(ep);
        return { season, fromEpisode, toEpisode, episodes };
      }
    }

    const singleMatch = /^(?:S(\d{2}))?E(\d{1,3})$/i.exec(seasonEpisodeKey.trim());
    if (singleMatch) {
      const season = singleMatch[1] ? parseInt(singleMatch[1], 10) : fallbackSeason;
      const episode = parseInt(singleMatch[2]!, 10);
      if (episode > 0) {
        return { season, fromEpisode: episode, toEpisode: episode, episodes: [episode] };
      }
    }

    const seasonOnlyMatch = /^S(\d{2})$/i.exec(seasonEpisodeKey.trim());
    if (seasonOnlyMatch && fallbackEpisode != null && fallbackEpisode > 0) {
      const season = parseInt(seasonOnlyMatch[1]!, 10);
      return { season, fromEpisode: fallbackEpisode, toEpisode: fallbackEpisode, episodes: [fallbackEpisode] };
    }
  }

  if (fallbackEpisode != null && fallbackEpisode > 0) {
    return {
      season: fallbackSeason,
      fromEpisode: fallbackEpisode,
      toEpisode: fallbackEpisode,
      episodes: [fallbackEpisode],
    };
  }

  return null;
}

/**
 * Build a regex that matches filenames/packages for ANY episode in `episodes`.
 * Uses `(?!\d)` so e.g. E04 never matches E040, and allows optional dot/underscore/dash between Sxx and Exx.
 */
export function buildEpisodesPattern(season: number | undefined, episodes: number[]): RegExp {
  const seasonStr = season != null ? `S${String(season).padStart(2, '0')}` : 'S\\d{2}';
  const episodeTokens = episodes.map(ep => (ep < 10 ? `0?${ep}` : String(ep)));
  return new RegExp(`${seasonStr}[._-]?E(?:${episodeTokens.join('|')})(?!\\d)`, 'i');
}

export interface MatchResult {
  matched: boolean;
  watchlistItem: WatchlistRow;
  reason?: string;
}

/**
 * Check if a warez release matches a watchlist item.
 * Priority: IMDB/TMDB ID exact match → normalized title match.
 */
export function matchRelease(release: WarezRelease, watchlistItem: WatchlistRow): MatchResult {
  const opts = release.entry?.options;

  // ── Type check ──────────────────────────────────────────────────────────────
  if (release.type !== watchlistItem.Type) {
    return { matched: false, watchlistItem, reason: 'type mismatch' };
  }

  // ── Quality filter ──────────────────────────────────────────────────────────
  if (!matchesQuality(release.quality, watchlistItem.Quality)) {
    return { matched: false, watchlistItem, reason: `quality ${release.quality} ≠ wanted ${watchlistItem.Quality}` };
  }

  // ── Language filter ─────────────────────────────────────────────────────────
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired, release.fulltitle)) {
    return { matched: false, watchlistItem, reason: `missing required langs ${watchlistItem.LangRequired}` };
  }

  // ── Tags filter (all tags must appear in fulltitle) ─────────────────────────
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) {
    return { matched: false, watchlistItem, reason: `missing required tags ${watchlistItem.Tags}` };
  }

  // ── Season filter (series only) ─────────────────────────────────────────────
  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) {
      return { matched: false, watchlistItem, reason: `season ${releaseSeason} ≠ wanted ${watchlistItem.Season}` };
    }
  }

  // ── ID-based match (most reliable) ──────────────────────────────────────────
  if (watchlistItem.ImdbId && opts?.imdb_id) {
    if (opts.imdb_id === watchlistItem.ImdbId) {
      return { matched: true, watchlistItem, reason: 'imdb_id match' };
    }
    return { matched: false, watchlistItem, reason: 'imdb_id mismatch' };
  }

  if (watchlistItem.TmdbId && opts?.tmdb_id) {
    if (opts.tmdb_id === watchlistItem.TmdbId) {
      return { matched: true, watchlistItem, reason: 'tmdb_id match' };
    }
    return { matched: false, watchlistItem, reason: 'tmdb_id mismatch' };
  }

  // ── Title-based match (fallback) ─────────────────────────────────────────────
  const watchTitle = normalizeTitle(watchlistItem.Title);
  const releaseTitle = normalizeTitle(release.title);
  const extractedTitle = extractTitleFromFulltitle(release.fulltitle);

  if (watchTitle && (releaseTitle === watchTitle || extractedTitle === watchTitle)) {
    return { matched: true, watchlistItem, reason: 'title match' };
  }

  // Substring match: watchlist title contained in release title (handles subtitle/year variations)
  if (
    watchTitle &&
    releaseTitle &&
    (releaseTitle.includes(watchTitle) || watchTitle.includes(releaseTitle))
  ) {
    return { matched: true, watchlistItem, reason: 'title substring match' };
  }

  return { matched: false, watchlistItem, reason: 'no title match' };
}

/** Find all watchlist items that match a given release */
export function findMatches(release: WarezRelease, watchlist: WatchlistRow[]): WatchlistRow[] {
  return watchlist
    .filter(item => matchRelease(release, item).matched);
}
