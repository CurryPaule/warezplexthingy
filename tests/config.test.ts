import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config';

const BASE_ENV = {
  NOCODB_URL: 'http://localhost:8080',
  NOCODB_API_KEY: 'test-token',
  NOCODB_BASE_ID: 'p_base',
  NOCODB_WATCHLIST_TABLE_ID: 'md_watchlist',
  NOCODB_MATCHES_TABLE_ID: 'md_matches',
  NOCODB_STATE_TABLE_ID: 'md_state',
};

describe('parseConfig', () => {
  it('parses JDOWNLOADER_AUTOSTART="false" as false (not true)', () => {
    const cfg = parseConfig({ ...BASE_ENV, JDOWNLOADER_AUTOSTART: 'false' });
    expect(cfg.JDOWNLOADER_AUTOSTART).toBe(false);
  });

  it('parses JDOWNLOADER_AUTOSTART="true" and "1" as true', () => {
    expect(parseConfig({ ...BASE_ENV, JDOWNLOADER_AUTOSTART: 'true' }).JDOWNLOADER_AUTOSTART).toBe(true);
    expect(parseConfig({ ...BASE_ENV, JDOWNLOADER_AUTOSTART: '1' }).JDOWNLOADER_AUTOSTART).toBe(true);
  });

  it('defaults JDOWNLOADER_AUTOSTART to false when omitted', () => {
    expect(parseConfig({ ...BASE_ENV }).JDOWNLOADER_AUTOSTART).toBe(false);
  });

  it('defaults DEFAULT_QUALITY to 1080p, DEFAULT_LANG to GER, and DEFAULT_TAGS to empty', () => {
    const cfg = parseConfig({ ...BASE_ENV });
    expect(cfg.DEFAULT_QUALITY).toBe('1080p');
    expect(cfg.DEFAULT_LANG).toBe('GER');
    expect(cfg.DEFAULT_TAGS).toBe('');
    expect(cfg.OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS).toBe(7);
    expect(cfg.OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS).toBe(1);
  });

  it('treats empty DEFAULT_QUALITY as 1080p and "any" as empty string', () => {
    expect(parseConfig({ ...BASE_ENV, DEFAULT_QUALITY: '' }).DEFAULT_QUALITY).toBe('1080p');
    expect(parseConfig({ ...BASE_ENV, DEFAULT_QUALITY: 'any' }).DEFAULT_QUALITY).toBe('');
    expect(parseConfig({ ...BASE_ENV, DEFAULT_QUALITY: '2160p' }).DEFAULT_QUALITY).toBe('2160p');
  });

  it('accepts empty OMBI_URL and OMBI_API_KEY as undefined', () => {
    const cfg = parseConfig({ ...BASE_ENV, OMBI_URL: '', OMBI_API_KEY: '' });
    expect(cfg.OMBI_URL).toBeUndefined();
    expect(cfg.OMBI_API_KEY).toBeUndefined();
  });
});
