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
});
