/**
 * VsCodeAppStorage — the VS Code extension's own `AppStorage` (ADR-0005)
 * adapter, backed by `context.globalStorageUri`/`context.globalState`.
 *
 * Deliberately keeps the extension's existing on-disk layout exactly
 * as-is (single root under `globalStorageUri`, unlike `infra`'s
 * `XdgAppStorage` which splits config/cache/data across three XDG
 * bases) — real users' data already lives here (ADR-0005 decision 3).
 */

import * as path from 'node:path';
import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';
import {
  USER_RECORD_FILE_NAME,
} from '@ai-primitives-hub/core';
import {
  xdgConfigDir,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';

export class VsCodeAppStorage implements AppStorage {
  private readonly paths: AppStoragePaths;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const storagePath = context.globalStorageUri.fsPath;

    this.paths = {
      root: storagePath,
      config: path.join(storagePath, 'config.json'),
      cache: path.join(storagePath, 'cache'),
      sourcesCache: path.join(storagePath, 'cache', 'sources'),
      bundlesCache: path.join(storagePath, 'cache', 'bundles'),
      installed: path.join(storagePath, 'installed'),
      userInstalled: path.join(storagePath, 'installed', 'user'),
      profilesInstalled: path.join(storagePath, 'installed', 'profiles'),
      profiles: path.join(storagePath, 'profiles'),
      logs: path.join(storagePath, 'logs'),
      // The user record is per machine, not per profile: it lives in the same
      // XDG config folder the CLI uses, never under globalStorageUri (BR14.1).
      userRecord: path.join(xdgConfigDir(process.env), USER_RECORD_FILE_NAME)
    };
  }

  public getPaths(): AppStoragePaths {
    return { ...this.paths };
  }

  public getState<T>(key: string, defaultValue: T): Promise<T> {
    return Promise.resolve(this.context.globalState.get<T>(key, defaultValue));
  }

  public async setState<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(key, value);
  }
}
