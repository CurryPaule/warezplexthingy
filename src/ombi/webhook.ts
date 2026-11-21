export interface OmbiWebhookPayload {
  notificationType?: string;
  requestId?: string | number;
  title?: string;
  type?: string;
  requestedUser?: string;
  applicationToken?: string;
  [key: string]: unknown;
}

export type OmbiWebhookAction =
  | 'test'
  | 'workflow-if-changes'
  | 'sync-only'
  | 'ignore';

/**
 * Classify an incoming Ombi webhook payload into the action the server should take:
 * - `Test`: respond 200 OK immediately without running any scraper.
 * - `RequestApproved` / `NewRequest` (or missing type): run Ombi sync; if any new active items
 *   were created or activated, immediately run search → enrich → push.
 *   (Handling `NewRequest` covers auto-approved requests, while unapproved requests produce 0
 *   active changes and stop right after the lightweight Ombi sync.)
 * - `RequestDeclined` / `RequestAvailable` / `PartiallyAvailable`: run Ombi sync only so
 *   NocoDB deactivates the item immediately.
 * - Other notification types (`Issue`, `Newsletter`, etc.): ignore.
 */
export function classifyOmbiWebhookEvent(payload?: OmbiWebhookPayload | null): {
  event: string;
  action: OmbiWebhookAction;
} {
  const rawType = typeof payload?.notificationType === 'string'
    ? payload.notificationType.trim()
    : '';
  const normalized = rawType.toLowerCase();

  if (!normalized) {
    return { event: 'unknown', action: 'workflow-if-changes' };
  }

  if (normalized === 'test') {
    return { event: rawType, action: 'test' };
  }

  if (
    normalized === 'requestapproved' ||
    normalized === 'newrequest' ||
    normalized === 'movieapproved' ||
    normalized === 'tvapproved'
  ) {
    return { event: rawType, action: 'workflow-if-changes' };
  }

  if (
    normalized === 'requestdeclined' ||
    normalized === 'requestdenied' ||
    normalized === 'requestavailable' ||
    normalized === 'partiallyavailable'
  ) {
    return { event: rawType, action: 'sync-only' };
  }

  return { event: rawType, action: 'ignore' };
}

/**
 * Check whether an incoming webhook request matches `OMBI_WEBHOOK_SECRET` (when configured).
 * Accepts the secret via:
 * - query parameter `?token=...`
 * - `ApplicationToken` header (Ombi's built-in Webhook Application Token field)
 * - `X-Webhook-Secret` header
 * - `Authorization: Bearer <secret>` header
 * - JSON body `applicationToken` field
 */
export function isWebhookAuthorized(
  expectedSecret: string | undefined,
  params: {
    queryToken?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: OmbiWebhookPayload | null;
  },
): boolean {
  if (!expectedSecret) return true;

  const firstHeader = (name: string): string | undefined => {
    const val = params.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0]?.trim();
    return typeof val === 'string' ? val.trim() : undefined;
  };

  const authHeader = firstHeader('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : authHeader;

  const bodyRecord = params.body as Record<string, unknown> | null | undefined;
  const bodyToken = (key: string): string | undefined => {
    const val = bodyRecord?.[key];
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  };

  const candidates = [
    params.queryToken?.trim(),
    firstHeader('applicationtoken'),
    firstHeader('x-application-token'),
    firstHeader('x-webhook-secret'),
    firstHeader('token'),
    bearerToken,
    bodyToken('applicationToken'),
    bodyToken('ApplicationToken'),
    bodyToken('token'),
    bodyToken('Token'),
  ].filter((c): c is string => Boolean(c));

  return candidates.includes(expectedSecret);
}
