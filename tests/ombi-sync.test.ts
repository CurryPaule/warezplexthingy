import { describe, it, expect, vi } from 'vitest';
import {
  parseValidDate,
  evaluateMovieRequest,
  evaluateTvRequest,
  runOmbiSync,
} from '../src/scrapers/ombi-sync';
import type { Config } from '../src/config';
import type { NocoDbClient } from '../src/nocodb/client';
import type { WatchlistRow } from '../src/nocodb/types';
import type { OmbiClient } from '../src/ombi/client';
import type { OmbiMovieRequest, OmbiTvRequest } from '../src/ombi/types';

const NOW = new Date('2026-11-21T12:00:00Z');

const TEST_CONFIG = {
  DEFAULT_QUALITY: '1080p',
  DEFAULT_LANG: 'GER',
  DEFAULT_TAGS: '',
  OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS: 7,
  OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS: 1,
} as Config;

function createMocks(params: {
  movies?: OmbiMovieRequest[];
  tv?: OmbiTvRequest[];
  watchlist?: (WatchlistRow & { Id: number })[];
}) {
  let nextId = 100;

  const ombi = {
    getMovieRequests: vi.fn(async () => params.movies ?? []),
    getTvRequests: vi.fn(async () => params.tv ?? []),
  };

  const nocodb = {
    getAllWatchlist: vi.fn(async () => params.watchlist ?? []),
    createWatchlistItem: vi.fn(async (item: Omit<WatchlistRow, 'Id'>) => ({
      Id: nextId++,
      ...item,
    })),
    updateWatchlistItem: vi.fn(async () => {}),
  };

  return {
    ombi: ombi as unknown as OmbiClient,
    ombiMocks: ombi,
    nocodb: nocodb as unknown as NocoDbClient,
    nocodbMocks: nocodb,
  };
}

describe('parseValidDate', () => {
  it('returns null for empty, invalid, or C# DateTime.MinValue strings', () => {
    expect(parseValidDate(null)).toBeNull();
    expect(parseValidDate(undefined)).toBeNull();
    expect(parseValidDate('')).toBeNull();
    expect(parseValidDate('not-a-date')).toBeNull();
    expect(parseValidDate('0001-01-01T00:00:00')).toBeNull();
  });

  it('parses valid ISO date strings', () => {
    const d = parseValidDate('2026-11-20T00:00:00Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });
});

describe('runOmbiSync — movies', () => {
  it('inserts an approved released movie with default filters (1080p, GER, DeactivateOnMatch=true, Active=true)', async () => {
    const { ombi, nocodb, nocodbMocks } = createMocks({
      movies: [
        {
          id: 1,
          title: 'Dune: Part Two',
          imdbId: 'tt15239678',
          theMovieDbId: 693134,
          releaseDate: '2024-02-28T00:00:00',
          approved: true,
          available: false,
        },
      ],
    });

    const summary = await runOmbiSync(ombi, nocodb, TEST_CONFIG, { now: NOW });

    expect(summary.created).toBe(1);
    expect(nocodbMocks.createWatchlistItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Title: 'Dune: Part Two',
        Type: 'movie',
        ImdbId: 'tt15239678',
        TmdbId: 693134,
        Quality: '1080p',
        LangRequired: 'GER',
        Active: true,
        DeactivateOnMatch: true,
      }),
    );
  });

  it('upgrades Quality to 2160p when Ombi movie is a 4K request', async () => {
    const { ombi, nocodb, nocodbMocks } = createMocks({
      movies: [
        {
          id: 2,
          title: 'Interstellar',
          imdbId: 'tt0816692',
          theMovieDbId: 157336,
          releaseDate: '2014-11-05T00:00:00',
          approved: false,
          has4KRequest: true,
          approved4K: true,
          available4K: false,
        },
      ],
    });

    await runOmbiSync(ombi, nocodb, TEST_CONFIG, { now: NOW });

    expect(nocodbMocks.createWatchlistItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Title: 'Interstellar',
        Quality: '2160p',
        Active: true,
      }),
    );
  });

  it('inserts an unreleased movie with Active=false and activates it once releaseDate or digitalReleaseDate window arrives', async () => {
    const unreleasedMovie: OmbiMovieRequest = {
      id: 3,
      title: 'Upcoming Sci-Fi',
      imdbId: 'tt9999999',
      theMovieDbId: 55555,
      releaseDate: '2027-03-15T00:00:00Z',
      digitalReleaseDate: '2027-05-01T00:00:00Z',
      approved: true,
      available: false,
    };

    // First sync: unreleased → created as Active=false
    const run1 = createMocks({ movies: [unreleasedMovie] });
    await runOmbiSync(run1.ombi, run1.nocodb, TEST_CONFIG, { now: NOW });

    expect(run1.nocodbMocks.createWatchlistItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Title: 'Upcoming Sci-Fi',
        Active: false,
      }),
    );

    // Second sync on 2027-03-16 (past releaseDate): existing row flips to Active=true
    const existingRow: WatchlistRow & { Id: number } = {
      Id: 50,
      Title: 'Upcoming Sci-Fi',
      Type: 'movie',
      ImdbId: 'tt9999999',
      TmdbId: 55555,
      Quality: '2160p', // user manually upgraded in NocoDB
      LangRequired: 'GER,ENG',
      Tags: ['HDR'],
      Active: 0,
      DeactivateOnMatch: 1,
    };
    const run2 = createMocks({
      movies: [unreleasedMovie],
      watchlist: [existingRow],
    });
    const summary2 = await runOmbiSync(run2.ombi, run2.nocodb, TEST_CONFIG, {
      now: new Date('2027-03-16T00:00:00Z'),
    });

    expect(summary2.activated).toBe(1);
    // Only Active is patched; manual Quality/LangRequired/Tags overrides are preserved
    expect(run2.nocodbMocks.updateWatchlistItem).toHaveBeenCalledWith(50, { Active: true });
  });

  it('activates a movie when digitalReleaseDate is within lookahead window even if theatrical releaseDate is later', () => {
    const desired = evaluateMovieRequest(
      {
        id: 4,
        title: 'Streaming Early',
        releaseDate: '2026-12-20T00:00:00Z',
        digitalReleaseDate: '2026-11-26T00:00:00Z', // 5 days from NOW (within 7d lookahead)
        approved: true,
        available: false,
      },
      NOW,
      7,
    );
    expect(desired.isReleased).toBe(true);
  });

  it('keeps an already-matched movie (DeactivateOnMatch + LastMatchedAt) inactive while downloading / awaiting Ombi availability', async () => {
    const { ombi, nocodb, nocodbMocks } = createMocks({
      movies: [
        {
          id: 5,
          title: 'Inception',
          imdbId: 'tt1375666',
          releaseDate: '2010-07-16T00:00:00Z',
          approved: true,
          available: false, // Plex hasn't scanned yet
        },
      ],
      watchlist: [
        {
          Id: 10,
          Title: 'Inception',
          Type: 'movie',
          ImdbId: 'tt1375666',
          Active: 0,
          DeactivateOnMatch: 1,
          LastMatchedAt: '2026-11-21T10:00:00Z',
        },
      ],
    });

    const summary = await runOmbiSync(ombi, nocodb, TEST_CONFIG, { now: NOW });

    expect(summary.unchanged).toBe(1);
    expect(nocodbMocks.updateWatchlistItem).not.toHaveBeenCalled();
  });

  it('skips creating already-available or denied movies, and deactivates existing ones', async () => {
    const { ombi, nocodb, nocodbMocks } = createMocks({
      movies: [
        {
          id: 6,
          title: 'Already On Plex New',
          imdbId: 'tt1111111',
          approved: true,
          available: true,
        },
        {
          id: 7,
          title: 'Now Available',
          imdbId: 'tt2222222',
          approved: true,
          available: true,
        },
        {
          id: 8,
          title: 'Denied Movie',
          imdbId: 'tt3333333',
          approved: false,
          denied: true,
          available: false,
        },
      ],
      watchlist: [
        {
          Id: 20,
          Title: 'Now Available',
          Type: 'movie',
          ImdbId: 'tt2222222',
          Active: 1,
          DeactivateOnMatch: 1,
        },
        {
          Id: 21,
          Title: 'Removed From Ombi',
          Type: 'movie',
          ImdbId: 'tt4444444',
          Active: 1,
          DeactivateOnMatch: 1,
        },
      ],
    });

    const summary = await runOmbiSync(ombi, nocodb, TEST_CONFIG, { now: NOW });

    expect(summary.created).toBe(0);
    expect(summary.deactivated).toBe(2);
    expect(nocodbMocks.createWatchlistItem).not.toHaveBeenCalled();
    expect(nocodbMocks.updateWatchlistItem).toHaveBeenCalledWith(20, { Active: false });
    expect(nocodbMocks.updateWatchlistItem).toHaveBeenCalledWith(21, { Active: false });
  });
});

describe('runOmbiSync — TV shows', () => {
  it('merges childRequests per season, seeds initial LastEpisodeFound from available episodes, and gates unaired seasons', async () => {
    const tvReq: OmbiTvRequest = {
      id: 10,
      title: 'From',
      imdbId: 'tt9813792',
      tvDbId: 394418,
      childRequests: [
        {
          id: 101,
          approved: true,
          available: false,
          seasonRequests: [
            {
              seasonNumber: 3,
              episodes: [
                { episodeNumber: 1, airDate: '2026-10-01T00:00:00Z', approved: true, available: true },
                { episodeNumber: 2, airDate: '2026-10-08T00:00:00Z', approved: true, available: true },
                { episodeNumber: 3, airDate: '2026-10-15T00:00:00Z', approved: true, available: false },
                { episodeNumber: 4, airDate: '2026-11-28T00:00:00Z', approved: true, available: false }, // next week
              ],
            },
            {
              seasonNumber: 4,
              episodes: [
                { episodeNumber: 1, airDate: '2027-09-01T00:00:00Z', approved: true, available: false },
                { episodeNumber: 2, airDate: '2027-09-08T00:00:00Z', approved: true, available: false },
              ],
            },
          ],
        },
        {
          // Second friend also requested S03 — should merge cleanly without duplicate rows
          id: 102,
          approved: true,
          available: false,
          seasonRequests: [
            {
              seasonNumber: 3,
              episodes: [
                { episodeNumber: 1, airDate: '2026-10-01T00:00:00Z', approved: true, available: true },
                { episodeNumber: 2, airDate: '2026-10-08T00:00:00Z', approved: true, available: true },
                { episodeNumber: 3, airDate: '2026-10-15T00:00:00Z', approved: true, available: false },
                { episodeNumber: 4, airDate: '2026-11-28T00:00:00Z', approved: true, available: false },
              ],
            },
          ],
        },
      ],
    };

    const { ombi, nocodb, nocodbMocks } = createMocks({ tv: [tvReq] });
    const summary = await runOmbiSync(ombi, nocodb, TEST_CONFIG, { now: NOW });

    expect(summary.created).toBe(2);

    // Season 3: airing (ep 1 already aired), ep 1-2 available → Active=true, LastEpisodeFound=2
    expect(nocodbMocks.createWatchlistItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Title: 'From',
        Type: 'series',
        ImdbId: 'tt9813792',
        Season: 3,
        LastEpisodeFound: 2,
        Active: true,
        DeactivateOnMatch: false,
        Quality: '1080p',
        LangRequired: 'GER',
      }),
    );

    // Season 4: unaired (premieres 2027-09-01) → Active=false, LastEpisodeFound=0
    expect(nocodbMocks.createWatchlistItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Title: 'From',
        Type: 'series',
        ImdbId: 'tt9813792',
        Season: 4,
        LastEpisodeFound: 0,
        Active: false,
        DeactivateOnMatch: false,
      }),
    );
  });

  it('auto-disables a TV season once LastEpisodeFound reaches the highest requested episode (and re-enables if user lowers LastEpisodeFound)', async () => {
    const tvReq: OmbiTvRequest = {
      id: 11,
      title: 'Breaking Bad',
      imdbId: 'tt0903747',
      childRequests: [
        {
          id: 201,
          approved: true,
          available: false,
          seasonRequests: [
            {
              seasonNumber: 2,
              episodes: [
                { episodeNumber: 1, airDate: '2009-03-08T00:00:00Z', approved: true, available: true },
                { episodeNumber: 2, airDate: '2009-03-15T00:00:00Z', approved: true, available: false },
                { episodeNumber: 3, airDate: '2009-03-22T00:00:00Z', approved: true, available: false },
              ],
            },
          ],
        },
      ],
    };

    // Scraper already matched up to episode 3 → should auto-deactivate
    const run1 = createMocks({
      tv: [tvReq],
      watchlist: [
        {
          Id: 30,
          Title: 'Breaking Bad',
          Type: 'series',
          ImdbId: 'tt0903747',
          Season: 2,
          LastEpisodeFound: 3,
          Active: 1,
          DeactivateOnMatch: 0,
        },
      ],
    });
    const summary1 = await runOmbiSync(run1.ombi, run1.nocodb, TEST_CONFIG, { now: NOW });
    expect(summary1.deactivated).toBe(1);
    expect(run1.nocodbMocks.updateWatchlistItem).toHaveBeenCalledWith(30, { Active: false });

    // User manually lowers LastEpisodeFound to 2 to re-download ep 3 → re-activates!
    const run2 = createMocks({
      tv: [tvReq],
      watchlist: [
        {
          Id: 30,
          Title: 'Breaking Bad',
          Type: 'series',
          ImdbId: 'tt0903747',
          Season: 2,
          LastEpisodeFound: 2,
          Active: 0,
          DeactivateOnMatch: 0,
        },
      ],
    });
    const summary2 = await runOmbiSync(run2.ombi, run2.nocodb, TEST_CONFIG, { now: NOW });
    expect(summary2.activated).toBe(1);
    expect(run2.nocodbMocks.updateWatchlistItem).toHaveBeenCalledWith(30, { Active: true });
  });

  it('activates a TV season 1 day before its premiere airDate', () => {
    const tvReq: OmbiTvRequest = {
      id: 12,
      title: 'Tomorrow Show',
      imdbId: 'tt8888888',
      childRequests: [
        {
          id: 301,
          approved: true,
          seasonRequests: [
            {
              seasonNumber: 1,
              episodes: [
                { episodeNumber: 1, airDate: '2026-11-22T08:00:00Z', approved: true, available: false },
              ],
            },
          ],
        },
      ],
    };

    const seasons = evaluateTvRequest(tvReq, NOW, 1);
    expect(seasons).toHaveLength(1);
    expect(seasons[0]!.isReleased).toBe(true);
  });

  it('keeps Active=true for an airing season even when already-aired episodes are available and next episode airs next week', () => {
    const tvReq: OmbiTvRequest = {
      id: 13,
      title: 'Weekly Show',
      imdbId: 'tt7777777',
      childRequests: [
        {
          id: 401,
          approved: true,
          seasonRequests: [
            {
              seasonNumber: 1,
              episodes: [
                { episodeNumber: 1, airDate: '2026-11-01T00:00:00Z', approved: true, available: true },
                { episodeNumber: 2, airDate: '2026-11-08T00:00:00Z', approved: true, available: true },
                { episodeNumber: 3, airDate: '2026-11-28T00:00:00Z', approved: true, available: false },
              ],
            },
          ],
        },
      ],
    };

    const seasons = evaluateTvRequest(tvReq, NOW, 1);
    expect(seasons).toHaveLength(1);
    expect(seasons[0]!.isReleased).toBe(true);
    expect(seasons[0]!.initialLastEpisodeFound).toBe(2);
  });

  it('maps Ombi v4 externalProviderId to TmdbId and ignores unrequested episodes', () => {
    const tvReq: OmbiTvRequest = {
      id: 14,
      title: 'House of the Dragon',
      imdbId: 'tt11198330',
      tvDbId: 371572,
      externalProviderId: 94997,
      childRequests: [
        {
          id: 501,
          approved: true,
          available: false,
          seasonRequests: [
            {
              seasonNumber: 3,
              episodes: [
                { episodeNumber: 1, airDate: '2026-06-21T00:00:00Z', approved: true, available: false, requested: false },
                { episodeNumber: 2, airDate: '2026-06-28T00:00:00Z', approved: true, available: false, requested: true },
              ],
            },
          ],
        },
      ],
    };

    const seasons = evaluateTvRequest(tvReq, NOW, 1);
    expect(seasons).toHaveLength(1);
    expect(seasons[0]!.tmdbId).toBe(94997);
    expect(seasons[0]!.initialLastEpisodeFound).toBe(1);
    expect(seasons[0]!.highestRequestedEpisode).toBe(2);
  });
});
