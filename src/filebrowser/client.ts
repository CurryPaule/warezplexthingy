import type { Config } from '../config';

export interface FileBrowserItem {
  path: string;
  name: string;
  size: number;
  extension: string;
  modified: string;
  mode: number;
  isDir: boolean;
  isSymlink: boolean;
  type: string;
}

export interface FileBrowserListResponse {
  items: FileBrowserItem[];
  numDirs: number;
  numFiles: number;
  sorting: unknown;
  path: string;
  name: string;
  size: number;
  extension: string;
  modified: string;
  mode: number;
  isDir: boolean;
  isSymlink: boolean;
  type: string;
}

/**
 * FileBrowser REST API client.
 * Auth: JWT token via X-Auth header (not Bearer).
 *
 * Key endpoints:
 *   POST   /api/login                → JWT token string
 *   GET    /api/resources/{path}     → directory listing or file metadata
 *   POST   /api/resources/{path}/    → create directory (trailing slash)
 *   PATCH  /api/resources/{path}     → rename/move (body: { action: "rename", destination: "/new/path" })
 *   DELETE /api/resources/{path}     → delete file or directory
 */
export class FileBrowserClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;

  constructor(config: Config) {
    if (!config.FILEBROWSER_URL || !config.FILEBROWSER_USERNAME || !config.FILEBROWSER_PASSWORD) {
      throw new Error(
        'FileBrowser config missing. Set FILEBROWSER_URL, FILEBROWSER_USERNAME, and FILEBROWSER_PASSWORD.',
      );
    }
    this.baseUrl = config.FILEBROWSER_URL.replace(/\/+$/, '');
    this.username = config.FILEBROWSER_USERNAME;
    this.password = config.FILEBROWSER_PASSWORD;
  }

  /** Authenticate and cache the JWT token */
  async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser login failed: ${response.status} ${text}`);
    }

    this.token = await response.text();
  }

  private async ensureToken(): Promise<string> {
    if (!this.token) {
      await this.login();
    }
    return this.token!;
  }

  private normalizePath(rawPath: string): string {
    return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  }

  private encodePath(normalizedPath: string): string {
    return normalizedPath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }

  /**
   * Perform an authenticated fetch with automatic 401 re-login retry once.
   */
  private async fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const token = await this.ensureToken();
    const headers = {
      ...(init.headers as Record<string, string> | undefined),
      'X-Auth': token,
    };

    const response = await fetch(url, { ...init, headers });
    if (response.status !== 401) {
      return response;
    }

    // Token expired — re-login and retry once
    await this.login();
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'X-Auth': this.token!,
      },
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/resources${this.encodePath(path)}`;

    const response = await this.fetchWithAuth(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser ${method} ${path} → ${response.status}: ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  /** List contents of a directory */
  async listDir(dirPath: string): Promise<FileBrowserItem[]> {
    const normalized = this.normalizePath(dirPath);
    const data = await this.request<FileBrowserListResponse>('GET', normalized);
    return data.items ?? [];
  }

  /** Check if a path exists */
  async exists(filePath: string): Promise<boolean> {
    const normalized = this.normalizePath(filePath);
    try {
      await this.request<unknown>('GET', normalized);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a directory (recursively creates parents) */
  async createDir(dirPath: string): Promise<void> {
    const normalized = this.normalizePath(dirPath);
    // FileBrowser creates directories when posting to a path ending with /
    const url = `${this.baseUrl}/api/resources${this.encodePath(normalized)}/`;

    const response = await this.fetchWithAuth(url, { method: 'POST' });

    // 409 = already exists, which is fine
    if (!response.ok && response.status !== 409) {
      const text = await response.text();
      throw new Error(`FileBrowser createDir ${normalized} → ${response.status}: ${text}`);
    }
  }

  /** Move/rename a file or directory */
  async move(sourcePath: string, destPath: string): Promise<void> {
    const normalized = this.normalizePath(sourcePath);
    const normalizedDest = this.normalizePath(destPath);

    // FileBrowser uses PATCH with action and destination as query parameters
    const encodedDest = encodeURIComponent(normalizedDest);
    const url = `${this.baseUrl}/api/resources${this.encodePath(normalized)}?action=rename&destination=${encodedDest}`;
    const response = await this.fetchWithAuth(url, { method: 'PATCH' });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser move ${normalized} → ${normalizedDest}: ${response.status}: ${text}`);
    }
  }

  /** Delete a file or directory */
  async delete(filePath: string): Promise<void> {
    const normalized = this.normalizePath(filePath);
    await this.request<unknown>('DELETE', normalized);
  }

  /**
   * Recursively list all files in a directory.
   * Returns flat list of file items with full paths.
   */
  async listDirRecursive(dirPath: string): Promise<FileBrowserItem[]> {
    const items = await this.listDir(dirPath);
    const results: FileBrowserItem[] = [];

    for (const item of items) {
      if (item.isDir) {
        const subItems = await this.listDirRecursive(item.path);
        results.push(...subItems);
      } else {
        results.push(item);
      }
    }

    return results;
  }
}
