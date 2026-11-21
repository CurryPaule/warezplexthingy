import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server';
import { classifyOmbiWebhookEvent, isWebhookAuthorized } from '../src/ombi/webhook';
import { parseConfig } from '../src/config';
import type { OmbiSyncSummary } from '../src/scrapers/ombi-sync';

const BASE_ENV = {
  NOCODB_URL: 'http://localhost:8080',
  NOCODB_API_KEY: 'test-token',
  NOCODB_BASE_ID: 'p_base',
  NOCODB_WATCHLIST_TABLE_ID: 'md_watchlist',
  NOCODB_MATCHES_TABLE_ID: 'md_matches',
  NOCODB_STATE_TABLE_ID: 'md_state',
  OMBI_URL: 'https://ombi.example.com',
  OMBI_API_KEY: 'ombi-key',
  OMBI_WEBHOOK_DEBOUNCE_MS: '10',
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('classifyOmbiWebhookEvent', () => {
  it('classifies Ombi notification types properly', () => {
    expect(classifyOmbiWebhookEvent({ notificationType: 'Test' }).action).toBe('test');
    expect(classifyOmbiWebhookEvent({ notificationType: 'RequestApproved' }).action).toBe('workflow-if-changes');
    expect(classifyOmbiWebhookEvent({ notificationType: 'NewRequest' }).action).toBe('workflow-if-changes');
    expect(classifyOmbiWebhookEvent({ notificationType: 'RequestAvailable' }).action).toBe('sync-only');
    expect(classifyOmbiWebhookEvent({ notificationType: 'RequestDeclined' }).action).toBe('sync-only');
    expect(classifyOmbiWebhookEvent({ notificationType: 'Issue' }).action).toBe('ignore');
    expect(classifyOmbiWebhookEvent({}).action).toBe('workflow-if-changes');
  });
});

describe('isWebhookAuthorized', () => {
  it('allows any request when no secret is configured', () => {
    expect(isWebhookAuthorized(undefined, { headers: {} })).toBe(true);
  });

  it('validates secret via query token, ApplicationToken header, X-Webhook-Secret, Bearer, or body', () => {
    expect(isWebhookAuthorized('s3cr3t', { headers: {} })).toBe(false);
    expect(isWebhookAuthorized('s3cr3t', { queryToken: 's3cr3t', headers: {} })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: { applicationtoken: 's3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: { 'x-webhook-secret': 's3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: { authorization: 'Bearer s3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: { authorization: 's3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: { 'x-application-token': 's3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: {}, body: { applicationToken: 's3cr3t' } })).toBe(true);
    expect(isWebhookAuthorized('s3cr3t', { headers: {}, body: { token: 's3cr3t' } })).toBe(true);
  });
});

describe('POST /api/ombi-webhook', () => {
  it('rejects unauthorized requests when OMBI_WEBHOOK_SECRET is configured', async () => {
    const cfg = parseConfig({ ...BASE_ENV, OMBI_WEBHOOK_SECRET: 'my-secret' });
    const app = buildServer(cfg, { logger: false });

    const badRes = await app.inject({
      method: 'POST',
      url: '/api/ombi-webhook',
      payload: { notificationType: 'RequestApproved', title: 'Ronin' },
    });
    expect(badRes.statusCode).toBe(401);

    const goodRes = await app.inject({
      method: 'POST',
      url: '/api/ombi-webhook?token=my-secret',
      payload: { notificationType: 'Test' },
    });
    expect(goodRes.statusCode).toBe(200);
    expect(goodRes.json()).toMatchObject({ status: 'ok', action: 'test' });

    await app.close();
  });

  it('triggers ombi-sync → search → enrich → push in background when RequestApproved adds an active item', async () => {
    const cfg = parseConfig(BASE_ENV);
    const runOmbiSyncFn = vi.fn(async (): Promise<OmbiSyncSummary> => ({
      created: 1,
      createdActive: 1,
      activated: 0,
      deactivated: 0,
      updated: 0,
      unchanged: 5,
    }));
    const runSearchFn = vi.fn(async () => {});
    const runEnrichFn = vi.fn(async () => {});
    const runPushFn = vi.fn(async () => {});

    const app = buildServer(cfg, {
      logger: false,
      runOmbiSyncFn,
      runSearchFn,
      runEnrichFn,
      runPushFn,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ombi-webhook',
      payload: { notificationType: 'RequestApproved', title: 'Ronin', type: 'Movie' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'accepted',
      event: 'RequestApproved',
      action: 'workflow-if-changes',
    });

    await delay(50);

    expect(runOmbiSyncFn).toHaveBeenCalledTimes(1);
    expect(runSearchFn).toHaveBeenCalledTimes(1);
    expect(runEnrichFn).toHaveBeenCalledTimes(1);
    expect(runPushFn).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('skips search/enrich/push when NewRequest is unapproved (0 newly active items)', async () => {
    const cfg = parseConfig(BASE_ENV);
    const runOmbiSyncFn = vi.fn(async (): Promise<OmbiSyncSummary> => ({
      created: 0,
      createdActive: 0,
      activated: 0,
      deactivated: 0,
      updated: 0,
      unchanged: 5,
    }));
    const runSearchFn = vi.fn(async () => {});
    const runEnrichFn = vi.fn(async () => {});
    const runPushFn = vi.fn(async () => {});

    const app = buildServer(cfg, {
      logger: false,
      runOmbiSyncFn,
      runSearchFn,
      runEnrichFn,
      runPushFn,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ombi-webhook',
      payload: { notificationType: 'NewRequest', title: 'Pending Movie' },
    });

    expect(res.statusCode).toBe(200);
    await delay(50);

    expect(runOmbiSyncFn).toHaveBeenCalledTimes(1);
    expect(runSearchFn).not.toHaveBeenCalled();
    expect(runEnrichFn).not.toHaveBeenCalled();
    expect(runPushFn).not.toHaveBeenCalled();

    await app.close();
  });

  it('runs sync-only on RequestAvailable and coalesces rapid burst webhooks into one run', async () => {
    const cfg = parseConfig({ ...BASE_ENV, OMBI_WEBHOOK_DEBOUNCE_MS: '25' });
    const runOmbiSyncFn = vi.fn(async (): Promise<OmbiSyncSummary> => ({
      created: 2,
      createdActive: 2,
      activated: 0,
      deactivated: 0,
      updated: 0,
      unchanged: 5,
    }));
    const runSearchFn = vi.fn(async () => {});
    const runEnrichFn = vi.fn(async () => {});
    const runPushFn = vi.fn(async () => {});

    const app = buildServer(cfg, {
      logger: false,
      runOmbiSyncFn,
      runSearchFn,
      runEnrichFn,
      runPushFn,
    });

    // Rapid burst: RequestAvailable + two RequestApproved events within debounce window
    await app.inject({ method: 'POST', url: '/api/ombi-webhook', payload: { notificationType: 'RequestAvailable' } });
    await app.inject({ method: 'POST', url: '/api/ombi-webhook', payload: { notificationType: 'RequestApproved', title: 'Movie A' } });
    await app.inject({ method: 'POST', url: '/api/ombi-webhook', payload: { notificationType: 'RequestApproved', title: 'Movie B' } });

    await delay(80);

    // Coalesced into a single full run!
    expect(runOmbiSyncFn).toHaveBeenCalledTimes(1);
    expect(runSearchFn).toHaveBeenCalledTimes(1);
    expect(runEnrichFn).toHaveBeenCalledTimes(1);
    expect(runPushFn).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
