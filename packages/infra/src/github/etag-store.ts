/**
 * Persistent ETag store.
 *
 * Keeps `{ url -> etag }` across runs so the warm path can send
 * `If-None-Match` on every polling call (e.g. `/commits/:ref`). GitHub
 * returns 304 for unchanged endpoints, which skips the rate-limit cost
 * on the endpoints that honour it and costs ~nothing on the wire.
 *
 * Resilience:
 *   - Atomic writes (tmp + rename) so a SIGKILL mid-save can't corrupt.
 *   - Corrupt JSON on open is silently reset — the worst case is one
 *     warm run paying the full budget again.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface EtagEntry {
  etag: string;
  /** Optional cached body; used for 304 replay. */
  value?: unknown;
}

export class EtagStore {
  private readonly map: Map<string, EtagEntry>;
  private dirty = false;

  private constructor(private readonly file: string, initial: Record<string, EtagEntry | string>) {
    this.map = new Map();
    for (const [k, v] of Object.entries(initial)) {
      this.map.set(k, typeof v === 'string' ? { etag: v } : v);
    }
  }

  public static async open(file: string): Promise<EtagStore> {
    let initial: Record<string, EtagEntry | string> = {};
    try {
      const raw = await fsPromises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { etags?: Record<string, EtagEntry | string> };
      if (parsed && typeof parsed === 'object' && parsed.etags && typeof parsed.etags === 'object') {
        initial = parsed.etags;
      }
    } catch {
      // missing or corrupt — reset
    }
    return new EtagStore(file, initial);
  }

  public get(url: string): string | undefined {
    return this.map.get(url)?.etag;
  }

  public getEntry(url: string): EtagEntry | undefined {
    return this.map.get(url);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Intentionally async for interface compatibility
  public async set(url: string, etag: string, value?: unknown): Promise<void> {
    const prev = this.map.get(url);
    if (prev?.etag !== etag || prev?.value !== value) {
      this.map.set(url, { etag, value });
      this.dirty = true;
    }
  }

  public delete(url: string): void {
    if (this.map.delete(url)) {
      this.dirty = true;
    }
  }

  public clear(): void {
    if (this.map.size > 0) {
      this.map.clear();
      this.dirty = true;
    }
  }

  public size(): number {
    return this.map.size;
  }

  public async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const payload = JSON.stringify({ etags: Object.fromEntries(this.map) });
    await fsPromises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(tmp, payload, 'utf8');
    await fsPromises.rename(tmp, this.file);
    this.dirty = false;
  }
}
