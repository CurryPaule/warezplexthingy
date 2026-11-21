import { z } from 'zod';

/**
 * Parse boolean environment variables properly.
 * Note: z.coerce.boolean() treats the non-empty string "false" as true (Boolean("false") === true).
 */
const envBoolean = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return val;
}, z.boolean());

const emptyToUndefined = z.preprocess((val) => {
  if (typeof val === 'string' && val.trim() === '') return undefined;
  return val;
}, z.string().optional());

const defaultQuality = z.preprocess((val) => {
  if (val === undefined || val === null) return '1080p';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return '1080p';
    if (trimmed.toLowerCase() === 'any') return '';
    return trimmed;
  }
  return val;
}, z.enum(['720p', '1080p', '2160p', '']));

const ConfigSchema = z.object({
  NOCODB_URL: z.string().url(),
  NOCODB_API_KEY: z.string().min(1),
  NOCODB_BASE_ID: z.string().min(1),
  NOCODB_WATCHLIST_TABLE_ID: z.string().min(1),
  NOCODB_MATCHES_TABLE_ID: z.string().min(1),
  NOCODB_STATE_TABLE_ID: z.string().min(1),

  WAREZ_API_BASE: z.string().url().default('https://api.warez.cx'),
  WAREZ_USER_AGENT: emptyToUndefined,
  WAREZ_COOKIE: emptyToUndefined,

  SEARCH_DELAY_MS: z.coerce.number().int().nonnegative().default(1500),
  DEFAULT_QUALITY: defaultQuality,
  DEFAULT_LANG: z.string().default('GER'),
  DEFAULT_TAGS: z.string().default(''),
  PREFERRED_GROUPS: z.string().default(''),
  AUTOTAGS_FALLBACK_HOURS: z.coerce.number().int().nonnegative().default(48),

  // Ombi (optional — enables `ombi-sync` endpoint and workflow step)
  OMBI_URL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().url().optional(),
  ),
  OMBI_API_KEY: emptyToUndefined,
  OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS: z.coerce.number().int().nonnegative().default(7),
  OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS: z.coerce.number().int().nonnegative().default(1),
  OMBI_PLEX_SYNC_DELAY_MS: z.coerce.number().int().nonnegative().default(15000),
  OMBI_WEBHOOK_SECRET: emptyToUndefined,
  OMBI_WEBHOOK_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(3000),

  // JDownloader (optional — required only for `push` mode)
  JDOWNLOADER_EMAIL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().email().optional(),
  ),
  JDOWNLOADER_PASSWORD: emptyToUndefined,
  JDOWNLOADER_DEVICE_NAME: emptyToUndefined,
  JDOWNLOADER_AUTOSTART: envBoolean.default(false),
  JDOWNLOADER_HOSTER_PRIORITY: z.string().default('ddownload,rapidgator'),

  // REST API server
  API_PORT: z.coerce.number().int().positive().default(3000),

  // FileBrowser (optional — required only for `sort` mode)
  FILEBROWSER_URL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().url().optional(),
  ),
  FILEBROWSER_USERNAME: emptyToUndefined,
  FILEBROWSER_PASSWORD: emptyToUndefined,
  FILEBROWSER_DOWNLOAD_PATH: emptyToUndefined, // e.g. "/downloads"
  MEDIA_MOVIES_PATH: emptyToUndefined,         // e.g. "/media/movies"
  MEDIA_SHOWS_PATH: emptyToUndefined,          // e.g. "/media/shows"
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  // Load .env file manually if not in Docker (Docker passes env vars directly)
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore file read errors — env vars may already be set
  }

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:');
    result.error.issues.forEach(issue => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  _config = result.data;
  return _config;
}
