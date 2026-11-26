import type { Config } from '../config';
import type { OmbiMovieRequest, OmbiTvRequest } from './types';

const OMBI_FETCH_TIMEOUT_MS = 30_000;

/**
 * Ombi REST API client (v1).
 * Auth: `ApiKey` header with Ombi API key (found in Ombi Settings → Configuration → General).
 */
export class OmbiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: Pick<Config, 'OMBI_URL' | 'OMBI_API_KEY'>) {
    if (!config.OMBI_URL || !config.OMBI_API_KEY) {
      throw new Error('OMBI_URL and OMBI_API_KEY must be configured to use OmbiClient');
    }

    this.baseUrl = config.OMBI_URL.replace(/\/+$/, '');
    this.headers = {
      ApiKey: config.OMBI_API_KEY,
      Accept: 'application/json',
    };
  }

  private async fetchWithTimeout(url: string, method: 'GET' | 'POST'): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OMBI_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method,
        headers: this.headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchWithTimeout(url, 'GET');
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ombi GET ${path} → ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  /** Fetch all movie requests from Ombi */
  async getMovieRequests(): Promise<OmbiMovieRequest[]> {
    const data = await this.request<OmbiMovieRequest[]>('/api/v1/Request/movie');
    return Array.isArray(data) ? data : [];
  }

  /** Fetch all TV show requests (with nested childRequests / seasonRequests / episodes) from Ombi */
  async getTvRequests(): Promise<OmbiTvRequest[]> {
    const data = await this.request<OmbiTvRequest[]>('/api/v1/Request/tv');
    return Array.isArray(data) ? data : [];
  }

  /** Trigger Ombi's Plex Recently Added sync job (POST /api/v1/Job/plexrecentlyadded) */
  async triggerPlexRecentlyAddedSync(): Promise<void> {
    const url = `${this.baseUrl}/api/v1/Job/plexrecentlyadded`;
    const response = await this.fetchWithTimeout(url, 'POST');
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ombi POST /api/v1/Job/plexrecentlyadded → ${response.status}: ${text}`);
    }
  }

  /** Health / status check (returns HTTP status text or version info) */
  async getStatus(): Promise<string> {
    const url = `${this.baseUrl}/api/v1/Status`;
    const response = await this.fetchWithTimeout(url, 'GET');
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ombi GET /api/v1/Status → ${response.status}: ${text}`);
    }
    return response.text();
  }
}
