/**
 * XdgAppStorage — the default, universal `AppStorage` (ADR-0005) for the
 * CLI and any other non-VS-Code client.
 *
 * Splits the registry/bookkeeping directories across the three XDG Base
 * Directory roots, per their actual nature: `config.json` under
 * `XDG_CONFIG_HOME`, the bundle/source cache under `XDG_CACHE_HOME`, and
 * everything else (installed-bundle records, profiles, logs — genuine
 * persistent data, not cache or config) under `XDG_DATA_HOME`. Each
 * falls back to `~/.config`, `~/.cache`, `~/.local/share` respectively
 * (POSIX convention) when the corresponding env var is unset.
 *
 * Small persisted state (`getState`/`setState`) is backed by a single
 * `state.json` file under the data directory.
 * @module storage/xdg-app-storage
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';
import {
  xdgCacheDir,
  xdgConfigDir,
  xdgDataDir,
} from './xdg-base-dirs';
import type {
  XdgEnv,
} from './xdg-base-dirs';

const STATE_FILENAME = 'state.json';

export class XdgAppStorage implements AppStorage {
  private readonly paths: AppStoragePaths;
  private readonly statePath: string;

  public constructor(env: XdgEnv = process.env) {
    const dataDir = xdgDataDir(env);
    const configDir = xdgConfigDir(env);
    const cacheDir = xdgCacheDir(env);

    this.paths = {
      root: dataDir,
      config: path.join(configDir, 'config.json'),
      cache: cacheDir,
      sourcesCache: path.join(cacheDir, 'sources'),
      bundlesCache: path.join(cacheDir, 'bundles'),
      installed: path.join(dataDir, 'installed'),
      userInstalled: path.join(dataDir, 'installed', 'user'),
      profilesInstalled: path.join(dataDir, 'installed', 'profiles'),
      profiles: path.join(dataDir, 'profiles'),
      logs: path.join(dataDir, 'logs')
    };
    this.statePath = path.join(dataDir, STATE_FILENAME);
  }

  private async readState(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  public getPaths(): AppStoragePaths {
    return { ...this.paths };
  }

  public async getState<T>(key: string, defaultValue: T): Promise<T> {
    const state = await this.readState();
    return key in state ? (state[key] as T) : defaultValue;
  }

  public async setState<T>(key: string, value: T): Promise<void> {
    const state = await this.readState();
    state[key] = value;
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }
}
