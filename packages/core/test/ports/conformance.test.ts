/**
 * Port conformance smoke tests.
 *
 * Ports are pure interfaces with no behavior of their own — real behavior
 * is tested against `infra`'s concrete adapters in Phase 3. What's worth
 * proving now, while the interfaces are brand new, is that each one is
 * actually implementable with a small, realistic hand-written double, and
 * that TypeScript accepts it structurally — the same doubles Phase 3's
 * tests (and, later, `app`'s) will use as a starting point.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  Clock,
} from '../../src/ports/clock';
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '../../src/ports/filesystem';
import type {
  GitHubApi,
} from '../../src/ports/github-api';
import type {
  HttpClient,
} from '../../src/ports/http';

class FixedClock implements Clock {
  public constructor(private readonly epochMs: number) {}

  public now(): number {
    return this.epochMs;
  }

  public nowIso(): string {
    return new Date(this.epochMs).toISOString();
  }
}

class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  public async readFile(path: string): Promise<string> {
    const contents = this.files.get(path);
    if (contents === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return contents;
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }

  public async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path)) as T;
  }

  public async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }

  public async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  public mkdir(): Promise<void> {
    // No-op: this in-memory double is flat and creates parents implicitly.
    return Promise.resolve();
  }

  public async readDir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }

  public async readDirEntries(path: string): Promise<DirEntry[]> {
    return (await this.readDir(path)).map((name) => ({ name, isDirectory: false }));
  }

  public async stat(path: string): Promise<FileStat> {
    const contents = await this.readFile(path);
    return {
      isDirectory: false,
      isFile: true,
      size: contents.length,
      mtimeMs: 0
    };
  }

  public async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class StaticGitHubApi implements GitHubApi {
  public constructor(private readonly jsonByPath: Record<string, unknown>) {}

  public async getJson<T>(pathOrUrl: string): Promise<T> {
    return this.jsonByPath[pathOrUrl] as T;
  }

  public async getText(pathOrUrl: string): Promise<string> {
    return String(this.jsonByPath[pathOrUrl]);
  }

  public async download(pathOrUrl: string): Promise<Uint8Array> {
    return new TextEncoder().encode(String(this.jsonByPath[pathOrUrl]));
  }
}

class StaticHttpClient implements HttpClient {
  public async fetch() {
    return {
      statusCode: 200,
      body: new TextEncoder().encode('ok'),
      finalUrl: 'https://example.com/resolved',
      headers: {}
    };
  }
}

describe('port conformance', () => {
  it('Clock: a fixed-time double implements now()/nowIso() consistently', () => {
    const clock = new FixedClock(0);
    expect(clock.now()).toBe(0);
    expect(clock.nowIso()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('FileSystem: an in-memory double supports the full read/write/exists/remove cycle', async () => {
    const fs = new InMemoryFileSystem();
    expect(await fs.exists('a.json')).toBe(false);
    await fs.writeJson('a.json', { hello: 'world' });
    expect(await fs.exists('a.json')).toBe(true);
    expect(await fs.readJson('a.json')).toEqual({ hello: 'world' });
    await fs.remove('a.json');
    expect(await fs.exists('a.json')).toBe(false);
  });

  it('GitHubApi: a static double resolves getJson/getText by path', async () => {
    const api = new StaticGitHubApi({ '/repos/o/r': { name: 'r' } });
    expect(await api.getJson('/repos/o/r')).toEqual({ name: 'r' });
  });

  it('HttpClient: a static double resolves fetch() to a well-shaped HttpResponse', async () => {
    const client = new StaticHttpClient();
    const response = await client.fetch();
    expect(response.statusCode).toBe(200);
    expect(response.finalUrl).toBe('https://example.com/resolved');
  });
});
