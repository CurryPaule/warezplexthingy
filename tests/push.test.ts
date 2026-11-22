import { describe, it, expect, vi } from 'vitest';
import {
  buildMetadataPath,
  buildPushCandidates,
  findPushedLinks,
  getEpisodeFilterRange,
  partitionLinksByEpisodes,
  runPushScraper,
  selectCryptedLink,
  selectDirectLinks,
  selectPushLinks,
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

function makeLink(
  uuid: number,
  name: string,
  packageUUID = '100',
  extra: Partial<CrawledLink> = {},
): CrawledLink {
  return {
    uuid,
    name,
    url: `https://ddownload.com/${uuid}`,
    packageUUID,
    size: 1_000_000,
    ...extra,
  };
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

  it('prefers direct Links for movies and individual episodes, but uses CryptedLinks for series season packs', () => {
    const directJson = JSON.stringify({
      'rapidgator.net': ['https://rapidgator.net/file/1', 'https://rapidgator.net/file/2'],
      'ddownload.com': ['https://ddownload.com/part1', 'https://ddownload.com/part2'],
    });
    const cryptedJson = JSON.stringify({
      'ddownload.com': 'https://filecrypt.cc/Container/ABC.html',
    });

    expect(selectDirectLinks(directJson, ['ddownload', 'rapidgator'])).toEqual({
      urls: ['https://ddownload.com/part1', 'https://ddownload.com/part2'],
      hoster: 'ddownload.com',
    });

    // Movie → prefers direct Links (avoids filecrypt.cc Cloudflare container)
    expect(
      selectPushLinks(
        makeMatch({ Type: 'movie', Fulltitle: 'Ronin.1998.1080p.BluRay.x265-VECTOR', Links: directJson, CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual({
      urls: ['https://ddownload.com/part1', 'https://ddownload.com/part2'],
      hoster: 'ddownload.com',
      source: 'direct',
    });

    // Individual episode → prefers direct Links
    expect(
      selectPushLinks(
        makeMatch({ Type: 'series', Fulltitle: 'Show.S02E05.1080p.WEB.H265-WAYNE', Links: directJson, CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual({
      urls: ['https://ddownload.com/part1', 'https://ddownload.com/part2'],
      hoster: 'ddownload.com',
      source: 'direct',
    });

    // Series season pack → MUST use CryptedLinks (direct Links only has Episode 1)
    expect(
      selectPushLinks(
        makeMatch({ Type: 'series', Fulltitle: 'Show.S02.1080p.WEB.H265-WAYNE', Links: directJson, CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual({
      urls: ['https://filecrypt.cc/Container/ABC.html'],
      hoster: 'ddownload.com',
      source: 'crypted',
    });

    // Movie without direct Links → falls back to CryptedLinks
    expect(
      selectPushLinks(
        makeMatch({ Type: 'movie', Fulltitle: 'Ronin.1998.1080p', Links: '{}', CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual({
      urls: ['https://filecrypt.cc/Container/ABC.html'],
      hoster: 'ddownload.com',
      source: 'crypted',
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

describe('runPushScraper — direct link verification & container fallback (stale warez.cx links)', () => {
  it('builds ordered fallback candidates respecting hoster priority', () => {
    const directJson = JSON.stringify({
      'rapidgator.net': ['https://rapidgator.net/file/1'],
      'ddownload.com': ['https://ddownload.com/part1'],
    });
    const cryptedJson = JSON.stringify({
      'rapidgator.net': 'https://filecrypt.cc/Container/RG.html',
      'ddownload.com': 'https://filecrypt.cc/Container/DDL.html',
    });

    // Movie: hoster-first, direct before crypted for each hoster
    expect(
      buildPushCandidates(
        makeMatch({ Type: 'movie', Fulltitle: 'The.House.That.Jack.Built.2018.1080p', Links: directJson, CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual([
      { source: 'direct', hoster: 'ddownload.com', urls: ['https://ddownload.com/part1'] },
      { source: 'crypted', hoster: 'ddownload.com', urls: ['https://filecrypt.cc/Container/DDL.html'] },
      { source: 'direct', hoster: 'rapidgator.net', urls: ['https://rapidgator.net/file/1'] },
      { source: 'crypted', hoster: 'rapidgator.net', urls: ['https://filecrypt.cc/Container/RG.html'] },
    ]);

    // Season pack: all crypted containers first across hosters before any direct fallback
    expect(
      buildPushCandidates(
        makeMatch({ Type: 'series', Fulltitle: 'Show.S02.1080p.WEB.H265-WAYNE', Links: directJson, CryptedLinks: cryptedJson }),
        ['ddownload', 'rapidgator'],
      ),
    ).toEqual([
      { source: 'crypted', hoster: 'ddownload.com', urls: ['https://filecrypt.cc/Container/DDL.html'] },
      { source: 'crypted', hoster: 'rapidgator.net', urls: ['https://filecrypt.cc/Container/RG.html'] },
      { source: 'direct', hoster: 'ddownload.com', urls: ['https://ddownload.com/part1'] },
      { source: 'direct', hoster: 'rapidgator.net', urls: ['https://rapidgator.net/file/1'] },
    ]);
  });

  it('finds pushed direct links by URL even when JD puts offline files in an Offline Files package with hash names', () => {
    const existing = new Set<number>();
    const packages = [makePkg(500, 'Offline Files', '/output/other')];
    const allLinks = [
      makeLink(10, 'a81vaylyxsbj', '500', { url: 'https://ddownload.com/a81vaylyxsbj', availability: 'OFFLINE' }),
      makeLink(11, 'fxplh3w53k8p', '500', { url: 'https://ddownload.com/fxplh3w53k8p/movie.part02.rar', availability: 'OFFLINE' }),
      makeLink(12, 'unrelated.rar', '500', { url: 'https://ddownload.com/otherfile', availability: 'ONLINE' }),
    ];

    const { links } = findPushedLinks(
      allLinks,
      packages,
      existing,
      'tt4003440-movie',
      'The.House.That.Jack.Built.2018.German.EAC3.DL.1080p.BluRay.x265-VECTOR',
      ['https://ddownload.com/a81vaylyxsbj', 'https://ddownload.com/fxplh3w53k8p'],
    );

    expect(links.map(l => l.uuid)).toEqual([10, 11]);
  });

  it('removes stale offline direct links and falls back to CryptedLinks container (The House That Jack Built case)', async () => {
    const directUrls = [
      'https://ddownload.com/a81vaylyxsbj',
      'https://ddownload.com/fxplh3w53k8p',
    ];
    const containerUrl = 'https://filecrypt.cc/Container/1A6366B3D5.html';

    const match = makeMatch({
      Id: 42,
      Type: 'movie',
      Title: 'The House That Jack Built',
      Fulltitle: 'The.House.That.Jack.Built.2018.German.EAC3.DL.1080p.BluRay.x265-VECTOR',
      ImdbId: 'tt4003440',
      Season: undefined,
      Episode: undefined,
      SeasonEpisodeKey: undefined,
      Links: JSON.stringify({ 'ddownload.com': directUrls }),
      CryptedLinks: JSON.stringify({ 'ddownload.com': containerUrl }),
    });

    const offlinePkg = makePkg(500, 'Offline Files', '/output/tt4003440-movie');
    const p1Unknown = makeLink(1, 'a81vaylyxsbj', '500', { url: directUrls[0], availability: 'UNKNOWN' });
    const p2Unknown = makeLink(2, 'fxplh3w53k8p', '500', { url: directUrls[1], availability: 'UNKNOWN' });
    const p1Offline = makeLink(1, 'a81vaylyxsbj', '500', { url: directUrls[0], availability: 'OFFLINE' });
    const p2Offline = makeLink(2, 'fxplh3w53k8p', '500', { url: directUrls[1], availability: 'OFFLINE' });

    const snapshots: CrawledLink[][] = [
      [], // pre-push snapshot
      [p1Unknown, p2Unknown], // poll 1: still checking availability
      [p1Offline, p2Offline], // poll 2: availability resolved to OFFLINE
      [p1Offline, p2Offline], // poll 3: stable OFFLINE
    ];
    let idx = 0;

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => [offlinePkg]),
      queryLinks: vi.fn(async () => snapshots[idx++] ?? [p1Offline, p2Offline]),
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

    // 1. First pushed direct links without autostart for verification
    expect(jdMocks.pushLinks).toHaveBeenNthCalledWith(1, {
      links: directUrls,
      packageName: match.Fulltitle,
      autostart: false,
      destinationFolder: 'tt4003440-movie',
    });
    // 2. Removed the dead direct links from linkgrabber (never moved them to download list)
    expect(jdMocks.removeLinks).toHaveBeenCalledWith([1, 2]);
    expect(jdMocks.moveToDownloadList).not.toHaveBeenCalled();
    // 3. Fell back to the CryptedLinks container with configured autostart
    expect(jdMocks.pushLinks).toHaveBeenNthCalledWith(2, {
      links: [containerUrl],
      packageName: match.Fulltitle,
      autostart: true,
      destinationFolder: 'tt4003440-movie',
    });
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(42, { Status: 'pushed' });
  });

  it('removes all direct links and falls back to container when even 1 part of a multi-part archive is OFFLINE', async () => {
    const directUrls = ['https://ddownload.com/p1', 'https://ddownload.com/p2', 'https://ddownload.com/p3'];
    const containerUrl = 'https://filecrypt.cc/Container/PARTIAL.html';

    const match = makeMatch({
      Id: 43,
      Type: 'movie',
      Fulltitle: 'Partial.Offline.2025.1080p-GRP',
      ImdbId: 'tt1111111',
      Season: undefined,
      Episode: undefined,
      SeasonEpisodeKey: undefined,
      Links: JSON.stringify({ 'ddownload.com': directUrls }),
      CryptedLinks: JSON.stringify({ 'ddownload.com': containerUrl }),
    });

    const pkg = makePkg(501, match.Fulltitle, '/output/tt1111111-movie');
    const crawled = [
      makeLink(1, 'part01.rar', '501', { url: directUrls[0], availability: 'ONLINE' }),
      makeLink(2, 'part02.rar', '501', { url: directUrls[1], availability: 'OFFLINE' }),
      makeLink(3, 'part03.rar', '501', { url: directUrls[2], availability: 'ONLINE' }),
    ];

    let call = 0;
    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => (call++ === 0 ? [] : crawled)),
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

    expect(jdMocks.removeLinks).toHaveBeenCalledWith([1, 2, 3]);
    expect(jdMocks.pushLinks).toHaveBeenCalledTimes(2);
    expect(jdMocks.pushLinks).toHaveBeenNthCalledWith(2, {
      links: [containerUrl],
      packageName: match.Fulltitle,
      autostart: true,
      destinationFolder: 'tt1111111-movie',
    });
  });

  it('moves verified online direct links directly to download list without touching CryptedLinks', async () => {
    const directUrls = ['https://ddownload.com/ok1', 'https://ddownload.com/ok2'];
    const containerUrl = 'https://filecrypt.cc/Container/UNUSED.html';

    const match = makeMatch({
      Id: 44,
      Type: 'movie',
      Fulltitle: 'Healthy.Movie.2025.1080p-GRP',
      ImdbId: 'tt2222222',
      Season: undefined,
      Episode: undefined,
      SeasonEpisodeKey: undefined,
      Links: JSON.stringify({ 'ddownload.com': directUrls }),
      CryptedLinks: JSON.stringify({ 'ddownload.com': containerUrl }),
    });

    const pkg = makePkg(502, match.Fulltitle, '/output/tt2222222-movie');
    const online = [
      makeLink(10, 'Healthy.Movie.part01.rar', '502', { url: directUrls[0], availability: 'ONLINE' }),
      makeLink(11, 'Healthy.Movie.part02.rar', '502', { url: directUrls[1], availability: 'ONLINE' }),
    ];

    let call = 0;
    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => [pkg]),
      queryLinks: vi.fn(async () => (call++ === 0 ? [] : online)),
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

    expect(jdMocks.pushLinks).toHaveBeenCalledTimes(1);
    expect(jdMocks.removeLinks).not.toHaveBeenCalled();
    expect(jdMocks.moveToDownloadList).toHaveBeenCalledWith([10, 11]);
    expect(jdMocks.startDownloads).toHaveBeenCalledTimes(1);
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(44, { Status: 'pushed' });
  });

  it('falls back to container when JDownloader discards offline direct links (0 links in linkgrabber)', async () => {
    const directUrls = ['https://ddownload.com/dropped1'];
    const containerUrl = 'https://filecrypt.cc/Container/FALLBACK.html';

    const match = makeMatch({
      Id: 45,
      Type: 'movie',
      Fulltitle: 'Dropped.Direct.2025.1080p-GRP',
      ImdbId: 'tt3333333',
      Season: undefined,
      Episode: undefined,
      SeasonEpisodeKey: undefined,
      Links: JSON.stringify({ 'ddownload.com': directUrls }),
      CryptedLinks: JSON.stringify({ 'ddownload.com': containerUrl }),
    });

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
      { pollDelayMs: 0, maxPollAttempts: 10, stablePollsRequired: 2, maxEmptyIdlePolls: 2, sleepFn: noopSleep },
    );

    expect(jdMocks.pushLinks).toHaveBeenCalledTimes(2);
    expect(jdMocks.pushLinks).toHaveBeenNthCalledWith(2, {
      links: [containerUrl],
      packageName: match.Fulltitle,
      autostart: true,
      destinationFolder: 'tt3333333-movie',
    });
    expect(nocodbMocks.updateMatchRelease).toHaveBeenCalledWith(45, { Status: 'pushed' });
  });

  it('does not mark match as pushed when all direct hoster candidates are OFFLINE and no container fallback exists', async () => {
    const match = makeMatch({
      Id: 46,
      Type: 'movie',
      Fulltitle: 'All.Dead.2025.1080p-GRP',
      ImdbId: 'tt4444444',
      Season: undefined,
      Episode: undefined,
      SeasonEpisodeKey: undefined,
      Links: JSON.stringify({
        'ddownload.com': ['https://ddownload.com/dead1'],
        'rapidgator.net': ['https://rapidgator.net/file/dead2'],
      }),
      CryptedLinks: '{}',
    });

    const ddlDead = makeLink(1, 'dead1', '600', { url: 'https://ddownload.com/dead1', availability: 'OFFLINE' });
    const rgDead = makeLink(2, 'dead2', '601', { url: 'https://rapidgator.net/file/dead2', availability: 'OFFLINE' });
    const snapshots: CrawledLink[][] = [
      [], [ddlDead], [ddlDead], // ddownload attempt
      [], [rgDead], [rgDead],   // rapidgator attempt
    ];
    let idx = 0;

    const jdMocks = {
      pushLinks: vi.fn(async () => {}),
      isCollecting: vi.fn(async () => false),
      queryPackages: vi.fn(async () => []),
      queryLinks: vi.fn(async () => snapshots[idx++] ?? []),
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

    expect(jdMocks.removeLinks).toHaveBeenNthCalledWith(1, [1]);
    expect(jdMocks.removeLinks).toHaveBeenNthCalledWith(2, [2]);
    expect(nocodbMocks.updateMatchRelease).not.toHaveBeenCalled();
  });
});
