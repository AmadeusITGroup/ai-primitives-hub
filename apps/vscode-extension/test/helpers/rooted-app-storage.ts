/**
 * Test AppStorage rooted at one directory (config, caches and records all below
 * it) whose key/value state delegates to a mock `globalState`, so tests can
 * inject a sandboxed storage without touching the shared XDG layout.
 */
import * as path from 'node:path';
import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';
import {
  SharedStateFile,
} from '../../src/storage/extension-storage';

interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/**
 * AppStorage with every path below one root directory.
 * @param root
 * @param globalState
 */
export function rootedAppStorage(
  root: string,
  globalState?: MementoLike
): AppStorage {
  const paths: AppStoragePaths = {
    root,
    config: path.join(root, 'config.json'),
    cache: path.join(root, 'cache'),
    sourcesCache: path.join(root, 'cache', 'sources'),
    bundlesCache: path.join(root, 'cache', 'bundles'),
    installed: path.join(root, 'installed'),
    userInstalled: path.join(root, 'installed', 'user'),
    profilesInstalled: path.join(root, 'installed', 'profiles'),
    profiles: path.join(root, 'profiles'),
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state')
  };
  const memory = new Map<string, unknown>();
  return {
    getPaths: () => ({ ...paths }),
    getState: <T>(key: string, defaultValue: T): Promise<T> =>
      Promise.resolve(globalState === undefined
        ? (memory.has(key) ? memory.get(key) as T : defaultValue)
        : globalState.get<T>(key, defaultValue)),
    setState: async <T>(key: string, value: T): Promise<void> => {
      if (globalState === undefined) {
        memory.set(key, value);
      } else {
        await globalState.update(key, value);
      }
    }
  };
}

/**
 * Map-shaped view over the shared extension state file, for tests that used to
 * seed or inspect a mock `globalState` Map directly.
 */
export class SharedStateMap {
  private readonly state: SharedStateFile;

  public constructor(name = 'extension-state') {
    this.state = new SharedStateFile(name);
  }

  public get(key: string): unknown {
    return this.state.get<unknown>(key);
  }

  public set(key: string, value: unknown): this {
    void this.state.update(key, value);
    return this;
  }

  public has(key: string): boolean {
    return this.state.keys().includes(key);
  }

  public clear(): void {
    for (const key of this.state.keys()) {
      void this.state.update(key, undefined);
    }
  }

  public keys(): string[] {
    return [...this.state.keys()];
  }
}
