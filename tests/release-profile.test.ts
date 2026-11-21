import { describe, it, expect } from 'vitest';
import {
  extractReleaseProfile,
  formatAutoTags,
  matchesAutoTags,
  sortReleasesByPreference,
  isReleaseOlderThanGracePeriod,
} from '../src/release-profile';
import type { WarezDetailRelease } from '../src/warez/types';

function makeRel(overrides: Partial<WarezDetailRelease> = {}): WarezDetailRelease {
  return {
    id: 1,
    uid: 'u1',
    user_id: 1,
    entry_id: 1,
    title: 'Show',
    fulltitle: 'Show.S01.GERMAN.DL.1080P.AMZN.WEB.H265.HDR-WAYNE',
    type: 'series',
    sub_type: 'series',
    links: {},
    crypted_links: {},
    size: 1000,
    parts: 1,
    group: 'WAYNE',
    quality: '1080p',
    video_stream: 'WEB',
    video_codec: 'H265',
    audio_stream: null,
    bitrate: null,
    lang: ['GER', 'ENG'],
    downloads: 10,
    source: 'web',
    options: {},
    created_at: '2026-11-18T12:00:00Z',
    updated_at: '2026-11-18T12:00:00Z',
    deleted_at: null,
    episode_updated_at: null,
    has_new_episode: false,
    display_priority: 1,
    ...overrides,
  };
}

describe('extractReleaseProfile & formatAutoTags', () => {
  it('extracts HDR, 265, AMZN, WAYNE from an HDR Amazon H265 release', () => {
    const rel = makeRel();
    const profile = extractReleaseProfile(rel);
    expect(profile).toEqual({
      dynamicRange: 'HDR',
      codec: '265',
      source: 'AMZN',
      group: 'WAYNE',
      isDL: true,
    });
    expect(formatAutoTags(profile)).toBe('HDR,265,AMZN,WAYNE');
  });

  it('extracts SDR, 264, SAUERKRAUT when no HDR/DV or streaming source is present', () => {
    const rel = makeRel({
      fulltitle: 'Marshals.S02.GERMAN.DL.1080P.WEB.H264-SAUERKRAUT',
      video_codec: 'H264',
      group: 'SAUERKRAUT',
    });
    const profile = extractReleaseProfile(rel);
    expect(profile.dynamicRange).toBe('SDR');
    expect(profile.codec).toBe('264');
    expect(profile.source).toBeUndefined();
    expect(profile.group).toBe('SAUERKRAUT');
    expect(formatAutoTags(profile)).toBe('SDR,264,SAUERKRAUT');
  });

  it('detects DV / DoVi as HDR and does not misidentify title words like "Mad Max" or "Blue Sky" as sources', () => {
    const dvRel = makeRel({
      fulltitle: 'Mad.Max.2026.GERMAN.2160p.DV.WEB.x265-iSSEYMiYAKE',
      video_codec: null,
      group: 'iSSEYMiYAKE',
      lang: ['GER'],
    });
    const profile = extractReleaseProfile(dvRel);
    expect(profile.dynamicRange).toBe('HDR');
    expect(profile.codec).toBe('265');
    expect(profile.source).toBeUndefined();
    expect(profile.isDL).toBe(false);
    expect(formatAutoTags(profile)).toBe('HDR,265,iSSEYMiYAKE');
  });

  it('does not treat WEB-DL as Dual Language, but does recognize DUAL and RTLP', () => {
    const germanOnlyWebDl = makeRel({
      fulltitle: 'Show.S01.German.1080p.RTLP.WEB-DL.H264-GLOTZE',
      video_codec: 'H264',
      group: 'GLOTZE',
      lang: ['GER'],
    });
    const p1 = extractReleaseProfile(germanOnlyWebDl);
    expect(p1.isDL).toBe(false);
    expect(p1.source).toBe('RTLP');
    expect(formatAutoTags(p1)).toBe('SDR,264,RTLP,GLOTZE');

    const dualWebDl = makeRel({
      fulltitle: 'Die.purpurnen.Flusse.German.1080p.RTLP.WEB-DL.DUAL.AAC2.0.H.264-GLOTZE',
      video_codec: 'H264',
      group: 'GLOTZE',
      lang: ['GER'],
    });
    expect(extractReleaseProfile(dualWebDl).isDL).toBe(true);
  });
});

describe('matchesAutoTags', () => {
  const hdrAmznWayne = makeRel({
    fulltitle: 'Show.S01.GERMAN.DL.1080P.AMZN.WEB.H265.HDR-WAYNE',
    video_codec: 'H265',
    group: 'WAYNE',
  });
  const hdrNfSauer = makeRel({
    fulltitle: 'Show.S01.GERMAN.DL.1080P.NF.WEB.H265.HDR-SAUERKRAUT',
    video_codec: 'H265',
    group: 'SAUERKRAUT',
  });
  const sdrAmznWayne = makeRel({
    fulltitle: 'Show.S01.GERMAN.DL.1080P.AMZN.WEB.H265-WAYNE',
    video_codec: 'H265',
    group: 'WAYNE',
  });
  const sdr264Wayne = makeRel({
    fulltitle: 'Show.S01.GERMAN.DL.1080P.AMZN.WEB.H264-WAYNE',
    video_codec: 'H264',
    group: 'WAYNE',
  });

  it('enforces HDR/SDR, codec, source, and group in strict mode', () => {
    expect(matchesAutoTags(hdrAmznWayne, 'HDR,265,AMZN,WAYNE', 'strict')).toBe(true);
    expect(matchesAutoTags(hdrNfSauer, 'HDR,265,AMZN,WAYNE', 'strict')).toBe(false);
    expect(matchesAutoTags(sdrAmznWayne, 'HDR,265,AMZN,WAYNE', 'strict')).toBe(false);
  });

  it('explicitly rejects HDR releases when AutoTags is pinned to SDR', () => {
    expect(matchesAutoTags(sdrAmznWayne, 'SDR,265,AMZN,WAYNE', 'strict')).toBe(true);
    expect(matchesAutoTags(hdrAmznWayne, 'SDR,265,AMZN,WAYNE', 'strict')).toBe(false);
  });

  it('relaxes group and source in relaxed mode while keeping HDR/SDR and codec strict', () => {
    expect(matchesAutoTags(hdrNfSauer, 'HDR,265,AMZN,WAYNE', 'relaxed')).toBe(true);
    expect(matchesAutoTags(sdrAmznWayne, 'HDR,265,AMZN,WAYNE', 'relaxed')).toBe(false);
    expect(matchesAutoTags(sdr264Wayne, 'SDR,265,AMZN,WAYNE', 'relaxed')).toBe(false);
    expect(matchesAutoTags(sdr264Wayne, 'SDR,264,NF,OTHER', 'relaxed')).toBe(true);
  });
});

describe('sortReleasesByPreference', () => {
  it('ranks releases down the ladder: HDR → 265 → 264 → fallback', () => {
    const relFallback = makeRel({ id: 1, fulltitle: 'Movie.2026.GERMAN.DL.1080p.WEB-GRP', video_codec: null });
    const rel264 = makeRel({ id: 2, fulltitle: 'Movie.2026.GERMAN.DL.1080p.WEB.H264-GRP', video_codec: 'H264' });
    const rel265 = makeRel({ id: 3, fulltitle: 'Movie.2026.GERMAN.DL.1080p.WEB.H265-GRP', video_codec: 'H265' });
    const relHdr = makeRel({ id: 4, fulltitle: 'Movie.2026.GERMAN.DL.1080p.WEB.H265.HDR-GRP', video_codec: 'H265' });

    const sorted = sortReleasesByPreference([relFallback, rel264, rel265, relHdr]);
    expect(sorted.map(r => r.id)).toEqual([4, 3, 2, 1]);
  });

  it('breaks ties within a tier by DL, then 265 inside HDR, then episode count, then priority/downloads', () => {
    const hdrSingleLang = makeRel({
      id: 1,
      fulltitle: 'Show.S01.GERMAN.1080p.WEB.H265.HDR-A',
      lang: ['GER'],
      options: { episode_count_in_season: '8' },
    });
    const hdrDl264 = makeRel({
      id: 2,
      fulltitle: 'Show.S01.GERMAN.DL.1080p.WEB.H264.HDR-B',
      video_codec: 'H264',
      lang: ['GER', 'ENG'],
      options: { episode_count_in_season: '8' },
    });
    const hdrDl265LowEp = makeRel({
      id: 3,
      fulltitle: 'Show.S01.GERMAN.DL.1080p.WEB.H265.HDR-C',
      video_codec: 'H265',
      lang: ['GER', 'ENG'],
      options: { episode_count_in_season: '4' },
    });
    const hdrDl265HighEp = makeRel({
      id: 4,
      fulltitle: 'Show.S01.GERMAN.DL.1080p.WEB.H265.HDR-D',
      video_codec: 'H265',
      lang: ['GER', 'ENG'],
      options: { episode_count_in_season: '6' },
    });

    const sorted = sortReleasesByPreference([hdrSingleLang, hdrDl264, hdrDl265LowEp, hdrDl265HighEp]);
    expect(sorted.map(r => r.id)).toEqual([4, 3, 2, 1]);
  });

  it('prefers HDR over SDR 264 even if SDR 264 has a slightly higher episode count', () => {
    const sdr264Ep5 = makeRel({
      id: 1,
      fulltitle: 'Show.S01.GERMAN.DL.1080p.WEB.H264-A',
      video_codec: 'H264',
      options: { episode_count_in_season: '5' },
    });
    const hdr265Ep4 = makeRel({
      id: 2,
      fulltitle: 'Show.S01.GERMAN.DL.1080p.WEB.H265.HDR-B',
      video_codec: 'H265',
      options: { episode_count_in_season: '4' },
    });

    const sorted = sortReleasesByPreference([sdr264Ep5, hdr265Ep4]);
    expect(sorted.map(r => r.id)).toEqual([2, 1]);
  });

  it('prefers PREFERRED_GROUPS order and BluRay over WEB within the same tier', () => {
    const webUnknown = makeRel({
      id: 1,
      fulltitle: 'Movie.2024.German.DL.1080p.WEB-DL.x265-RANDOM',
      video_codec: 'H265',
      video_stream: 'WEB-DL',
      group: 'RANDOM',
    });
    const blurayUnknown = makeRel({
      id: 2,
      fulltitle: 'Movie.2024.German.DL.1080p.BluRay.x265-OTHER',
      video_codec: 'H265',
      video_stream: 'BD',
      group: 'OTHER',
    });
    const webWayne = makeRel({
      id: 3,
      fulltitle: 'Movie.2024.German.DL.1080p.WEB-DL.x265-WAYNE',
      video_codec: 'H265',
      video_stream: 'WEB-DL',
      group: 'WAYNE',
    });
    const blurayVector = makeRel({
      id: 4,
      fulltitle: 'Die.purpurnen.Fluesse.2000.4K.REMASTERED.German.EAC3.DL.1080p.BluRay.x265-VECTOR',
      video_codec: 'MPEG-H H.265 / HEVC',
      video_stream: 'BD',
      lang: ['DE', 'FR'],
      group: 'VECTOR',
    });

    const sorted = sortReleasesByPreference(
      [webUnknown, blurayUnknown, webWayne, blurayVector],
      'VECTOR,WAYNE,ZeroTwo,WAREZCX,SAUERKRAUT',
    );
    expect(sorted.map(r => r.id)).toEqual([4, 3, 2, 1]);
  });
});

describe('isReleaseOlderThanGracePeriod', () => {
  const now = new Date('2026-11-21T12:00:00Z');

  it('checks episode_updated_at, updated_at, or created_at against fallbackHours', () => {
    const oldRel = makeRel({ episode_updated_at: '2026-11-19T11:00:00Z' }); // 49h ago
    const freshRel = makeRel({ episode_updated_at: '2026-11-20T12:00:00Z' }); // 24h ago

    expect(isReleaseOlderThanGracePeriod(oldRel, now, 48)).toBe(true);
    expect(isReleaseOlderThanGracePeriod(freshRel, now, 48)).toBe(false);
  });
});
