import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from './config';
import type { Config } from './config';
import { NocoDbClient } from './nocodb/client';
import { WarezClient } from './warez/api';
import { JDownloaderClient } from './jdownloader/client';
import { FileBrowserClient } from './filebrowser/client';
import { OmbiClient } from './ombi/client';
import {
  classifyOmbiWebhookEvent,
  isWebhookAuthorized,
  type OmbiWebhookPayload,
} from './ombi/webhook';
import { runOmbiSync, type OmbiSyncSummary } from './scrapers/ombi-sync';
import { runSearchScraper } from './scrapers/search';
import { runEnrichScraper } from './scrapers/enrich';
import { runPushScraper } from './scrapers/push';
import { sortDownload, parseDownloadMetadata as parseDownloadMetadataCheck } from './scrapers/sort';

export interface ServerDeps {
  logger?: boolean;
  runOmbiSyncFn?: () => Promise<OmbiSyncSummary>;
  runSearchFn?: () => Promise<void>;
  runEnrichFn?: () => Promise<void>;
  runPushFn?: () => Promise<void>;
}

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  // Accept any content type for POST requests (handles empty bodies from curl/PowerShell)
  app.addContentTypeParser('*', function (_req, payload, done) {
    let data = '';
    payload.on('data', (chunk: Buffer) => { data += chunk; });
    payload.on('end', () => {
      try {
        done(null, data ? JSON.parse(data) : {});
      } catch {
        done(null, data);
      }
    });
  });

  const nocodb = new NocoDbClient(config);
  const warez = new WarezClient(config);

  const execOmbiSync = deps.runOmbiSyncFn ?? (async () => {
    const ombi = new OmbiClient(config);
    return runOmbiSync(ombi, nocodb, config);
  });

  const execSearch = deps.runSearchFn ?? (async () => {
    await runSearchScraper(warez, nocodb, config);
  });

  const execEnrich = deps.runEnrichFn ?? (async () => {
    await runEnrichScraper(warez, nocodb, config);
  });

  const execPush = deps.runPushFn ?? (async () => {
    let jdownloader: JDownloaderClient | null = null;
    try {
      jdownloader = new JDownloaderClient(config);
      await jdownloader.connect();
      await runPushScraper(jdownloader, nocodb, config);
    } finally {
      if (jdownloader) {
        await jdownloader.disconnect().catch(() => {});
      }
    }
  });

  // Serialized workflow execution so concurrent webhooks & cron never overlap
  type BackgroundMode = 'workflow-if-changes' | 'sync-only';
  let workflowInFlight = false;
  let pendingWebhookMode: BackgroundMode | null = null;
  let ombiWebhookTimer: ReturnType<typeof setTimeout> | null = null;

  async function executePipeline(mode: 'full' | BackgroundMode): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    let syncSummary: OmbiSyncSummary | null = null;

    // Step 0: Ombi Sync
    if (config.OMBI_URL && config.OMBI_API_KEY) {
      try {
        syncSummary = await execOmbiSync();
        results.ombiSync = 'ok';
      } catch (err) {
        app.log.error(err, 'Workflow: ombi-sync failed');
        results.ombiSync = `error: ${err}`;
      }
    } else {
      results.ombiSync = 'skipped (not configured)';
    }

    if (mode === 'sync-only') {
      return results;
    }

    if (mode === 'workflow-if-changes' && syncSummary) {
      const newlyActive = syncSummary.createdActive + syncSummary.activated;
      if (newlyActive === 0) {
        console.log('  ⏩ Ombi webhook: no newly active items — skipping search/enrich/push');
        results.search = 'skipped (no newly active items)';
        results.enrich = 'skipped (no newly active items)';
        results.push = 'skipped (no newly active items)';
        return results;
      }
    }

    // Step 1: Search
    try {
      await execSearch();
      results.search = 'ok';
    } catch (err) {
      app.log.error(err, 'Workflow: search failed');
      results.search = `error: ${err}`;
    }

    // Step 2: Enrich
    try {
      await execEnrich();
      results.enrich = 'ok';
    } catch (err) {
      app.log.error(err, 'Workflow: enrich failed');
      results.enrich = `error: ${err}`;
    }

    // Step 3: Push
    try {
      await execPush();
      results.push = 'ok';
    } catch (err) {
      app.log.error(err, 'Workflow: push failed');
      results.push = `error: ${err}`;
    }

    return results;
  }

  const drainPendingWebhook = async () => {
    if (workflowInFlight || !pendingWebhookMode) return;
    workflowInFlight = true;
    try {
      while (pendingWebhookMode) {
        const mode = pendingWebhookMode;
        pendingWebhookMode = null;
        console.log(`▶ Ombi webhook background run starting (mode: ${mode})...`);
        await executePipeline(mode);
      }
    } finally {
      workflowInFlight = false;
    }
  };

  const scheduleOmbiWebhookRun = (mode: BackgroundMode) => {
    // Coalesce modes: 'workflow-if-changes' takes precedence over 'sync-only'
    if (pendingWebhookMode !== 'workflow-if-changes') {
      pendingWebhookMode = mode;
    }

    if (workflowInFlight) {
      // Active run will automatically drain pendingWebhookMode when it finishes
      return;
    }

    if (ombiWebhookTimer) clearTimeout(ombiWebhookTimer);
    const delayMs = config.OMBI_WEBHOOK_DEBOUNCE_MS;
    ombiWebhookTimer = setTimeout(() => {
      ombiWebhookTimer = null;
      void drainPendingWebhook();
    }, delayMs);
  };

  // Debounced background trigger for Ombi's Plex Recently Added sync after /api/sort
  let ombiPlexSyncTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleOmbiPlexSync = () => {
    if (!config.OMBI_URL || !config.OMBI_API_KEY) return;
    if (ombiPlexSyncTimer) clearTimeout(ombiPlexSyncTimer);

    const delayMs = config.OMBI_PLEX_SYNC_DELAY_MS;
    console.log(`  🔔 Scheduled Ombi Plex Recently Added sync in ${Math.round(delayMs / 1000)}s`);

    ombiPlexSyncTimer = setTimeout(() => {
      ombiPlexSyncTimer = null;
      const ombi = new OmbiClient(config);
      ombi.triggerPlexRecentlyAddedSync()
        .then(() => {
          console.log('  ✅ Triggered Ombi Plex Recently Added sync');
        })
        .catch((err) => {
          app.log.warn(err, 'Failed to trigger Ombi Plex Recently Added sync');
        });
    }, delayMs);
  };

  app.addHook('onClose', async () => {
    if (ombiPlexSyncTimer) {
      clearTimeout(ombiPlexSyncTimer);
      ombiPlexSyncTimer = null;
    }
    if (ombiWebhookTimer) {
      clearTimeout(ombiWebhookTimer);
      ombiWebhookTimer = null;
    }
    pendingWebhookMode = null;
  });

  // ─── Health ──────────────────────────────────────────────────────────────────

  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ─── Ombi Sync ───────────────────────────────────────────────────────────────

  app.post('/api/ombi-sync', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!config.OMBI_URL || !config.OMBI_API_KEY) {
      reply.status(500);
      return {
        status: 'error',
        mode: 'ombi-sync',
        error: 'OMBI_URL and OMBI_API_KEY must be configured',
      };
    }

    try {
      const summary = await execOmbiSync();
      return { status: 'ok', mode: 'ombi-sync', summary };
    } catch (err) {
      app.log.error(err, 'Ombi sync failed');
      reply.status(500);
      return { status: 'error', mode: 'ombi-sync', error: String(err) };
    }
  });

  // ─── Ombi Webhook (instant trigger on request approval) ──────────────────────

  interface OmbiWebhookQuery {
    token?: string;
  }

  app.post(
    '/api/ombi-webhook',
    async (
      req: FastifyRequest<{ Body: OmbiWebhookPayload; Querystring: OmbiWebhookQuery }>,
      reply: FastifyReply,
    ) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as OmbiWebhookPayload;

      if (
        !isWebhookAuthorized(config.OMBI_WEBHOOK_SECRET, {
          queryToken: req.query?.token,
          headers: req.headers,
          body,
        })
      ) {
        reply.status(401);
        return { status: 'error', mode: 'ombi-webhook', error: 'Unauthorized webhook token' };
      }

      if (!config.OMBI_URL || !config.OMBI_API_KEY) {
        reply.status(500);
        return {
          status: 'error',
          mode: 'ombi-webhook',
          error: 'OMBI_URL and OMBI_API_KEY must be configured',
        };
      }

      const { event, action } = classifyOmbiWebhookEvent(body);
      const titleInfo = body.title ? ` ("${body.title}")` : '';
      console.log(`  📨 Ombi webhook received: event=${event}${titleInfo} → action=${action}`);

      if (action === 'test' || action === 'ignore') {
        return { status: 'ok', mode: 'ombi-webhook', event, action };
      }

      scheduleOmbiWebhookRun(action);
      return { status: 'accepted', mode: 'ombi-webhook', event, action };
    },
  );

  // ─── Search ──────────────────────────────────────────────────────────────────

  app.post('/api/search', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await runSearchScraper(warez, nocodb, config);
      return { status: 'ok', mode: 'search' };
    } catch (err) {
      app.log.error(err, 'Search scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'search', error: String(err) };
    }
  });

  // ─── Enrich ──────────────────────────────────────────────────────────────────

  app.post('/api/enrich', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await runEnrichScraper(warez, nocodb, config);
      return { status: 'ok', mode: 'enrich' };
    } catch (err) {
      app.log.error(err, 'Enrich scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'enrich', error: String(err) };
    }
  });

  // ─── Push ────────────────────────────────────────────────────────────────────

  app.post('/api/push', async (_req: FastifyRequest, reply: FastifyReply) => {
    let jdownloader: JDownloaderClient | null = null;
    try {
      jdownloader = new JDownloaderClient(config);
      await jdownloader.connect();
      await runPushScraper(jdownloader, nocodb, config);
      return { status: 'ok', mode: 'push' };
    } catch (err) {
      app.log.error(err, 'Push scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'push', error: String(err) };
    } finally {
      if (jdownloader) {
        await jdownloader.disconnect().catch(() => {});
      }
    }
  });

  // ─── Workflow (full pipeline) ────────────────────────────────────────────────

  app.post('/api/workflow', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (workflowInFlight) {
      reply.status(409);
      return {
        status: 'busy',
        mode: 'workflow',
        error: 'A workflow run is already in progress',
      };
    }

    workflowInFlight = true;
    try {
      const results = await executePipeline('full');

      const hasErrors = Object.values(results).some(v => v.startsWith('error'));
      if (hasErrors) {
        reply.status(207); // Multi-Status: some steps may have failed
      }

      return { status: hasErrors ? 'partial' : 'ok', mode: 'workflow', results };
    } catch (err) {
      app.log.error(err, 'Workflow failed');
      reply.status(500);
      return { status: 'error', mode: 'workflow', error: String(err) };
    } finally {
      workflowInFlight = false;
      // Drain any webhook event that arrived while /api/workflow was executing
      if (pendingWebhookMode) {
        void drainPendingWebhook();
      }
    }
  });

  // ─── Sort (webhook target from JDownloader) ──────────────────────────────────

  interface SortBody {
    downloadPath?: string;   // relative path from JDownloader, e.g. "tt1234567-movie/Release.Name"
  }

  app.post('/api/sort', async (req: FastifyRequest<{ Body: SortBody }>, reply: FastifyReply) => {
    const { downloadPath } = req.body || {};

    if (!downloadPath) {
      reply.status(400);
      return {
        status: 'error',
        error: '"downloadPath" must be provided (relative path, e.g. "tt1234567-movie/Release.Name")',
      };
    }

    if (!config.FILEBROWSER_DOWNLOAD_PATH) {
      reply.status(500);
      return {
        status: 'error',
        error: 'FILEBROWSER_DOWNLOAD_PATH is not configured',
      };
    }

    // Parse the relative path to find the metadata-encoded directory segment.
    // JDownloader eventscript sends: "tt36586751-movie/Extrawurst 2026 German 1080p BluRay x264-TM"
    const cleanPath = downloadPath.replace(/\/+$/, '').replace(/^\/+/, '');
    const segments = cleanPath.split('/').filter(Boolean);

    let metadataDirName: string | undefined;

    for (const segment of segments) {
      if (parseDownloadMetadataCheck(segment)) {
        metadataDirName = segment;
        break;
      }
    }

    if (!metadataDirName) {
      reply.status(400);
      return {
        status: 'error',
        error: `No metadata directory found in path "${downloadPath}". Expected a segment like "tt1234567-movie" or "tt1234567-series-S02E05".`,
      };
    }

    // Combine FILEBROWSER_DOWNLOAD_PATH with the relative path to get the full FileBrowser path
    const basePath = config.FILEBROWSER_DOWNLOAD_PATH.replace(/\/+$/, '');
    const scanPath = `${basePath}/${cleanPath}`;

    try {
      const fb = new FileBrowserClient(config);
      const result = await sortDownload(fb, nocodb, config, metadataDirName, scanPath);

      if (result.success) {
        scheduleOmbiPlexSync();
        return {
          status: 'ok',
          mode: 'sort',
          destination: result.destination,
          movedFiles: result.movedFiles,
        };
      } else {
        reply.status(422);
        return {
          status: 'error',
          mode: 'sort',
          error: result.error,
        };
      }
    } catch (err) {
      app.log.error(err, 'Sort failed');
      reply.status(500);
      return { status: 'error', mode: 'sort', error: String(err) };
    }
  });

  return app;
}

/** Start the Fastify server */
export async function startServer(config: Config): Promise<void> {
  const app = buildServer(config);

  try {
    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
    console.log(`🚀 API server running on http://0.0.0.0:${config.API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
