import type { Config } from '../config';
import type { OmbiMovieRequest, OmbiTvRequest } from './types';

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

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });
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

  /** Health / status check (returns HTTP status text or version info) */
  async getStatus(): Promise<string> {
    const url = `${this.baseUrl}/api/v1/Status`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ombi GET /api/v1/Status → ${response.status}: ${text}`);
    }
    return response.text();
  }
}
