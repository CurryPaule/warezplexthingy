import type { WarezDetailRelease } from './warez/types';
import { normalizeLangCode } from './matcher';

export type DynamicRange = 'HDR' | 'SDR';
export type VideoCodecTier = '265' | '264';

export interface ReleaseProfile {
  dynamicRange: DynamicRange;
  codec?: VideoCodecTier;
  source?: string;
  group?: string;
  isDL: boolean;
}

const HDR_PATTERN = /(?:^|[\s._-])(?:HDR(?:10(?:\+|Plus)?)?|DV|DoVi|Dolby[\s._-]?Vision|HLG)(?:$|[\s._-])/i;
const CODEC_265_PATTERN = /(?:^|[\s._-])(?:[hx]\.?265|HEVC)(?:$|[\s._-])/i;
const CODEC_264_PATTERN = /(?:^|[\s._-])(?:[hx]\.?264|AVC)(?:$|[\s._-])/i;
const DL_PATTERN = /(?:^|[\s._-])(?<!WEB[\s._-])(?:DL|DUAL|MULTI)(?:$|[\s._-])/i;

/** Marker indicating where the release metadata section begins (after the show/movie title) */
const METADATA_START_PATTERN = /(?:^|[\s._-])(?:S\d{2}(?:E\d{1,3})?|(?:720|1080|2160)p|GERMAN|ENGLISH|DL|MULTI)(?:$|[\s._-])/i;

const KNOWN_SOURCES: { canonical: string; pattern: RegExp }[] = [
  { canonical: 'AMZN', pattern: /(?:^|[\s._-])AMZN(?:$|[\s._-])/i },
  { canonical: 'NF', pattern: /(?:^|[\s._-])NF(?:$|[\s._-])/i },
  { canonical: 'DSNP', pattern: /(?:^|[\s._-])DSNP(?:$|[\s._-])/i },
  { canonical: 'ATVP', pattern: /(?:^|[\s._-])ATVP(?:$|[\s._-])/i },
  { canonical: 'SKY', pattern: /(?:^|[\s._-])SKY(?:$|[\s._-])/i },
  { canonical: 'PCOK', pattern: /(?:^|[\s._-])PCOK(?:$|[\s._-])/i },
  { canonical: 'HMAX', pattern: /(?:^|[\s._-])HMAX(?:$|[\s._-])/i },
  { canonical: 'MAX', pattern: /(?:^|[\s._-])MAX(?:$|[\s._-])/i },
  { canonical: 'HULU', pattern: /(?:^|[\s._-])HULU(?:$|[\s._-])/i },
  { canonical: 'PMTP', pattern: /(?:^|[\s._-])PMTP(?:$|[\s._-])/i },
  { canonical: 'WOW', pattern: /(?:^|[\s._-])WOW(?:$|[\s._-])/i },
  { canonical: 'CR', pattern: /(?:^|[\s._-])CR(?:$|[\s._-])/i },
  { canonical: 'ARD', pattern: /(?:^|[\s._-])ARD(?:$|[\s._-])/i },
  { canonical: 'ZDF', pattern: /(?:^|[\s._-])ZDF(?:$|[\s._-])/i },
  { canonical: 'RTLP', pattern: /(?:^|[\s._-])RTLP(?:$|[\s._-])/i },
  { canonical: 'RTL', pattern: /(?:^|[\s._-])RTL(?:$|[\s._-])/i },
  { canonical: 'BluRay', pattern: /(?:^|[\s._-])Blu-?Ray(?:$|[\s._-])/i },
];

const IGNORED_GROUPS = new Set(['nogroup', 'unknown', 'none', 'n/a', '']);
const NON_GROUP_SUFFIXES = new Set(['dl', 'web', 'h264', 'h265', 'x264', 'x265', 'hevc', 'avc', 'hdr', 'dv', '1080p', '2160p', '720p']);

const CODEC_265_TOKENS = new Set(['265', 'h265', 'h.265', 'x265', 'hevc']);
const CODEC_264_TOKENS = new Set(['264', 'h264', 'h.264', 'x264', 'avc']);

/** Returns true when a watchlist row has at least one manual tag configured */
export function hasManualTags(tags: string | string[] | undefined | null): boolean {
  if (!tags) return false;
  const list = Array.isArray(tags) ? tags : tags.split(',');
  return list.some(t => t.trim().length > 0);
}

/** Extract the metadata tail of a fulltitle (after title) so title words like "Max" or "Sky" aren't misidentified as sources */
function getMetadataSection(fulltitle: string): string {
  const match = METADATA_START_PATTERN.exec(fulltitle);
  if (match && match.index !== undefined) {
    return fulltitle.slice(match.index);
  }
  return fulltitle;
}

/** Detect HDR/DV vs SDR from a release's fulltitle */
export function extractDynamicRange(fulltitle: string): DynamicRange {
  return HDR_PATTERN.test(getMetadataSection(fulltitle)) ? 'HDR' : 'SDR';
}

/** Detect video codec tier (265 vs 264) from video_codec field or fulltitle */
export function extractCodec(release: Pick<WarezDetailRelease, 'video_codec' | 'fulltitle'>): VideoCodecTier | undefined {
  const vc = release.video_codec?.trim() ?? '';
  if (vc) {
    if (/265|hevc/i.test(vc)) return '265';
    if (/264|avc/i.test(vc)) return '264';
  }
  const meta = getMetadataSection(release.fulltitle);
  if (CODEC_265_PATTERN.test(meta)) return '265';
  if (CODEC_264_PATTERN.test(meta)) return '264';
  return undefined;
}

/** Detect streaming/disc source tag from the release metadata portion of fulltitle */
export function extractSource(fulltitle: string): string | undefined {
  const meta = getMetadataSection(fulltitle);
  for (const { canonical, pattern } of KNOWN_SOURCES) {
    if (pattern.test(meta)) {
      return canonical;
    }
  }
  return undefined;
}

/** Extract release group from API group field or trailing -GROUP suffix */
export function extractGroup(release: Pick<WarezDetailRelease, 'group' | 'fulltitle'>): string | undefined {
  const apiGroup = release.group?.trim();
  if (apiGroup && !IGNORED_GROUPS.has(apiGroup.toLowerCase())) {
    return apiGroup;
  }

  const withoutExt = release.fulltitle.replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '').trim();
  const suffixMatch = /-([A-Za-z0-9]+)$/.exec(withoutExt);
  if (suffixMatch) {
    const candidate = suffixMatch[1]!;
    if (!NON_GROUP_SUFFIXES.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return undefined;
}

/** Check if release is Dual Language (GER + ENG/other or DL/DUAL/MULTI tag) */
export function isDualLanguage(release: Pick<WarezDetailRelease, 'lang' | 'fulltitle'>): boolean {
  const langs = (release.lang ?? []).map(l => normalizeLangCode(l)).filter(Boolean);
  if (langs.includes('GER') && langs.length >= 2) return true;
  return DL_PATTERN.test(getMetadataSection(release.fulltitle));
}

/** Extract the normalized release profile from a detail release */
export function extractReleaseProfile(
  release: Pick<WarezDetailRelease, 'fulltitle' | 'video_codec' | 'group' | 'lang'>,
): ReleaseProfile {
  return {
    dynamicRange: extractDynamicRange(release.fulltitle),
    codec: extractCodec(release),
    source: extractSource(release.fulltitle),
    group: extractGroup(release),
    isDL: isDualLanguage(release),
  };
}

/** Format a ReleaseProfile into a compact, human-editable AutoTags string (e.g. "HDR,265,AMZN,WAYNE") */
export function formatAutoTags(profile: ReleaseProfile): string {
  const tokens: string[] = [profile.dynamicRange];
  if (profile.codec) tokens.push(profile.codec);
  if (profile.source) tokens.push(profile.source);
  if (profile.group) tokens.push(profile.group);
  return tokens.join(',');
}

/**
 * Check if a release matches an AutoTags profile string.
 *
 * - `mode = 'strict'`: all tokens must match (DynamicRange + Codec + Source + Group + any custom tokens).
 * - `mode = 'relaxed'`: only DynamicRange (`HDR`/`SDR`) and Codec (`265`/`264`) tokens are enforced;
 *   source/group tokens are ignored (used for grace-period fallback when the pinned group stops uploading).
 */
export function matchesAutoTags(
  release: Pick<WarezDetailRelease, 'fulltitle' | 'video_codec' | 'group' | 'lang'>,
  autoTags: string | undefined | null,
  mode: 'strict' | 'relaxed' = 'strict',
): boolean {
  if (!autoTags) return true;
  const tokens = autoTags
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return true;

  const profile = extractReleaseProfile(release);
  const fulltitleLower = release.fulltitle.toLowerCase();
  const groupLower = profile.group?.toLowerCase();

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();

    if (token === 'hdr') {
      if (profile.dynamicRange !== 'HDR') return false;
      continue;
    }
    if (token === 'sdr') {
      if (profile.dynamicRange !== 'SDR') return false;
      continue;
    }
    if (CODEC_265_TOKENS.has(token)) {
      if (profile.codec !== '265') return false;
      continue;
    }
    if (CODEC_264_TOKENS.has(token)) {
      if (profile.codec !== '264') return false;
      continue;
    }

    // Source, group, and other tokens are skipped in relaxed fallback mode
    if (mode === 'relaxed') {
      continue;
    }

    // Strict check for source / group / custom token
    if (token === 'bluray') {
      if (!/blu-?ray/i.test(release.fulltitle)) return false;
      continue;
    }
    if (groupLower && groupLower === token) {
      continue;
    }
    if (!fulltitleLower.includes(token)) {
      return false;
    }
  }

  return true;
}

/**
 * Returns true if the AutoTags string contains any source/group/custom token beyond
 * DynamicRange + Codec (i.e. whether relaxed fallback can actually broaden the search).
 */
export function hasRelaxableAutoTags(autoTags: string | undefined | null): boolean {
  if (!autoTags) return false;
  const tokens = autoTags
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  return tokens.some(
    t => t !== 'hdr' && t !== 'sdr' && !CODEC_265_TOKENS.has(t) && !CODEC_264_TOKENS.has(t),
  );
}

/** Parse the most recent activity timestamp on a release (for grace-period fallback checks) */
export function getReleaseTimestampMs(
  release: Pick<WarezDetailRelease, 'episode_updated_at' | 'updated_at' | 'created_at'>,
): number | null {
  const raw = release.episode_updated_at || release.updated_at || release.created_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Returns true when the release is at least `fallbackHours` old relative to `now`.
 * Used to wait for a series's pinned group before accepting another group's upload.
 */
export function isReleaseOlderThanGracePeriod(
  release: Pick<WarezDetailRelease, 'episode_updated_at' | 'updated_at' | 'created_at'>,
  now: Date,
  fallbackHours: number,
): boolean {
  if (fallbackHours <= 0) return true;
  const ts = getReleaseTimestampMs(release);
  if (ts === null) return false;
  return now.getTime() - ts >= fallbackHours * 3_600_000;
}

/** Compute preference ladder tier: 0 = HDR, 1 = 265 (SDR), 2 = 264 (SDR), 3 = other */
export function getPreferenceLadderTier(profile: ReleaseProfile): number {
  if (profile.dynamicRange === 'HDR') return 0;
  if (profile.codec === '265') return 1;
  if (profile.codec === '264') return 2;
  return 3;
}

function getEpisodeCountSafe(release: WarezDetailRelease): number {
  const raw = release.options?.episode_count_in_season;
  if (!raw) return 0;
  const parsed = parseInt(String(raw), 10);
  return parsed > 0 ? parsed : 0;
}

/** Parse comma-separated or array preferred release group list into lowercase priority array */
export function parsePreferredGroups(raw?: string | string[] | null): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(',');
  return list.map(g => g.trim().toLowerCase()).filter(Boolean);
}

/** Rank media source quality: 0 = BluRay (BD), 1 = WEB / WEB-DL, 2 = other (BDRip, HDTV, etc.) */
export function getMediaSourceRank(
  release: Pick<WarezDetailRelease, 'video_stream' | 'fulltitle'>,
): number {
  const vs = (release.video_stream ?? '').trim().toUpperCase();
  if (vs === 'BD' || vs === 'BLURAY' || vs === 'BLU-RAY') return 0;
  if (vs === 'WEB' || vs === 'WEB-DL' || vs === 'WEBRIP') return 1;

  const meta = getMetadataSection(release.fulltitle);
  if (/(?:^|[\s._-])Blu-?Ray(?:$|[\s._-])/i.test(meta)) return 0;
  if (/(?:^|[\s._-])WEB(?:[\s._-]?(?:DL|RIP))?(?:$|[\s._-])/i.test(meta)) return 1;
  return 2;
}

/**
 * Sort releases by preference ladder (returns a new array):
 * 1. Ladder tier: HDR (0) → 265 (1) → 264 (2) → other (3)
 * 2. Dual Language (DL / multi-lang) preferred over single-language
 * 3. Codec inside HDR: 265 → 264 → other
 * 4. Preferred release group order (`PREFERRED_GROUPS`)
 * 5. Media source quality: BluRay (0) → WEB (1) → other (2)
 * 6. Higher episode_count_in_season (for series season packs)
 * 7. Higher display_priority
 * 8. Higher downloads
 */
export function sortReleasesByPreference(
  releases: WarezDetailRelease[],
  preferredGroups?: string | string[] | null,
): WarezDetailRelease[] {
  const groupPriority = parsePreferredGroups(preferredGroups);
  const groupRankMap = new Map<string, number>();
  groupPriority.forEach((g, idx) => {
    if (!groupRankMap.has(g)) groupRankMap.set(g, idx);
  });

  const decorated = releases.map((release, index) => {
    const profile = extractReleaseProfile(release);
    const groupLower = profile.group?.toLowerCase();
    const groupRank = groupLower !== undefined && groupRankMap.has(groupLower)
      ? groupRankMap.get(groupLower)!
      : Number.POSITIVE_INFINITY;

    return {
      release,
      index,
      tier: getPreferenceLadderTier(profile),
      dlScore: profile.isDL ? 0 : 1,
      codecScore: profile.codec === '265' ? 0 : profile.codec === '264' ? 1 : 2,
      groupRank,
      sourceRank: getMediaSourceRank(release),
      episodeCount: getEpisodeCountSafe(release),
      displayPriority: release.display_priority ?? 0,
      downloads: release.downloads ?? 0,
    };
  });

  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.dlScore !== b.dlScore) return a.dlScore - b.dlScore;
    if (a.codecScore !== b.codecScore) return a.codecScore - b.codecScore;
    if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
    if (a.episodeCount !== b.episodeCount) return b.episodeCount - a.episodeCount;
    if (a.displayPriority !== b.displayPriority) return b.displayPriority - a.displayPriority;
    if (a.downloads !== b.downloads) return b.downloads - a.downloads;
    return a.index - b.index;
  });

  return decorated.map(d => d.release);
}
