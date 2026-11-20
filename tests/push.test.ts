import { describe, it, expect, vi } from 'vitest';
import {
  buildMetadataPath,
  findPushedLinks,
  getEpisodeFilterRange,
  partitionLinksByEpisodes,
  runPushScraper,
  selectCryptedLink,
} from '../src/scrapers/push';
import type { Config } from '../src/config';
import type { CrawledLink, CrawledPackage, JDownloaderClient } from '../src/jdownloader/client';
import type { NocoDbClient } from '../src/nocodb/client';
import type { MatchRow } from '../src/nocodb/types';

const TEST_CONFIG = {
  SEARCH_DELAY_MS: 0,
  JDOWNLOADER_AUTOSTART: true,
  JDOWNLOADER_HOSTER_PRIORITY: 'ddownload,rapidgator',
} as Config;

const noopSleep = async () => {};

function makeMatch(overrides: Partial<MatchRow> = {}): MatchRow & { Id: number } {
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
    SeasonEpisodeKey: 'S02E05-E06',
    CryptedLinks: JSON.stringify({ ddownload: 'https://hide.cx/container/lotr' }),
    ImdbId: 'tt7631058',
    MatchedAt: '2026-05-01T00:00:00Z',
    Status: 'matched',
    ...overrides,
  };
}

function makeLink(uuid: number, name: string, packageUUID = '100'): CrawledLink {
  return { uuid, name, url: `https://ddownload.com/${uuid}`, packageUUID, size: 1_000_000 };
}

function makePkg(uuid: number, name: string, saveTo: string, childCount = 0): CrawledPackage {
  return { uuid, name, saveTo, childCount };
}

describe('push helper functions', () => {
  it('builds metadata path including episode range', () => {
    expect(buildMetadataPath(makeMatch({ SeasonEpisodeKey: 'S02E05-E06' }))).toBe('tt7631058-series-S02E05-E06');
    expect(buildMetadataPath(makeMatch({ Type: 'movie', SeasonEpisodeKey: undefined }))).toBe('tt7631058-movie');
  });

  it('selects crypted link by hoster priority', () => {
    const json = JSON.stringify({
      rapidgator: 'https://hide.cx/rg',
      ddownload: 'https://hide.cx/ddl',
    });
    expect(selectCryptedLink(json, ['ddownload', 'rapidgator'])).toEqual({
      url: 'https://hide.cx/ddl',
      hoster: 'ddownload',
    });
  });

  it('determines when linkgrabber episode filtering is needed', () => {
    // Season pack re-check starting at E05 → needs filtering for [5, 6]
    expect(getEpisodeFilterRange(makeMatch({ SeasonEpisodeKey: 'S02E05-E06' }))).toEqual({
      season: 2,
      fromEpisode: 5,
      toEpisode: 6,
      episodes: [5, 6],
    });

    // First-time season pack starting at E01 → NO filtering needed (download all E01..E04!)
    expect(getEpisodeFilterRange(makeMatch({ SeasonEpisodeKey: 'S02E01-E04', Episode: 4 }))).toBeNull();

    // Individual episode release → NO filtering needed (container only has E05)
    expect(
      getEpisodeFilterRange(
        makeMatch({
          Fulltitle: 'Der.Herr.der.Ringe.S02E05.GERMAN.DL.1080P.WEB.H264-WAYNE',
          SeasonEpisodeKey: 'S02E05',
          Episode: 5,
        }),
      ),
    ).toBeNull();

    // Movie → NO filtering
    expect(getEpisodeFilterRange(makeMatch({ Type: 'movie', SeasonEpisodeKey: undefined }))).toBeNull();
  });

  it('finds pushed links by package saveTo even when filenames are obfuscated/abbreviated', () => {
    const existing = new Set([1]);
    const packages = [
      makePkg(100, 'Some Other Download', '/output/other'),
      makePkg(200, 'LOTR Pack', '/output/tt7631058-series-S02E05-E06'),
    ];
    const allLinks = [
      makeLink(1, 'old.existing.file.rar', '100'),
      makeLink(2, 'wayne-dhdr-s02e05.part01.rar', '200'),
      makeLink(3, 'wayne-dhdr-s02e05.part02.rar', '200'),
    ];

    const { links } = findPushedLinks(
      allLinks,
      packages,
      existing,
      'tt7631058-series-S02E05-E06',
      'Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE',
    );
    expect(links.map(l => l.uuid)).toEqual([2, 3]);
  });

  it('falls back to package name when individual archive parts omit SxxExx', () => {
    const pkgByUuid = new Map<string, CrawledPackage>([
      ['201', makePkg(201, 'Der.Herr.der.Ringe.S02E04', '/output/tt7631058-series-S02E05-E06')],
      ['202', makePkg(202, 'Der.Herr.der.Ringe.S02E05', '/output/tt7631058-series-S02E05-E06')],
    ]);
    const links = [
      makeLink(10, 'archive.part01.rar', '201'),
      makeLink(11, 'archive.part01.rar', '202'),
      makeLink(12, 'archive.part02.rar', '202'),
    ];

    const { keepLinks, removeLinkIds } = partitionLinksByEpisodes(
      links,
      pkgByUuid,
      /S02[._-]?E(?:0?5|0?6)(?!\d)/i,
    );

    expect(keepLinks.map(l => l.uuid)).toEqual([11, 12]);
    expect(removeLinkIds).toEqual([10]);
  });
});

describe('runPushScraper — multi-episode & multi-part bugfixes', () => {
  it('waits until isCollecting=false AND links stabilize so ALL parts of ALL new episodes are moved (not just part 1)', async () => {
    const match = makeMatch({ SeasonEpisodeKey: 'S02E05-E06', Episode: 6 });

    // Simulate incremental container crawling:
    // Poll 0 (snapshot before push): 1 unrelated pre-existing link
    // Poll 1: collecting=true, only 1 part of E05 has appeared so far!
    // Poll 2: collecting=true, E01-E04 + E05 parts 1-2 appeared
    // Poll 3: collecting=false, all parts of E01..E06 present (first time seeing full set)
    // Poll 4: collecting=false, same full set → STABLE!
    const pkg = makePkg(200, match.Fulltitle, '/output/tt7631058-series-S02E05-E06');
    const unrelatedLink = makeLink(999, 'Unrelated.Movie.part01.rar', '50');
    const e04p1 = makeLink(101, 'Der.Herr.der.Ringe.S02E04.part01.rar', '200');
    const e04p2 = makeLink(102, 'Der.Herr.der.Ringe.S02E04.part02.rar', '200');
    const e05p1 = makeLink(201, 'Der.Herr.der.Ringe.S02E05.part01.rar', '200');
    const e05p2 = makeLink(202, 'Der.Herr.der.Ringe.S02E05.part02.rar', '200');
    const e05p3 = makeLink(203, 'Der.Herr.der.Ringe.S02E05.part03.rar', '200');
    const e06p1 = makeLink(301, 'Der.Herr.der.Ringe.S02E06.part01.rar', '200');
    const e06p2 = makeLink(302, 'Der.Herr.der.Ringe.S02E06.part02.rar', '200');
    const e06p3 = makeLink(303, 'Der.Herr.der.Ringe.S02E06.part03.rar', '200');

    const linkSnapshots: CrawledLink[][] = [
      [unrelatedLink], // pre-push snapshot
      [unrelatedLink, e05p1], // poll 1: only 1 part!
      [unrelatedLink, e04p1, e04p2, e05p1, e05p2], // poll 2: still crawling
      [unrelatedLink, e04p1, e04p2, e05p1, e05p2, e05p3, e06p1, e06p2, e06p3], // poll 3: full set
      [unrelatedLink, e04p1, e04p2, e05p1, e05p2, e05p3, e06p1, e06p2, e06p3], // poll 4: stable!
    ];
    const collectingStates = [true, true, false, false];

    let linkCallIdx = 0;
    let collectingCallIdx = 0;

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => collectingStates[collectingCallIdx++] ?? false),
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => linkSnapshots[linkCallIdx++] ?? linkSnapshots[linkSnapshots.length - 1]!),
      removeLinks: vi.fn(async () => {}),
      moveToDownloadList: vi.fn(async () => {}),
      startDownloads: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchesByStatus: vi.fn(async () => [match]),
      updateMatchRelease: vi.fn(async () => {}),
    };

    await runPushScraper(
      jdMocks as unknown as JDownloaderClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      { pollDelayMs: 0, maxPollAttempts: 10, stablePollsRequired: 2, sleepFn: noopSleep },
    );

    // Must have removed ONLY old episode E04 parts (and NEVER touched unrelatedLink 999)
    expect(jdMocks.removeLinks).toHaveBeenCalledWith([101, 102]);
    // Must have moved ALL 6 parts of E05 AND E06 and started downloads!
    expect(jdMocks.moveToDownloadList).toHaveBeenCalledWith([201, 202, 203, 301, 302, 303]);
    expect(jdMocks.startDownloads).toHaveBeenCalledTimes(1);
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(10, { Status: 'pushed' });
  });

  it('resets stability check when late parts arrive after isCollecting briefly turns false', async () => {
    const match = makeMatch({ SeasonEpisodeKey: 'S02E05', Episode: 5 });
    const pkg = makePkg(200, match.Fulltitle, '/output/tt7631058-series-S02E05');
    const p1 = makeLink(1, 'Der.Herr.der.Ringe.S02E05.part01.rar', '200');
    const p2 = makeLink(2, 'Der.Herr.der.Ringe.S02E05.part02.rar', '200');
    const p3 = makeLink(3, 'Der.Herr.der.Ringe.S02E05.part03.rar', '200');

    const linkSnapshots: CrawledLink[][] = [
      [], // pre-push
      [p1], // poll 1: collecting=false, count=1 (stable 1/2)
      [p1, p2, p3], // poll 2: late parts arrived! resets stable to 1/2
      [p1, p2, p3], // poll 3: unchanged → stable 2/2!
    ];
    let idx = 0;

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => linkSnapshots[idx++] ?? [p1, p2, p3]),
      removeLinks: vi.fn(async () => {}),
      moveToDownloadList: vi.fn(async () => {}),
      startDownloads: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchesByStatus: vi.fn(async () => [match]),
      updateMatchRelease: vi.fn(async () => {}),
    };

    await runPushScraper(
      jdMocks as unknown as JDownloaderClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      { pollDelayMs: 0, maxPollAttempts: 10, stablePollsRequired: 2, sleepFn: noopSleep },
    );

    expect(jdMocks.moveToDownloadList).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('pushes first-time season packs (S02E01-E04) directly with autostart without filtering out E01-E03', async () => {
    const match = makeMatch({ SeasonEpisodeKey: 'S02E01-E04', Episode: 4 });

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => []),
      queryLinks: vi.fn(async () => []),
      removeLinks: vi.fn(async () => {}),
      moveToDownloadList: vi.fn(async () => {}),
      startDownloads: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchesByStatus: vi.fn(async () => [match]),
      updateMatchRelease: vi.fn(async () => {}),
    };

    await runPushScraper(
      jdMocks as unknown as JDownloaderClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      { pollDelayMs: 0, sleepFn: noopSleep },
    );

    expect(jdMocks.pushLinks).toHaveBeenCalledWith({
      links: ['https://hide.cx/container/lotr'],
      packageName: match.Fulltitle,
      autostart: true,
      destinationFolder: 'tt7631058-series-S02E01-E04',
    });
    expect(jdMocks.removeLinks).not.toHaveBeenCalled();
    expect(jdMocks.queryLinks).not.toHaveBeenCalled();
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(10, { Status: 'pushed' });
  });

  it('does not move partial parts if polling times out while JDownloader is still collecting', async () => {
    const match = makeMatch({ SeasonEpisodeKey: 'S02E05-E06', Episode: 6 });
    const pkg = makePkg(200, match.Fulltitle, '/output/tt7631058-series-S02E05-E06');
    const p1 = makeLink(1, 'Der.Herr.der.Ringe.S02E05.part01.rar', '200');

    let first = true;
    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => true), // still collecting entire time
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => {
        if (first) {
          first = false;
          return [];
        }
        return [p1];
      }),
      removeLinks: vi.fn(async () => {}),
      moveToDownloadList: vi.fn(async () => {}),
      startDownloads: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchesByStatus: vi.fn(async () => [match]),
      updateMatchRelease: vi.fn(async () => {}),
    };

    await runPushScraper(
      jdMocks as unknown as JDownloaderClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      { pollDelayMs: 0, maxPollAttempts: 3, stablePollsRequired: 2, sleepFn: noopSleep },
    );

    expect(jdMocks.moveToDownloadList).not.toHaveBeenCalled();
    expect(jdMocks.removeLinks).not.toHaveBeenCalled();
  });

  it('falls back to stability check when isCollecting() throws an error', async () => {
    const match = makeMatch({ SeasonEpisodeKey: 'S02E05', Episode: 5 });
    const pkg = makePkg(200, match.Fulltitle, '/output/tt7631058-series-S02E05');
    const p1 = makeLink(1, 'Der.Herr.der.Ringe.S02E05.part01.rar', '200');
    const p2 = makeLink(2, 'Der.Herr.der.Ringe.S02E05.part02.rar', '200');

    const snapshots = [[], [p1], [p1, p2], [p1, p2], [p1, p2]];
    let idx = 0;

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => {
        throw new Error('method not supported');
      }),
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => snapshots[idx++] ?? [p1, p2]),
      removeLinks: vi.fn(async () => {}),
      moveToDownloadList: vi.fn(async () => {}),
      startDownloads: vi.fn(async () => {}),
    };

    const nocodbMocks = {
      getMatchesByStatus: vi.fn(async () => [match]),
      updateMatchRelease: vi.fn(async () => {}),
    };

    await runPushScraper(
      jdMocks as unknown as JDownloaderClient,
      nocodbMocks as unknown as NocoDbClient,
      TEST_CONFIG,
      { pollDelayMs: 0, maxPollAttempts: 10, stablePollsRequired: 2, sleepFn: noopSleep },
    );

    expect(jdMocks.moveToDownloadList).toHaveBeenCalledWith([1, 2]);
  });
});
