import { describe, it, expect, vi } from 'vitest';
import {
  groupShowFilesByVideo,
  hasActiveFiles,
  parseDownloadMetadata,
  sortDownload,
} from '../src/scrapers/sort';
import type { Config } from '../src/config';
import type { FileBrowserClient, FileBrowserItem } from '../src/filebrowser/client';
import type { NocoDbClient } from '../src/nocodb/client';
import type { MatchRow } from '../src/nocodb/types';

const TEST_CONFIG = {
  FILEBROWSER_DOWNLOAD_PATH: '/output',
  MEDIA_MOVIES_PATH: '/media/movies',
  MEDIA_SHOWS_PATH: '/media/shows',
} as Config;

function makeFile(path: string, isDir = false): FileBrowserItem {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return {
    path,
    name,
    size: 1000,
    extension: dot === -1 ? '' : name.slice(dot),
    modified: '2026-05-01T00:00:00Z',
    mode: 0,
    isDir,
    isSymlink: false,
    type: isDir ? '' : 'blob',
  };
}

function makeShowMatch(overrides: Partial<MatchRow> = {}): MatchRow & { Id: number } {
  return {
    Id: 10,
    WatchlistId: 1,
    WarezId: 1001,
    WarezUid: 'uid-lotr',
    Title: 'Der Herr der Ringe',
    Fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE',
    Type: 'series',
    Season: 2,
    Episode: 6,
    SeasonEpisodeKey: 'S02E04-E06',
    ImdbId: 'tt7631058',
    MatchedAt: '2026-05-01T00:00:00Z',
    Status: 'pushed',
    ...overrides,
  };
}

describe('sort helpers', () => {
  it('parses metadata directory names including episode ranges', () => {
    expect(parseDownloadMetadata('tt7631058-series-S02E04-E06')).toEqual({
      imdbId: 'tt7631058',
      type: 'series',
      seasonEpisodeKey: 'S02E04-E06',
    });
    expect(parseDownloadMetadata('tt1234567-movie')).toEqual({
      imdbId: 'tt1234567',
      type: 'movie',
      seasonEpisodeKey: undefined,
    });
    expect(parseDownloadMetadata('random-folder')).toBeNull();
  });

  it('detects active archive/partial/video files while ignoring samples and nfos', () => {
    expect(hasActiveFiles([makeFile('/dl/Show.S02E05.part01.rar')])).toBe(true);
    expect(hasActiveFiles([makeFile('/dl/Show.S02E05.r01')])).toBe(true);
    expect(hasActiveFiles([makeFile('/dl/Show.S02E05.part')])).toBe(true);
    expect(hasActiveFiles([makeFile('/dl/Show.S02E06.mkv')])).toBe(true);
    expect(hasActiveFiles([makeFile('/dl/Sample/sample.mkv'), makeFile('/dl/release.nfo')])).toBe(false);
    expect(hasActiveFiles([])).toBe(false);
  });

  it('pairs subtitles to their specific episodes across subdirectories and flat folders', () => {
    const v4 = makeFile('/dl/Show.S02E04/Show.S02E04.mkv');
    const v5 = makeFile('/dl/Show.S02E05/Show.S02E05.mkv');
    const v6 = makeFile('/dl/Show.S02E06.mkv');
    const s4 = makeFile('/dl/Show.S02E04/Subs/German.srt');
    const s5 = makeFile('/dl/Show.S02E05/Subs/German.srt');

    const { groups, unmatchedSubtitles } = groupShowFilesByVideo([v4, v5, v6], [s4, s5]);
    expect(unmatchedSubtitles).toEqual([]);
    expect(groups).toEqual([
      { video: v4, subtitles: [s4] },
      { video: v5, subtitles: [s5] },
      { video: v6, subtitles: [] },
    ]);
  });
});

describe('sortDownload — multi-episode sorting & safe cleanup', () => {
  it('moves ALL episodes in a multi-episode folder without collisions (mix of episodes with and without subs)', async () => {
    const files = [
      makeFile('/output/tt7631058-series-S02E04-E06/Show.S02E04/Show.S02E04.mkv'),
      makeFile('/output/tt7631058-series-S02E04-E06/Show.S02E04/Subs/German.srt'),
      makeFile('/output/tt7631058-series-S02E04-E06/Show.S02E05/Show.S02E05.mkv'),
      makeFile('/output/tt7631058-series-S02E04-E06/Show.S02E05/Subs/German.srt'),
      makeFile('/output/tt7631058-series-S02E04-E06/Show.S02E06/Show.S02E06.mkv'),
    ];

    let listCall = 0;
    const fbMocks = {
      listDirRecursive: vi.fn(async () => (listCall++ === 0 ? files : [])),
      listDir: vi.fn(async () => []),
      createDir: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchByImdbIdAndEpisode: vi.fn(async () => makeShowMatch()),
      getMatchByImdbId: vi.fn(async () => makeShowMatch()),
      updateMatchRelease: vi.fn(async () => {}),
    };

    const result = await sortDownload(
      fbMocks as unknown as FileBrowserClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      'tt7631058-series-S02E04-E06',
      '/output/tt7631058-series-S02E04-E06',
    );

    expect(result.success).toBe(true);
    expect(result.movedFiles).toEqual([
      '/media/shows/Der Herr Der Ringe/S02/Show.S02E04/Show.S02E04.mkv',
      '/media/shows/Der Herr Der Ringe/S02/Show.S02E04/subs/German.srt',
      '/media/shows/Der Herr Der Ringe/S02/Show.S02E05/Show.S02E05.mkv',
      '/media/shows/Der Herr Der Ringe/S02/Show.S02E05/subs/German.srt',
      '/media/shows/Der Herr Der Ringe/S02/Show.S02E06.mkv',
    ]);
    // Must delete downloadDir, and MUST NOT delete /output (baseDownloadPath)
    expect(fbMocks.delete).toHaveBeenCalledTimes(1);
    expect(fbMocks.delete).toHaveBeenCalledWith('/output/tt7631058-series-S02E04-E06');
  });

  it('does NOT delete downloadDir if sibling episode archives/downloads are still present', async () => {
    const initialFiles = [
      makeFile('/output/tt7631058-series-S02E04-E06/Pack/Show.S02E04.mkv'),
      makeFile('/output/tt7631058-series-S02E04-E06/Pack/Show.S02E05.part01.rar'),
      makeFile('/output/tt7631058-series-S02E04-E06/Pack/Show.S02E06.part01.rar'),
    ];
    const remainingFiles = [
      makeFile('/output/tt7631058-series-S02E04-E06/Pack/Show.S02E05.part01.rar'),
      makeFile('/output/tt7631058-series-S02E04-E06/Pack/Show.S02E06.part01.rar'),
    ];

    let listCall = 0;
    const fbMocks = {
      listDirRecursive: vi.fn(async () => (listCall++ === 0 ? initialFiles : remainingFiles)),
      listDir: vi.fn(async () => []),
      createDir: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchByImdbIdAndEpisode: vi.fn(async () => makeShowMatch()),
      getMatchByImdbId: vi.fn(async () => makeShowMatch()),
      updateMatchRelease: vi.fn(async () => {}),
    };

    const result = await sortDownload(
      fbMocks as unknown as FileBrowserClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      'tt7631058-series-S02E04-E06',
      '/output/tt7631058-series-S02E04-E06/Pack',
    );

    expect(result.success).toBe(true);
    expect(result.movedFiles).toEqual(['/media/shows/Der Herr Der Ringe/S02/Show.S02E04.mkv']);
    // Must NOT delete Pack/ while E05 & E06 archives are still in it!
    expect(fbMocks.delete).not.toHaveBeenCalled();
  });

  it('sorts a movie by renaming to Fulltitle and skipping sample files', async () => {
    const movieMatch: MatchRow & { Id: number } = {
      Id: 20,
      WatchlistId: 2,
      WarezId: 2001,
      WarezUid: 'uid-movie',
      Title: 'Inception',
      Fulltitle: 'Inception.2010.German.DL.1080p.BluRay.x264-GRP',
      Type: 'movie',
      ImdbId: 'tt1375666',
      MatchedAt: '2026-05-01T00:00:00Z',
      Status: 'pushed',
    };

    const files = [
      makeFile('/output/tt1375666-movie/Release/inception.mkv'),
      makeFile('/output/tt1375666-movie/Release/Sample/inception-sample.mkv'),
      makeFile('/output/tt1375666-movie/Release/Subs/German.srt'),
    ];
    const remaining = [
      makeFile('/output/tt1375666-movie/Release/Sample/inception-sample.mkv'),
    ];

    let listCall = 0;
    const fbMocks = {
      listDirRecursive: vi.fn(async () => (listCall++ === 0 ? files : remaining)),
      listDir: vi.fn(async () => []),
      createDir: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchByImdbIdAndEpisode: vi.fn(async () => null),
      getMatchByImdbId: vi.fn(async () => movieMatch),
      updateMatchRelease: vi.fn(async () => {}),
    };

    const result = await sortDownload(
      fbMocks as unknown as FileBrowserClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      'tt1375666-movie',
      '/output/tt1375666-movie/Release',
    );

    expect(result.success).toBe(true);
    expect(result.movedFiles).toEqual([
      '/media/movies/Inception (2010)/Inception.2010.German.DL.1080p.BluRay.x264-GRP.mkv',
      '/media/movies/Inception (2010)/German.srt',
    ]);
    // Both Release/ and empty parent tt1375666-movie/ cleaned up
    expect(fbMocks.delete).toHaveBeenCalledWith('/output/tt1375666-movie/Release');
    expect(fbMocks.delete).toHaveBeenCalledWith('/output/tt1375666-movie');
  });
});
