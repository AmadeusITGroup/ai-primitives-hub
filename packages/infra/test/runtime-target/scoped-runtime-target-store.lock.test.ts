/**
 * ScopedRuntimeTargetStore.withExclusive partial-acquire cleanup.
 * Faults injected at the external fs boundary only (pass-through open mock +
 * per-handle vi.spyOn on the captured FileHandle's own methods).
 */
import {
  existsSync,
} from 'node:fs';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ScopedRuntimeTargetStore,
} from '../../src/runtime-target/scoped-runtime-target-store';
import {
  XdgAppStorage,
} from '../../src/storage/xdg-app-storage';

const opened: realFs.FileHandle[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const actualOpen = actual.open.bind(actual);
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const h = await actualOpen(...args);
      opened.push(h);
      return h;
    })
  };
});

const rootEnv = (root: string) => ({
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'),
  XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
  XDG_CACHE_HOME: path.join(root, 'xdg', 'cache'),
  XDG_STATE_HOME: path.join(root, 'xdg', 'state'),
  TMPDIR: path.join(root, 'tmp')
});

async function storeFor(root: string) {
  await realFs.mkdir(path.join(root, 'tmp'), { recursive: true });
  return new ScopedRuntimeTargetStore({ storage: new XdgAppStorage(rootEnv(root)) });
}

const eio = (msg: string) => Object.assign(new Error(msg), { code: 'EIO' });

describe('ScopedRuntimeTargetStore.withExclusive init-failure cleanup', () => {
  let root = '';
  beforeEach(async () => {
    opened.length = 0;
    root = await mkdtemp(path.join(os.tmpdir(), 'rt-store-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const h of opened) {
      try {
        await h.close();
      } catch { /* best-effort fd hygiene */ }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('write fault: original error surfaces, lock inode removed, fd closed', async () => {
    const store = await storeFor(root);
    const lockPath = store.lockPath;
    let invoked = false;
    const actualOpen = vi.mocked(realFs.open).getMockImplementation()!;
    vi.mocked(realFs.open).mockImplementationOnce(async (...args: Parameters<typeof realFs.open>) => {
      const h = await actualOpen(...args);
      const orig = h.writeFile.bind(h);
      vi.spyOn(h, 'writeFile').mockImplementationOnce(async () => {
        await orig('partial');
        throw eio('injected write EIO');
      });
      return h;
    });
    await expect(store.withExclusive(async () => {
      invoked = true;
      return 1;
    })).rejects.toThrow('injected write EIO');
    expect(invoked).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    await expect(opened[0].stat()).rejects.toThrow(/file closed|EBADF/);
    await expect(store.withExclusive(async () => 42)).resolves.toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('close fault: retry close still releases fd and lock path', async () => {
    const store = await storeFor(root);
    const lockPath = store.lockPath;
    let invoked = false;
    const actualOpen = vi.mocked(realFs.open).getMockImplementation()!;
    vi.mocked(realFs.open).mockImplementationOnce(async (...args: Parameters<typeof realFs.open>) => {
      const h = await actualOpen(...args);
      vi.spyOn(h, 'close').mockRejectedValueOnce(eio('injected EIO close'));
      return h;
    });
    await expect(store.withExclusive(async () => {
      invoked = true;
      return 1;
    })).rejects.toThrow('injected EIO close');
    expect(invoked).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    await expect(opened[0].stat()).rejects.toThrow(/file closed|EBADF/);
    await expect(store.withExclusive(async () => 42)).resolves.toBe(42);
  });

  it('write fault + foreign lock replacement: foreign inode preserved', async () => {
    const store = await storeFor(root);
    const lockPath = store.lockPath;
    let invoked = false;
    const actualOpen = vi.mocked(realFs.open).getMockImplementation()!;
    vi.mocked(realFs.open).mockImplementationOnce(async (...args: Parameters<typeof realFs.open>) => {
      const h = await actualOpen(...args);
      const orig = h.writeFile.bind(h);
      vi.spyOn(h, 'writeFile').mockImplementationOnce(async () => {
        await orig('partial');
        await realFs.rm(lockPath, { force: true });
        await realFs.writeFile(lockPath, 'foreignToken');
        throw eio('injected EIO');
      });
      return h;
    });
    await expect(store.withExclusive(async () => {
      invoked = true;
      return 1;
    })).rejects.toThrow('injected EIO');
    expect(invoked).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(await realFs.readFile(lockPath, 'utf8')).toBe('foreignToken');
    await expect(opened[0].stat()).rejects.toThrow(/file closed|EBADF/);
    await expect(store.withExclusive(async () => 42)).rejects.toThrow(/locked/);
  });

  it('callback error after foreign token overwrite: init cleanup does not remove it', async () => {
    const store = await storeFor(root);
    const lockPath = store.lockPath;
    await expect(store.withExclusive(async () => {
      await realFs.writeFile(lockPath, 'foreign-token');
      throw new Error('original callback error');
    })).rejects.toThrow('original callback error');
    expect(existsSync(lockPath)).toBe(true);
    expect(await realFs.readFile(lockPath, 'utf8')).toBe('foreign-token');
    await expect(store.withExclusive(async () => 42)).rejects.toThrow(/locked/);
  });
});
