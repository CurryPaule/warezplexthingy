import { describe, it, expect, vi } from 'vitest';
import { buildWarezDetailUrl, isNtfyConfigured, NtfyClient, safeNotifyError } from '../src/ntfy/client';

describe('ntfy client', () => {
  it('builds warez.cx detail deeplinks matching site slug format', () => {
    expect(buildWarezDetailUrl('HLCmGK0UmWMt', 'The House That Jack Built')).toBe(
      'https://warez.cx/detail/HLCmGK0UmWMt/The-House-That-Jack-Built',
    );
    expect(buildWarezDetailUrl('HLCmGK0UmWMt', '')).toBe('https://warez.cx/detail/HLCmGK0UmWMt');
    expect(buildWarezDetailUrl('zR0clXoaIsC4', 'Der Herr der Ringe: Die Ringe der Macht')).toBe(
      'https://warez.cx/detail/zR0clXoaIsC4/Der-Herr-der-Ringe-Die-Ringe-der-Macht',
    );
  });

  it('detects whether ntfy is configured via NTFY_TOPIC', () => {
    expect(isNtfyConfigured({ NTFY_TOPIC: undefined })).toBe(false);
    expect(isNtfyConfigured({ NTFY_TOPIC: '   ' })).toBe(false);
    expect(isNtfyConfigured({ NTFY_TOPIC: 'currypaule_warez_scraper' })).toBe(true);
  });

  it('publishes rich JSON notification with movie title, warez.cx deeplink, actions, and optional Bearer token', async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));

    const client = new NtfyClient(
      {
        NTFY_URL: 'https://ntfy.sh/',
        NTFY_TOPIC: 'currypaule_warez_scraper',
        NTFY_TOKEN: 'tk_secret123',
      },
      mockFetch as unknown as typeof fetch,
    );

    await client.notifyManualDownload(
      {
        Title: 'The House That Jack Built',
        Fulltitle: 'The.House.That.Jack.Built.2018.German.EAC3.DL.1080p.BluRay.x265-VECTOR',
        Type: 'movie',
        WarezUid: 'HLCmGK0UmWMt',
      },
      {
        reason: '10/10 offline part(s) (ddownload.com); container blocked by Cloudflare (ddownload.com)',
        metadataPath: 'tt4003440-movie',
        containerUrl: 'https://filecrypt.cc/Container/1A6366B3D5.html',
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tk_secret123',
    });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      topic: 'currypaule_warez_scraper',
      title: 'The House That Jack Built — Manual download needed',
      message: [
        'Release: The.House.That.Jack.Built.2018.German.EAC3.DL.1080p.BluRay.x265-VECTOR',
        'Reason: 10/10 offline part(s) (ddownload.com); container blocked by Cloudflare (ddownload.com)',
        'Download folder: tt4003440-movie',
      ].join('\n'),
      tags: ['warning', 'movie_camera'],
      priority: 4,
      click: 'https://warez.cx/detail/HLCmGK0UmWMt/The-House-That-Jack-Built',
      actions: [
        {
          action: 'view',
          label: 'Open on warez.cx',
          url: 'https://warez.cx/detail/HLCmGK0UmWMt/The-House-That-Jack-Built',
        },
        {
          action: 'view',
          label: 'Open Container',
          url: 'https://filecrypt.cc/Container/1A6366B3D5.html',
        },
      ],
    });
  });

  it('includes episode key and tv tag for series notifications and supports custom self-hosted URL', async () => {
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));

    const client = new NtfyClient(
      {
        NTFY_URL: 'https://ntfy.example.org',
        NTFY_TOPIC: 'my-series',
        NTFY_TOKEN: undefined,
      },
      mockFetch as unknown as typeof fetch,
    );

    await client.notifyManualDownload(
      {
        Title: 'Überleben',
        Fulltitle: 'Ueberleben.S01E05.German.1080p',
        Type: 'series',
        WarezUid: 'abc123',
        SeasonEpisodeKey: 'S01E05',
      },
      {
        reason: 'container blocked by Cloudflare (ddownload.com)',
        metadataPath: 'tt9999999-series-S01E05',
      },
    );

    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.org');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body.title).toBe('Überleben (S01E05) — Manual download needed');
    expect(body.tags).toEqual(['warning', 'tv']);
    expect(body.actions).toHaveLength(1);
  });

  it('publishes high-priority error alert via notifyError with warez.cx deeplink and truncation', async () => {
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new NtfyClient(
      { NTFY_URL: 'https://ntfy.sh', NTFY_TOPIC: 'alerts', NTFY_TOKEN: undefined },
      mockFetch as unknown as typeof fetch,
    );

    const manyErrors = Array.from({ length: 12 }, (_, i) => `Item ${i + 1}: boom`);
    await client.notifyError({
      source: 'enrich',
      summary: 'Doctor Who (uj5EeeSIMvJo) failed',
      errors: manyErrors,
      warezUid: 'uj5EeeSIMvJo',
      title: 'Doctor Who',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.title).toBe('Scraper error (enrich): Doctor Who (uj5EeeSIMvJo) failed');
    expect(body.tags).toEqual(['rotating_light', 'x']);
    expect(body.priority).toBe(4);
    expect(body.click).toBe('https://warez.cx/detail/uj5EeeSIMvJo/Doctor-Who');
    expect(body.actions).toEqual([
      {
        action: 'view',
        label: 'Open on warez.cx',
        url: 'https://warez.cx/detail/uj5EeeSIMvJo/Doctor-Who',
      },
    ]);
    expect(body.message).toContain('Item 10: boom');
    expect(body.message).toContain('…and 2 more error(s)');
  });

  it('safeNotifyError swallows ntfy failures without throwing', async () => {
    const mockFetch = vi.fn(async () => new Response('down', { status: 503 }));
    const client = new NtfyClient(
      { NTFY_URL: 'https://ntfy.sh', NTFY_TOPIC: 'alerts', NTFY_TOKEN: undefined },
      mockFetch as unknown as typeof fetch,
    );

    await expect(
      safeNotifyError(client, { source: 'enrich', summary: 'test error', errors: ['fail'] }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
