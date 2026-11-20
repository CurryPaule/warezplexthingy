import { describe, it, expect } from 'vitest';
import {
  buildEpisodesPattern,
  extractEpisode,
  extractSeason,
  extractSeasonEpisodeKey,
  extractTitleFromFulltitle,
  formatSeasonEpisodeKey,
  isSeasonPackFulltitle,
  matchesQuality,
  matchesTags,
  meetsLanguage,
  parseEpisodeRange,
} from '../src/matcher';

describe('matcher episode & season extraction', () => {
  it('extracts season from both season packs and individual episode releases', () => {
    expect(extractSeason('Der.Herr.der.Ringe.S02.GERMAN.DL.1080P.WEB.H264-WAYNE')).toBe(2);
    expect(extractSeason('Der.Herr.der.Ringe.S02E05.GERMAN.DL.1080P.WEB.H264-WAYNE')).toBe(2);
    expect(extractSeason('Show.S01E04E05.1080p')).toBe(1);
    expect(extractSeason('Movie.2024.German.1080p')).toBeNull();
  });

  it('extracts episode numbers and detects season packs', () => {
    expect(extractEpisode('Der.Herr.der.Ringe.S02E05.GERMAN.1080p')).toBe(5);
    expect(extractEpisode('Anime.S01E105.GERMAN.1080p')).toBe(105);
    expect(extractEpisode('Der.Herr.der.Ringe.S02.GERMAN.1080p')).toBeNull();

    expect(isSeasonPackFulltitle('Der.Herr.der.Ringe.S02.GERMAN.1080p')).toBe(true);
    expect(isSeasonPackFulltitle('Der.Herr.der.Ringe.S02E05.GERMAN.1080p')).toBe(false);
  });

  it('extracts clean title from fulltitle including SxxExx and year-prefixed titles', () => {
    expect(extractTitleFromFulltitle('Mating.Season.S01.GERMAN.DL.1080p')).toBe('mating season');
    expect(extractTitleFromFulltitle('Mating.Season.S01E04.GERMAN.DL.1080p')).toBe('mating season');
    expect(extractTitleFromFulltitle('1917.2019.German.DL.2160p.UHD')).toBe('1917');
  });

  it('extracts season/episode dedup key', () => {
    expect(extractSeasonEpisodeKey('Show.S02E05.1080p')).toBe('S02E05');
    expect(extractSeasonEpisodeKey('Show.S02.1080p')).toBe('S02');
    expect(extractSeasonEpisodeKey('Movie.2024.1080p')).toBeNull();
  });
});

describe('episode range formatting, parsing, and matching', () => {
  it('formats single episodes and ranges', () => {
    expect(formatSeasonEpisodeKey(2, 5)).toBe('S02E05');
    expect(formatSeasonEpisodeKey(2, 5, 5)).toBe('S02E05');
    expect(formatSeasonEpisodeKey(2, 4, 6)).toBe('S02E04-E06');
    expect(formatSeasonEpisodeKey(1, 1, 10)).toBe('S01E01-E10');
    expect(formatSeasonEpisodeKey(null, 4, 6)).toBe('E04-E06');
    expect(formatSeasonEpisodeKey(undefined, 7)).toBe('E07');
  });

  it('parses single keys, range keys, and fallbacks', () => {
    expect(parseEpisodeRange('S02E04-E06')).toEqual({
      season: 2,
      fromEpisode: 4,
      toEpisode: 6,
      episodes: [4, 5, 6],
    });

    expect(parseEpisodeRange('S02E04-06')).toEqual({
      season: 2,
      fromEpisode: 4,
      toEpisode: 6,
      episodes: [4, 5, 6],
    });

    expect(parseEpisodeRange('S02E05')).toEqual({
      season: 2,
      fromEpisode: 5,
      toEpisode: 5,
      episodes: [5],
    });

    expect(parseEpisodeRange('E04-E06', 3)).toEqual({
      season: 3,
      fromEpisode: 4,
      toEpisode: 6,
      episodes: [4, 5, 6],
    });

    expect(parseEpisodeRange('S02', undefined, 6)).toEqual({
      season: 2,
      fromEpisode: 6,
      toEpisode: 6,
      episodes: [6],
    });

    expect(parseEpisodeRange('S02')).toBeNull();
    expect(parseEpisodeRange(undefined, 2, 5)).toEqual({
      season: 2,
      fromEpisode: 5,
      toEpisode: 5,
      episodes: [5],
    });
  });

  it('builds regex matching all episodes in a range without false positives', () => {
    const pattern = buildEpisodesPattern(2, [4, 5, 6]);

    // Target episodes match (including separator and padding variants)
    expect(pattern.test('LOTR.S02E04.German.1080p.part01.rar')).toBe(true);
    expect(pattern.test('LOTR.S02E05.German.1080p.part02.rar')).toBe(true);
    expect(pattern.test('LOTR.S02E06.German.1080p.part03.rar')).toBe(true);
    expect(pattern.test('LOTR.S02.E05.German.1080p.part01.rar')).toBe(true);
    expect(pattern.test('LOTR.S02E5.German.1080p.part01.rar')).toBe(true);
    expect(pattern.test('LOTR.S02E04E05.German.1080p.part01.rar')).toBe(true);

    // Non-target episodes & false-prefix digits do NOT match
    expect(pattern.test('LOTR.S02E01.German.1080p.part01.rar')).toBe(false);
    expect(pattern.test('LOTR.S02E03.German.1080p.part01.rar')).toBe(false);
    expect(pattern.test('LOTR.S02E07.German.1080p.part01.rar')).toBe(false);
    expect(pattern.test('LOTR.S02E14.German.1080p.part01.rar')).toBe(false);
    expect(pattern.test('LOTR.S02E40.German.1080p.part01.rar')).toBe(false);
    expect(pattern.test('LOTR.S01E05.German.1080p.part01.rar')).toBe(false);
  });
});

describe('quality, language, and tags filters', () => {
  it('matches known and unknown quality values accurately', () => {
    expect(matchesQuality('2160p', '4k')).toBe(true);
    expect(matchesQuality('1080p', '1080p')).toBe(true);
    expect(matchesQuality('720p', '1080p')).toBe(false);
    expect(matchesQuality('HDTV', '8k')).toBe(false);
    expect(matchesQuality('HDTV', 'hdtv')).toBe(true);
  });

  it('matches language via API array or fulltitle fallback', () => {
    expect(meetsLanguage(['GER', 'ENG'], 'GER,ENG')).toBe(true);
    expect(meetsLanguage(null, 'GER,ENG', 'Show.S01.GERMAN.DL.1080p')).toBe(true);
    expect(meetsLanguage(null, 'GER,ENG', 'Show.S01.GERMAN.1080p')).toBe(false);
  });

  it('matches tags as comma string or array', () => {
    expect(matchesTags('Show.S02.GERMAN.DL.1080p.HDR.H265-GRP', ['HDR', 'H265'])).toBe(true);
    expect(matchesTags('Show.S02.GERMAN.DL.1080p.HDR.H265-GRP', 'HDR,WEB')).toBe(false);
  });
});
