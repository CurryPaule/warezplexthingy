import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { FileBrowserClient, FileBrowserItem } from '../filebrowser/client';
import type { Config } from '../config';
import {
  extractEpisode,
  extractSeasonEpisodeKey,
  extractTitleFromFulltitle,
} from '../matcher';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.flv', '.mov', '.ts']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.sub', '.ass', '.ssa', '.vtt', '.idx']);
const ARCHIVE_OR_TEMP_EXTENSIONS = new Set(['.rar', '.zip', '.7z', '.part', '.jd2', '.tmp', '.crdownload']);
const SPLIT_RAR_EXT_PATTERN = /^\.r\d{2}$/i;

export interface DownloadMetadata {
  imdbId: string;
  type: 'movie' | 'series';
  seasonEpisodeKey?: string; // e.g. "S02E05", "S02E04-E06", or "S02"
}

export interface SortResult {
  success: boolean;
  movedFiles: string[];
  destination: string;
  error?: string;
}

export interface VideoWithSubtitles {
  video: FileBrowserItem;
  subtitles: FileBrowserItem[];
}

/**
 * Parse metadata from a download directory name.
 * Expected format: {imdbId}-{type}[-{seasonEpisodeKey}]
 * Examples:
 *   tt1234567-movie
 *   tt0903747-series-S02E05
 *   tt0903747-series-S02E04-E06
 *   tt0903747-series-S02
 */
export function parseDownloadMetadata(dirName: string): DownloadMetadata | null {
  const match = /^(tt\d+)-(movie|series)(?:-(.+))?$/.exec(dirName);
  if (!match) return null;

  return {
    imdbId: match[1]!,
    type: match[2]! as 'movie' | 'series',
    seasonEpisodeKey: match[3] || undefined,
  };
}

/**
 * Extract the year from a fulltitle.
 * e.g. "Movie.Title.2024.German.DL.1080p" → 2024
 */
function extractYear(fulltitle: string | null | undefined): number | null {
  if (typeof fulltitle !== 'string' || !fulltitle) return null;
  const match = /\b((?:19|20)\d{2})\b/.exec(fulltitle);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Build a clean display title from a fulltitle.
 * Extracts the title portion and capitalizes words.
 * e.g. "breaking bad" → "Breaking Bad"
 */
function titleCase(title: string): string {
  return title
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? filename : filename.slice(0, lastDot);
}

function parentDirOf(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash <= 0 ? '' : normalized.slice(0, lastSlash);
}

function isVideoFile(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(filename));
}

function isSubtitleFile(filename: string): boolean {
  return SUBTITLE_EXTENSIONS.has(getExtension(filename));
}

function isArchiveOrTempFile(filename: string): boolean {
  const ext = getExtension(filename);
  return ARCHIVE_OR_TEMP_EXTENSIONS.has(ext) || SPLIT_RAR_EXT_PATTERN.test(ext);
}

/**
 * Extract season directory from a SeasonEpisodeKey.
 * e.g. "S02E05" → "S02", "S02E04-E06" → "S02", "S02" → "S02"
 */
function extractSeasonDir(key: string): string {
  const match = /^(S\d{2})/i.exec(key);
  return match ? match[1]!.toUpperCase() : key;
}

/**
 * Build the destination path for a movie.
 * Format: {moviesPath}/{Title (year)}
 */
export function buildMovieDestination(
  moviesPath: string,
  matchRecord: MatchRow,
): string {
  const cleanTitle = titleCase(extractTitleFromFulltitle(matchRecord.Fulltitle));
  const year = extractYear(matchRecord.Fulltitle);
  const dirName = year ? `${cleanTitle} (${year})` : cleanTitle;
  return `${moviesPath}/${dirName}`;
}

/**
 * Build the destination path for a TV show season.
 * Format: {showsPath}/{Title (year)}/{S01}
 */
export function buildShowDestination(
  showsPath: string,
  matchRecord: MatchRow,
  seasonEpisodeKey?: string,
): string {
  const cleanTitle = titleCase(extractTitleFromFulltitle(matchRecord.Fulltitle));
  const year = extractYear(matchRecord.Fulltitle);
  const dirName = year ? `${cleanTitle} (${year})` : cleanTitle;

  const seasonDir = seasonEpisodeKey
    ? extractSeasonDir(seasonEpisodeKey)
    : (matchRecord.Season ? `S${String(matchRecord.Season).padStart(2, '0')}` : 'S01');

  return `${showsPath}/${dirName}/${seasonDir}`;
}

/**
 * Check if a file is a sample (common in movie releases — should be skipped).
 * Matches files with "sample" in the name or inside a "sample" directory.
 */
function isSampleFile(item: FileBrowserItem): boolean {
  const pathLower = item.path.toLowerCase();
  const nameLower = item.name.toLowerCase();
  return nameLower.includes('sample') || pathLower.includes('/sample/');
}

/**
 * Categorize files from a download directory into video files and subtitle files.
 * Subtitles can be next to video files or in a subs/ subdirectory.
 * Sample files are excluded.
 */
export function categorizeFiles(items: FileBrowserItem[]): {
  videos: FileBrowserItem[];
  subtitles: FileBrowserItem[];
} {
  const videos: FileBrowserItem[] = [];
  const subtitles: FileBrowserItem[] = [];

  for (const item of items) {
    if (isSampleFile(item)) continue;

    if (isVideoFile(item.name)) {
      videos.push(item);
    } else if (isSubtitleFile(item.name)) {
      subtitles.push(item);
    }
  }

  return { videos, subtitles };
}

/**
 * Check whether remaining files in a download directory still include active videos,
 * archives, or partial downloads (e.g. sibling episodes still being downloaded/extracted).
 */
export function hasActiveFiles(items: FileBrowserItem[]): boolean {
  return items.some(item => {
    if (item.isDir) return false;
    if (isArchiveOrTempFile(item.name)) return true;
    if (isVideoFile(item.name) && !isSampleFile(item)) return true;
    return false;
  });
}

/**
 * Pair subtitles with their corresponding episode video so multi-episode folders
 * never collide on subtitle filenames or dump different episodes into one folder.
 */
export function groupShowFilesByVideo(
  videos: FileBrowserItem[],
  subtitles: FileBrowserItem[],
): { groups: VideoWithSubtitles[]; unmatchedSubtitles: FileBrowserItem[] } {
  const groups: VideoWithSubtitles[] = videos.map(video => ({ video, subtitles: [] }));
  const unmatchedSubtitles: FileBrowserItem[] = [];

  if (subtitles.length === 0) {
    return { groups, unmatchedSubtitles };
  }

  if (groups.length === 1) {
    groups[0]!.subtitles.push(...subtitles);
    return { groups, unmatchedSubtitles };
  }

  const videoMeta = groups.map(group => ({
    group,
    dir: parentDirOf(group.video.path),
    stemLower: stripExtension(group.video.name).toLowerCase(),
    epKey: extractSeasonEpisodeKey(group.video.name) ?? extractSeasonEpisodeKey(group.video.path),
  }));

  for (const sub of subtitles) {
    // 1. Deepest ancestor directory match (e.g. /dl/Show.S02E04/Subs/de.srt → /dl/Show.S02E04/Show.S02E04.mkv)
    const dirCandidates = videoMeta.filter(v => v.dir && sub.path.startsWith(`${v.dir}/`));
    let pool = videoMeta;
    if (dirCandidates.length > 0) {
      const maxLen = Math.max(...dirCandidates.map(v => v.dir.length));
      const deepest = dirCandidates.filter(v => v.dir.length === maxLen);
      if (deepest.length === 1) {
        deepest[0]!.group.subtitles.push(sub);
        continue;
      }
      pool = deepest;
    }

    // 2. Filename stem prefix match (e.g. Show.S02E04.de.srt → Show.S02E04.mkv)
    const subStemLower = stripExtension(sub.name).toLowerCase();
    const stemMatch = pool.find(v => subStemLower.startsWith(v.stemLower));
    if (stemMatch) {
      stemMatch.group.subtitles.push(sub);
      continue;
    }

    // 3. Episode key match (e.g. both contain S02E04)
    const subEpKey = extractSeasonEpisodeKey(sub.name) ?? extractSeasonEpisodeKey(sub.path);
    if (subEpKey) {
      const epMatch = pool.find(v => v.epKey && v.epKey === subEpKey);
      if (epMatch) {
        epMatch.group.subtitles.push(sub);
        continue;
      }
    }

    unmatchedSubtitles.push(sub);
  }

  return { groups, unmatchedSubtitles };
}

/**
 * Derive a clean per-episode directory name when a TV episode has subtitles.
 * Prefers the video's own filename stem so multi-episode season packs never clash.
 */
function resolveEpisodeDirName(
  video: FileBrowserItem,
  totalVideos: number,
  matchRecord: MatchRow,
  fallbackKey: string,
): string {
  const videoStem = stripExtension(video.name);
  if (totalVideos > 1 || extractSeasonEpisodeKey(videoStem) != null) {
    return videoStem || fallbackKey;
  }

  if (matchRecord.Fulltitle && extractEpisode(matchRecord.Fulltitle) != null) {
    return cleanEpisodeDirName(matchRecord.Fulltitle, fallbackKey);
  }

  return videoStem || cleanEpisodeDirName(matchRecord.Fulltitle || '', fallbackKey);
}

/**
 * Sort a completed download into the correct Plex/Jellyfin directory.
 *
 * For movies:
 *   {moviesPath}/Movie Title (year)/full.release.name.mkv
 *
 * For TV shows without subtitles:
 *   {showsPath}/Show Title (year)/S01/episode.video.mkv
 *
 * For TV shows with subtitles (per episode):
 *   {showsPath}/Show Title (year)/S01/{EpisodeDir}/episode.video.mkv
 *   {showsPath}/Show Title (year)/S01/{EpisodeDir}/subs/subtitle.srt
 */
export async function sortDownload(
  fb: FileBrowserClient,
  nocodb: NocoDbClient,
  config: Config,
  downloadDirName: string,
  scanPath?: string,
): Promise<SortResult> {
  const moviesPath = config.MEDIA_MOVIES_PATH?.replace(/\/+$/, '');
  const showsPath = config.MEDIA_SHOWS_PATH?.replace(/\/+$/, '');
  if (!moviesPath || !showsPath) {
    return { success: false, movedFiles: [], destination: '', error: 'MEDIA_MOVIES_PATH and MEDIA_SHOWS_PATH must be configured' };
  }

  // Parse metadata from directory name
  const metadata = parseDownloadMetadata(downloadDirName);
  if (!metadata) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `Cannot parse metadata from directory name: "${downloadDirName}". Expected format: {imdbId}-{type}[-{seasonEpisodeKey}]`,
    };
  }

  // Determine the directory to scan for files
  const baseDownloadPath = config.FILEBROWSER_DOWNLOAD_PATH?.replace(/\/+$/, '');
  const downloadDir = scanPath || (baseDownloadPath ? `${baseDownloadPath}/${downloadDirName}` : '');
  if (!downloadDir) {
    return { success: false, movedFiles: [], destination: '', error: 'No scan path and FILEBROWSER_DOWNLOAD_PATH not configured' };
  }

  console.log(`  📂 Sorting download: ${downloadDir}`);
  console.log(`     IMDB: ${metadata.imdbId}, Type: ${metadata.type}, Key: ${metadata.seasonEpisodeKey || 'n/a'}`);

  // Look up match in NocoDB
  let matchRecord: (MatchRow & { Id: number }) | null = null;
  if (metadata.seasonEpisodeKey) {
    matchRecord = await nocodb.getMatchByImdbIdAndEpisode(metadata.imdbId, metadata.seasonEpisodeKey);
  }
  // Fallback to just IMDB ID
  matchRecord ??= await nocodb.getMatchByImdbId(metadata.imdbId);

  if (!matchRecord) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `No match found in NocoDB for IMDB ID: ${metadata.imdbId}`,
    };
  }

  console.log(`     Match found: "${matchRecord.Fulltitle}" (ID: ${matchRecord.Id})`);

  // List all files in the download directory recursively
  const allFiles = await fb.listDirRecursive(downloadDir);
  const { videos, subtitles } = categorizeFiles(allFiles);

  if (videos.length === 0) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `No video files found in ${downloadDir}`,
    };
  }

  console.log(`     Found ${videos.length} video(s), ${subtitles.length} subtitle(s)`);

  // Determine destination
  const destination = metadata.type === 'movie'
    ? buildMovieDestination(moviesPath, matchRecord)
    : buildShowDestination(showsPath, matchRecord, metadata.seasonEpisodeKey);

  const movedFiles: string[] = [];

  if (metadata.type === 'movie') {
    // Movies: create the movie dir, rename video to fulltitle, move video + subs
    await fb.createDir(destination);

    for (const video of videos) {
      const ext = getExtension(video.name);
      const renamedName = `${matchRecord.Fulltitle}${ext}`;
      const dest = `${destination}/${renamedName}`;
      await fb.move(video.path, dest);
      movedFiles.push(dest);
      console.log(`     ✅ Moved: ${video.name} → ${renamedName}`);
    }

    for (const sub of subtitles) {
      const dest = `${destination}/${sub.name}`;
      await fb.move(sub.path, dest);
      movedFiles.push(dest);
      console.log(`     ✅ Moved subtitle: ${sub.name}`);
    }
  } else {
    // TV shows: pair subtitles per video so multi-episode batches sort cleanly without collisions
    const { groups, unmatchedSubtitles } = groupShowFilesByVideo(videos, subtitles);
    const fallbackKey = metadata.seasonEpisodeKey || matchRecord.SeasonEpisodeKey || 'unknown';
    let createdSeasonDir = false;

    for (const { video, subtitles: videoSubs } of groups) {
      if (videoSubs.length === 0) {
        if (!createdSeasonDir) {
          await fb.createDir(destination);
          createdSeasonDir = true;
        }
        const dest = `${destination}/${video.name}`;
        await fb.move(video.path, dest);
        movedFiles.push(dest);
        console.log(`     ✅ Moved: ${video.name}`);
      } else {
        const episodeDirName = resolveEpisodeDirName(video, videos.length, matchRecord, fallbackKey);
        const episodePath = `${destination}/${episodeDirName}`;
        const subsPath = `${episodePath}/subs`;

        await fb.createDir(episodePath);
        await fb.createDir(subsPath);

        const videoDest = `${episodePath}/${video.name}`;
        await fb.move(video.path, videoDest);
        movedFiles.push(videoDest);
        console.log(`     ✅ Moved: ${video.name} → ${episodeDirName}/`);

        for (const sub of videoSubs) {
          const subDest = `${subsPath}/${sub.name}`;
          await fb.move(sub.path, subDest);
          movedFiles.push(subDest);
          console.log(`     ✅ Moved subtitle: ${sub.name}`);
        }
      }
    }

    if (unmatchedSubtitles.length > 0) {
      const sharedSubsPath = `${destination}/subs`;
      await fb.createDir(sharedSubsPath);
      for (const sub of unmatchedSubtitles) {
        const subDest = `${sharedSubsPath}/${sub.name}`;
        await fb.move(sub.path, subDest);
        movedFiles.push(subDest);
        console.log(`     ✅ Moved subtitle: ${sub.name}`);
      }
    }
  }

  // Update match status to processed
  await nocodb.updateMatchRelease(matchRecord.Id, {
    Status: 'processed',
  });
  console.log(`     📋 Updated match status to "processed"`);

  // Clean up source directory ONLY if no active media/archive/partial files remain
  // (e.g. sibling episodes from a multi-episode season pack still downloading or extracting)
  try {
    const remainingFiles = await fb.listDirRecursive(downloadDir);
    if (hasActiveFiles(remainingFiles)) {
      console.log(`     ⏳ Keeping source directory (other videos/archives still present): ${downloadDir}`);
    } else {
      await fb.delete(downloadDir);
      console.log(`     🗑️ Cleaned up source directory: ${downloadDir}`);

      // Also try to clean up the metadata parent dir if it's now empty (never delete baseDownloadPath itself)
      const parentDir = parentDirOf(downloadDir);
      if (parentDir && parentDir !== downloadDir && parentDir !== baseDownloadPath) {
        try {
          const remaining = await fb.listDir(parentDir);
          if (remaining.length === 0) {
            await fb.delete(parentDir);
            console.log(`     🗑️ Cleaned up metadata directory: ${parentDir}`);
          }
        } catch {
          // Parent dir cleanup is best-effort
        }
      }
    }
  } catch {
    console.log(`     ⚠ Could not clean up source directory: ${downloadDir}`);
  }

  return { success: true, movedFiles, destination };
}

/**
 * Build a clean episode directory name.
 */
function cleanEpisodeDirName(fulltitle: string | null | undefined, fallbackKey: string): string {
  const cleaned = (typeof fulltitle === 'string' ? fulltitle : '').replace(/\.(mkv|mp4|avi|m4v|wmv|flv|mov|ts)$/i, '');
  return cleaned || fallbackKey;
}
