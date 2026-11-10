/**
 * Extension storage composition: every application file lives under the shared
 * XDG layout (`XdgAppStorage`), exactly where the CLI keeps its own. The VS Code
 * `globalStorageUri` is only read by legacy detection and migration.
 * @module storage/extension-storage
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AppStorage,
} from '@ai-primitives-hub/core';
import {
  XdgAppStorage,
} from '@ai-primitives-hub/infra';

/**
 * Create the shared AppStorage for the given environment.
 * @param env Environment bag; production callers pass `process.env`.
 */
export function createExtensionStorage(env: Readonly<Record<string, string | undefined>> = process.env): AppStorage {
  return new XdgAppStorage({ ...env });
}

/**
 * Directory for state shared with the CLI and other IDEs (`$XDG_STATE_HOME/ai-primitives-hub`).
 * @param storage
 */
export function extensionStateDir(storage: AppStorage = createExtensionStorage()): string {
  const state = storage.getPaths().state;
  if (state === undefined) {
    throw new Error('the application storage provides no state directory');
  }
  return state;
}

/**
 * Directory for extracted bundle content, `bin` tools and other data (`$XDG_DATA_HOME/ai-primitives-hub`).
 * @param storage
 */
export function extensionDataDir(storage: AppStorage = createExtensionStorage()): string {
  return storage.getPaths().root;
}

/**
 * Memento-shaped JSON file under the state directory for application state that
 * several windows and IDEs share (setup state, migration registry, declined prompts).
 */
export class SharedStateFile {
  private readonly file: string;

  public constructor(name: string, storage: AppStorage = createExtensionStorage()) {
    this.file = path.join(extensionStateDir(storage), `${name}.json`);
  }

  private read(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  public get<T>(key: string, defaultValue?: T): T {
    const state = this.read();
    return (key in state ? state[key] : defaultValue) as T;
  }

  public keys(): readonly string[] {
    return Object.keys(this.read());
  }

  public update(key: string, value: unknown): Promise<void> {
    const state = this.read();
    if (value === undefined) {
      delete state[key];
    } else {
      state[key] = value;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return Promise.resolve();
  }
}
