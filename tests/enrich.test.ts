import { describe, it, expect, vi } from 'vitest';
import { runEnrichScraper } from '../src/scrapers/enrich';
import type { Config } from '../src/config';
import type { NocoDbClient } from '../src/nocodb/client';
import type { MatchRow, WatchlistRow } from '../src/nocodb/types';
import type { WarezClient } from '../src/warez/api';
import type { WarezDetailRelease } from '../src/warez/types';

const TEST_CONFIG = {
  SEARCH_DELAY_MS: 0,
  AUTOTAGS_FALLBACK_HOURS: 48,
} as Config;

const noopSleep = async () => {};
const alwaysOnline = async () => true;

function makeRelease(overrides: Partial<WarezDetailRelease> = {}): WarezDetailRelease {
  return {
    id: 1001,
    uid: 'rel-uuid-1',
    user_id: 42,
    entry_id: 99,
    title: 'Der Herr der Ringe',
    fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE',
    type: 'series',
    sub_type: 'series',
    links: { ddownload: ['https://ddownload.com/file1'] },
    crypted_links: { ddownload: 'https://hide.cx/container/abc' },
    size: 20_000_000_000,
    parts: 20,
    group: 'WAYNE',
    quality: '1080p',
    video_stream: 'WEB',
    video_codec: 'H264',
    audio_stream: null,
    bitrate: null,
    lang: ['GER', 'ENG'],
    downloads: 100,
    source: 'web',
    options: {
      check: { ddownload: 'https://hide.cx/state/abc' },
      episode_count_in_season: '6',
    },
    created_at: '2026-05-01T12:00:00Z',
    updated_at: '2026-05-01T12:00:00Z',
    deleted_at: null,
    episode_updated_at: null,
    has_new_episode: true,
    display_priority: 1,
    ...overrides,
  };
}

function makeWatchlistItem(overrides: Partial<WatchlistRow> = {}): WatchlistRow & { Id: number } {
  return {
    Id: 1,
    Title: 'Der Herr der Ringe',
    Type: 'series',
    ImdbId: 'tt7631058',
    Active: 1,
    DeactivateOnMatch: 0,
    Quality: '1080p',
    LangRequired: 'GER,ENG',
    Season: 2,
    LastEpisodeFound: 0,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchRow> = {}): MatchRow & { Id: number } {
  return {
    Id: 10,
    WatchlistId: 1,
    WarezId: 500,
    WarezUid: 'uid-lotr',
    Title: 'Der Herr der Ringe',
    Fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE',
    Type: 'series',
    Season: 2,
    Episode: 4,
    SeasonEpisodeKey: 'S02E01-E04',
    ImdbId: 'tt7631058',
    TmdbId: 84773,
    MatchedAt: '2026-05-01T00:00:00Z',
    Status: 'processed',
    ...overrides,
  };
}

function createMocks(params: {
  foundMatches?: (MatchRow & { Id: number })[];
  recheckSeries?: (MatchRow & { Id: number })[];
  watchlist?: Record<number, WatchlistRow & { Id: number }>;
  releasesByUid?: Record<string, WarezDetailRelease[]>;
}) {
  const nocodb = {
    getMatchesByStatus: vi.fn(async () => params.foundMatches ?? []),
    getSeriesMatchesForRecheck: vi.fn(async () => params.recheckSeries ?? []),
    getWatchlistItemById: vi.fn(async (id: number) => params.watchlist?.[id] ?? null),
    updateMatchRelease: vi.fn(async () => {}),
    upsertMatch: vi.fn(async () => true),
    updateWatchlistLastMatched: vi.fn(async () => {}),
    updateWatchlistEpisode: vi.fn(async () => {}),
    updateWatchlistAutoTags: vi.fn(async () => {}),
    deactivateWatchlistItem: vi.fn(async () => {}),
  };

  const warez = {
    fetchEntryDetail: vi.fn(async (uid: string) => ({
      releases: params.releasesByUid?.[uid] ?? [],
    })),
  };

  return {
    nocodb: nocodb as unknown as NocoDbClient,
    nocodbMocks: nocodb,
    warez: warez as unknown as WarezClient,
    warezMocks: warez,
  };
}

describe('runEnrichScraper — multi-episode season packs', () => {
  it('encodes full episode range S02E01-E04 on initial enrichment when 4 episodes are already out', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      foundMatches: [
        makeMatch({
          Status: 'found',
          Fulltitle: 'Der Herr der Ringe',
          Season: undefined,
          Episode: undefined,
          SeasonEpisodeKey: undefined,
        }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 0 }) },
      releasesByUid: {
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '4' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Season: 2,
        Episode: 4,
        SeasonEpisodeKey: 'S02E01-E04',
        Status: 'matched',
      }),
    );
    expect(nocodbMocks.updateWatchlistEpisode).toHaveBeenCalledWith(1, 4);
  });

  it('encodes newly released block S02E05-E06 when re-checking after episode 4 (LOTR scenario)', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({ Status: 'processed', Episode: 4, SeasonEpisodeKey: 'S02E01-E04' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 4 }) },
      releasesByUid: {
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '6' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Season: 2,
        Episode: 6,
        SeasonEpisodeKey: 'S02E05-E06',
        Status: 'matched',
      }),
    );
    expect(nocodbMocks.updateWatchlistEpisode).toHaveBeenCalledWith(1, 6);
  });

  it('detects episodes to re-download when user lowers LastEpisodeFound in watchlist (even if match.Episode is still higher)', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({ Status: 'processed', Episode: 6, SeasonEpisodeKey: 'S02E06' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 4 }) },
      releasesByUid: {
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '6' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Episode: 6,
        SeasonEpisodeKey: 'S02E05-E06',
        Status: 'matched',
      }),
    );
    expect(nocodbMocks.updateWatchlistEpisode).toHaveBeenCalledWith(1, 6);
  });

  it('encodes 10 new episodes S02E03-E12 when jumping from E02 to E12', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({ Status: 'pushed', Episode: 2, SeasonEpisodeKey: 'S02E01-E02' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 2 }) },
      releasesByUid: {
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '12' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Episode: 12,
        SeasonEpisodeKey: 'S02E03-E12',
        Status: 'matched',
      }),
    );
  });

  it('encodes single episode S02E07 when only 1 new episode dropped', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({ Status: 'processed', Episode: 6, SeasonEpisodeKey: 'S02E05-E06' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 6 }) },
      releasesByUid: {
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '7' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Episode: 7,
        SeasonEpisodeKey: 'S02E07',
        Status: 'matched',
      }),
    );
  });

  it('preserves unpushed range start when enrich runs again before push', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        // Still 'matched' (not pushed yet!) covering E05-E06
        makeMatch({ Status: 'matched', Episode: 6, SeasonEpisodeKey: 'S02E05-E06' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 6 }) },
      releasesByUid: {
        // Before push ran, E07 and E08 also dropped
        'uid-lotr': [makeRelease({ options: { episode_count_in_season: '8' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        Episode: 8,
        SeasonEpisodeKey: 'S02E05-E08',
        Status: 'matched',
      }),
    );
  });

  it('prefers online season pack with highest episode count and skips offline mirrors', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [makeMatch({ Status: 'processed', Episode: 4 })],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 4 }) },
      releasesByUid: {
        'uid-lotr': [
          makeRelease({
            id: 1,
            options: { check: { ddownload: 'https://hide.cx/state/ep5' }, episode_count_in_season: '5' },
          }),
          makeRelease({
            id: 2,
            options: { check: { ddownload: 'https://hide.cx/state/ep8-offline' }, episode_count_in_season: '8' },
          }),
          makeRelease({
            id: 3,
            options: { check: { ddownload: 'https://hide.cx/state/ep8-online' }, episode_count_in_season: '8' },
          }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: async (url) => !url.includes('offline'),
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        WarezId: 3,
        Episode: 8,
        SeasonEpisodeKey: 'S02E05-E08',
      }),
    );
  });

  it('does not let Season 1 (10 eps) overwrite Season 2 (4 eps) when watchlist Season is null', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [makeMatch({ Status: 'processed', Season: 2, Episode: 4 })],
      watchlist: { 1: makeWatchlistItem({ Season: undefined, LastEpisodeFound: 4 }) },
      releasesByUid: {
        'uid-lotr': [
          makeRelease({
            id: 10,
            fulltitle: 'Der.Herr.der.Ringe.S01.GERMAN.DL.1080P.WEB.H264-WAYNE',
            options: { episode_count_in_season: '10' },
          }),
          makeRelease({
            id: 11,
            fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE',
            options: { episode_count_in_season: '4' },
          }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
  });
});

describe('runEnrichScraper — individual episode uploads', () => {
  it('matches ALL newly released individual episodes (E04, E05, E06), not just the highest one', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({
          Id: 10,
          Fulltitle: 'Der.Herr.der.Ringe.S02E03.GERMAN.DL.1080P.WEB.H264-WAYNE',
          Season: 2,
          Episode: 3,
          SeasonEpisodeKey: 'S02E03',
          Status: 'processed',
        }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 3 }) },
      releasesByUid: {
        'uid-lotr': [
          // Unordered (newest first, including older episodes)
          makeRelease({ id: 106, fulltitle: 'Der.Herr.der.Ringe.S02E06.GERMAN.DL.1080P.WEB.H264-WAYNE', options: {} }),
          makeRelease({ id: 105, fulltitle: 'Der.Herr.der.Ringe.S02E05.GERMAN.DL.1080P.WEB.H264-WAYNE', options: {} }),
          makeRelease({ id: 104, fulltitle: 'Der.Herr.der.Ringe.S02E04.GERMAN.DL.1080P.WEB.H264-WAYNE', options: {} }),
          makeRelease({ id: 103, fulltitle: 'Der.Herr.der.Ringe.S02E03.GERMAN.DL.1080P.WEB.H264-WAYNE', options: {} }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.upsertMatch).toHaveBeenCalledTimes(3);
    const keys = nocodbMocks.upsertMatch.mock.calls.map(c => (c[0] as MatchRow).SeasonEpisodeKey);
    expect(keys).toEqual(['S02E04', 'S02E05', 'S02E06']);
    expect(nocodbMocks.updateWatchlistEpisode).toHaveBeenCalledWith(1, 6);
  });

  it('uses highest episode across multiple existing individual matches during recheck (no duplicates)', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [
        makeMatch({ Id: 10, Fulltitle: 'Show.S02E04.GERMAN.DL.1080p', Season: 2, Episode: 4, SeasonEpisodeKey: 'S02E04', Status: 'processed' }),
        makeMatch({ Id: 11, Fulltitle: 'Show.S02E05.GERMAN.DL.1080p', Season: 2, Episode: 5, SeasonEpisodeKey: 'S02E05', Status: 'processed' }),
        makeMatch({ Id: 12, Fulltitle: 'Show.S02E06.GERMAN.DL.1080p', Season: 2, Episode: 6, SeasonEpisodeKey: 'S02E06', Status: 'processed' }),
      ],
      watchlist: { 1: makeWatchlistItem({ LastEpisodeFound: 6 }) },
      releasesByUid: {
        'uid-lotr': [
          makeRelease({ id: 104, fulltitle: 'Show.S02E04.GERMAN.DL.1080p', options: {} }),
          makeRelease({ id: 105, fulltitle: 'Show.S02E05.GERMAN.DL.1080p', options: {} }),
          makeRelease({ id: 106, fulltitle: 'Show.S02E06.GERMAN.DL.1080p', options: {} }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.upsertMatch).not.toHaveBeenCalled();
    expect(nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
  });
});

describe('runEnrichScraper — movies', () => {
  it('enriches a movie and deactivates watchlist item when DeactivateOnMatch is set', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      foundMatches: [
        makeMatch({
          Id: 20,
          WatchlistId: 2,
          WarezUid: 'uid-movie',
          Title: 'Inception',
          Fulltitle: 'Inception',
          Type: 'movie',
          Season: undefined,
          Episode: undefined,
          SeasonEpisodeKey: undefined,
          Status: 'found',
        }),
      ],
      watchlist: {
        2: makeWatchlistItem({
          Id: 2,
          Title: 'Inception',
          Type: 'movie',
          DeactivateOnMatch: 1,
          Season: undefined,
        }),
      },
      releasesByUid: {
        'uid-movie': [
          makeRelease({
            id: 999,
            type: 'movie',
            fulltitle: 'Inception.2010.GERMAN.DL.1080p.BluRay.x264-GRP',
            options: {},
          }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ WarezId: 999, Status: 'matched' }),
    );
    expect(nocodbMocks.deactivateWatchlistItem).toHaveBeenCalledWith(2);
  });
});

describe('runEnrichScraper — inactive watchlist gating', () => {
  it('skips series re-checks and found matches when watchlist item Active is false (without calling warez detail API)', async () => {
    const { nocodb, nocodbMocks, warez, warezMocks } = createMocks({
      foundMatches: [
        makeMatch({ Id: 10, WatchlistId: 1, WarezUid: 'uid-inactive-found', Status: 'found' }),
      ],
      recheckSeries: [
        makeMatch({ Id: 11, WatchlistId: 2, WarezUid: 'uid-inactive-recheck', Status: 'processed', Episode: 4 }),
      ],
      watchlist: {
        1: makeWatchlistItem({ Id: 1, Active: 0 }),
        2: makeWatchlistItem({ Id: 2, Active: false, LastEpisodeFound: 4 }),
      },
      releasesByUid: {
        'uid-inactive-found': [makeRelease({ options: { episode_count_in_season: '8' } })],
        'uid-inactive-recheck': [makeRelease({ options: { episode_count_in_season: '8' } })],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
    });

    expect(warezMocks.fetchEntryDetail).not.toHaveBeenCalled();
    expect(nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
    expect(nocodbMocks.upsertMatch).not.toHaveBeenCalled();
  });
});

describe('runEnrichScraper — preference ladder & AutoTags pinning', () => {
  const NOW = new Date('2026-11-21T12:00:00Z');

  it('picks HDR over 265 over 264 for movies, and falls down the ladder when HDR is offline', async () => {
    const { nocodb, nocodbMocks, warez } = createMocks({
      foundMatches: [
        makeMatch({
          Id: 30,
          WatchlistId: 3,
          WarezUid: 'uid-movie-ladder',
          Title: 'Crimson Rivers',
          Fulltitle: 'Crimson Rivers',
          Type: 'movie',
          Season: undefined,
          Episode: undefined,
          SeasonEpisodeKey: undefined,
          Status: 'found',
        }),
      ],
      watchlist: {
        3: makeWatchlistItem({
          Id: 3,
          Title: 'Crimson Rivers',
          Type: 'movie',
          DeactivateOnMatch: 1,
          Season: undefined,
        }),
      },
      releasesByUid: {
        'uid-movie-ladder': [
          makeRelease({
            id: 101,
            type: 'movie',
            fulltitle: 'Crimson.Rivers.2000.GERMAN.DL.1080p.WEB.H264-GRP1',
            video_codec: 'H264',
            options: { check: { ddownload: 'https://hide.cx/state/264-online' } },
          }),
          makeRelease({
            id: 102,
            type: 'movie',
            fulltitle: 'Crimson.Rivers.2000.GERMAN.DL.1080p.WEB.H265-GRP2',
            video_codec: 'H265',
            options: { check: { ddownload: 'https://hide.cx/state/265-online' } },
          }),
          makeRelease({
            id: 103,
            type: 'movie',
            fulltitle: 'Crimson.Rivers.2000.GERMAN.DL.1080p.WEB.H265.HDR-GRP3',
            video_codec: 'H265',
            options: { check: { ddownload: 'https://hide.cx/state/hdr-offline' } },
          }),
        ],
      },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: async (url) => !url.includes('offline'),
      now: NOW,
    });

    // HDR was offline → fell down ladder to 265 (id 102), NOT 264 (id 101)
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      30,
      expect.objectContaining({ WarezId: 102, Status: 'matched' }),
    );
    // Movies never write AutoTags
    expect(nocodbMocks.updateWatchlistAutoTags).not.toHaveBeenCalled();
  });

  it('pins AutoTags on initial series match when manual Tags is empty, and ignores AutoTags when manual Tags is set', async () => {
    const run1 = createMocks({
      foundMatches: [
        makeMatch({
          Id: 40,
          WatchlistId: 4,
          WarezUid: 'uid-pin',
          Status: 'found',
          Fulltitle: 'Der Herr der Ringe',
          Season: undefined,
          Episode: undefined,
          SeasonEpisodeKey: undefined,
        }),
      ],
      watchlist: { 4: makeWatchlistItem({ Id: 4, LastEpisodeFound: 0 }) },
      releasesByUid: {
        'uid-pin': [
          makeRelease({
            id: 201,
            fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-SAUERKRAUT',
            video_codec: 'H264',
            group: 'SAUERKRAUT',
            options: { episode_count_in_season: '4' },
          }),
          makeRelease({
            id: 202,
            fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.AMZN.WEB.H265.HDR-WAYNE',
            video_codec: 'H265',
            group: 'WAYNE',
            options: { episode_count_in_season: '4' },
          }),
        ],
      },
    });

    await runEnrichScraper(run1.warez, run1.nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
      now: NOW,
    });

    expect(run1.nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      40,
      expect.objectContaining({ WarezId: 202 }),
    );
    expect(run1.nocodbMocks.updateWatchlistAutoTags).toHaveBeenCalledWith(4, 'HDR,265,AMZN,WAYNE');

    // Now test manual Tags override: should ignore AutoTags and never write AutoTags
    const run2 = createMocks({
      foundMatches: [
        makeMatch({
          Id: 41,
          WatchlistId: 5,
          WarezUid: 'uid-manual',
          Status: 'found',
          Fulltitle: 'Der Herr der Ringe',
          Season: undefined,
          Episode: undefined,
          SeasonEpisodeKey: undefined,
        }),
      ],
      watchlist: {
        5: makeWatchlistItem({
          Id: 5,
          Tags: ['SAUERKRAUT'],
          AutoTags: 'HDR,265,AMZN,WAYNE',
          LastEpisodeFound: 0,
        }),
      },
      releasesByUid: {
        'uid-manual': [
          makeRelease({
            id: 201,
            fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-SAUERKRAUT',
            video_codec: 'H264',
            group: 'SAUERKRAUT',
            options: { episode_count_in_season: '4' },
          }),
          makeRelease({
            id: 202,
            fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.AMZN.WEB.H265.HDR-WAYNE',
            video_codec: 'H265',
            group: 'WAYNE',
            options: { episode_count_in_season: '4' },
          }),
        ],
      },
    });

    await runEnrichScraper(run2.warez, run2.nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
      now: NOW,
    });

    expect(run2.nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ WarezId: 201 }),
    );
    expect(run2.nocodbMocks.updateWatchlistAutoTags).not.toHaveBeenCalled();
  });

  it('waits during 48h grace period for pinned group, then falls back (same HDR/SDR + codec) and updates AutoTags', async () => {
    const otherGroupReleaseFresh = makeRelease({
      id: 301,
      fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.NF.WEB.H265.HDR-SAUERKRAUT',
      video_codec: 'H265',
      group: 'SAUERKRAUT',
      episode_updated_at: '2026-11-20T12:00:00Z', // only 24h old (< 48h)
      options: { episode_count_in_season: '5' },
    });

    // 1. Within 48h grace period → should NOT fall back yet
    const runFresh = createMocks({
      recheckSeries: [makeMatch({ Id: 50, WatchlistId: 6, Status: 'processed', Episode: 4 })],
      watchlist: {
        6: makeWatchlistItem({ Id: 6, AutoTags: 'HDR,265,AMZN,WAYNE', LastEpisodeFound: 4 }),
      },
      releasesByUid: { 'uid-lotr': [otherGroupReleaseFresh] },
    });

    await runEnrichScraper(runFresh.warez, runFresh.nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
      now: NOW,
    });
    expect(runFresh.nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
    expect(runFresh.nocodbMocks.updateWatchlistAutoTags).not.toHaveBeenCalled();

    // 2. After 48h grace period → falls back to same HDR + 265 from SAUERKRAUT and updates AutoTags!
    const otherGroupReleaseOld = makeRelease({
      ...otherGroupReleaseFresh,
      id: 302,
      episode_updated_at: '2026-11-19T10:00:00Z', // 50h old (>= 48h)
    });

    const runExpired = createMocks({
      recheckSeries: [makeMatch({ Id: 50, WatchlistId: 6, Status: 'processed', Episode: 4 })],
      watchlist: {
        6: makeWatchlistItem({ Id: 6, AutoTags: 'HDR,265,AMZN,WAYNE', LastEpisodeFound: 4 }),
      },
      releasesByUid: { 'uid-lotr': [otherGroupReleaseOld] },
    });

    await runEnrichScraper(runExpired.warez, runExpired.nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
      now: NOW,
    });
    expect(runExpired.nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(
      50,
      expect.objectContaining({ WarezId: 302, Episode: 5, SeasonEpisodeKey: 'S02E05' }),
    );
    expect(runExpired.nocodbMocks.updateWatchlistAutoTags).toHaveBeenCalledWith(6, 'HDR,265,NF,SAUERKRAUT');
  });

  it('NEVER relaxes DynamicRange (SDR vs HDR) or Codec (265 vs 264) even after 48h grace period', async () => {
    const oldHdrRelease = makeRelease({
      id: 401,
      fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.AMZN.WEB.H265.HDR-SAUERKRAUT',
      video_codec: 'H265',
      group: 'SAUERKRAUT',
      episode_updated_at: '2026-11-15T00:00:00Z', // 6 days old
      options: { episode_count_in_season: '5' },
    });
    const old264Release = makeRelease({
      id: 402,
      fulltitle: 'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.AMZN.WEB.H264-SAUERKRAUT',
      video_codec: 'H264',
      group: 'SAUERKRAUT',
      episode_updated_at: '2026-11-15T00:00:00Z', // 6 days old
      options: { episode_count_in_season: '5' },
    });

    const { nocodb, nocodbMocks, warez } = createMocks({
      recheckSeries: [makeMatch({ Id: 60, WatchlistId: 7, Status: 'processed', Episode: 4 })],
      watchlist: {
        7: makeWatchlistItem({ Id: 7, AutoTags: 'SDR,265,AMZN,WAYNE', LastEpisodeFound: 4 }),
      },
      releasesByUid: { 'uid-lotr': [oldHdrRelease, old264Release] },
    });

    await runEnrichScraper(warez, nocodb, TEST_CONFIG, {
      sleepFn: noopSleep,
      isHosterOnlineFn: alwaysOnline,
      now: NOW,
    });

    expect(nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
    expect(nocodbMocks.updateWatchlistAutoTags).not.toHaveBeenCalled();
  });
});
