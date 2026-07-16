/**
 * FileSystemLayoutConfigLoader — reads target layout configuration from
 * the hierarchical lookup chain:
 *
 *   1. Built-in defaults (default-layouts.json, embedded in binary)
 *   2. User override:  ~/.config/ai-primitives-hub/layouts.yml
 *   3. Project override: ./ai-primitives-hub-layouts.yml (cwd walk, stops at fs root)
 *
 * Each level is optional except the built-in. Missing files are silently
 * skipped. Invalid files log a warning and are skipped.
 *
 * Conforms to the LayoutConfigLoader port.
 * @module stores/layout-config-store
 */
import * as path from 'node:path';
import {
  validateTargetLayoutsConfig,
} from '@ai-primitives-hub/core';
import type {
  LayoutConfigLoader,
  TargetLayoutsConfig,
} from '@ai-primitives-hub/core';
import {
  load as parseYaml,
} from 'js-yaml';
import {
  xdgConfigDir,
} from '../storage/xdg-base-dirs';
import builtInLayouts from '../writers/default-layouts.json';

/** File name used for user and project override files. */
export const LAYOUTS_CONFIG_FILE = 'ai-primitives-hub-layouts.yml';

/**
 * Minimal filesystem interface used by the store (read + exists only).
 */
export interface LayoutConfigFs {
  readFile(p: string): Promise<string>;
  exists(p: string): Promise<boolean>;
}

/**
 * Options for FileSystemLayoutConfigLoader.
 */
export interface LayoutConfigLoaderOptions {
  /** Working directory; project config walk starts here. */
  cwd: string;
  /** Filesystem abstraction. */
  fs: LayoutConfigFs;
  /**
   * Override the user config directory. Defaults to
   * `~/.config/ai-primitives-hub` (respects `$XDG_CONFIG_HOME`).
   */
  userConfigDir?: string;
}

/**
 * Resolves the user-level config directory.
 * Respects `$XDG_CONFIG_HOME` per the XDG Base Directory spec.
 *
 * Thin wrapper around the shared `xdgConfigDir` resolver (ADR-0005
 * decision 2) — kept as its own named export/signature since callers
 * throughout this module already depend on it.
 * @param env
 */
export function resolveUserConfigDir(env: Record<string, string | undefined> = process.env): string {
  return xdgConfigDir(env);
}

/**
 * Walk upward from `cwd` looking for an `ai-primitives-hub-layouts.yml`
 * file. Returns the first found path or null.
 * @param cwd
 * @param fs
 */
async function findProjectConfigFile(
  cwd: string,
  fs: LayoutConfigFs
): Promise<string | null> {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, LAYOUTS_CONFIG_FILE);
    if (await fs.exists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Try to read and parse a layouts config file.
 * Returns null (and logs a warning) on any error.
 * @param filePath
 * @param fs
 */
async function tryLoadFile(
  filePath: string,
  fs: LayoutConfigFs
): Promise<TargetLayoutsConfig | null> {
  try {
    const text = await fs.readFile(filePath);
    const raw = parseYaml(text);
    return validateTargetLayoutsConfig(raw);
  } catch (err) {
    // eslint-disable-next-line no-console -- intentional user-facing warning
    console.warn(`Skipping invalid layout config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Loads target layout configuration from the filesystem hierarchy.
 * Returns layers ordered from least-specific (built-in) to
 * most-specific (project).
 */
export class FileSystemLayoutConfigLoader implements LayoutConfigLoader {
  private readonly opts: LayoutConfigLoaderOptions;

  public constructor(opts: LayoutConfigLoaderOptions) {
    this.opts = opts;
  }

  public async load(): Promise<TargetLayoutsConfig[]> {
    const layers: TargetLayoutsConfig[] = [
      builtInLayouts
    ];

    // Layer 2: user config (~/.config/ai-primitives-hub/layouts.yml)
    const userConfigDir = this.opts.userConfigDir ?? resolveUserConfigDir();
    const userFile = path.join(userConfigDir, LAYOUTS_CONFIG_FILE);
    if (await this.opts.fs.exists(userFile)) {
      const cfg = await tryLoadFile(userFile, this.opts.fs);
      if (cfg !== null) {
        layers.push(cfg);
      }
    }

    // Layer 3: project config (nearest ai-primitives-hub-layouts.yml in cwd walk)
    const projectFile = await findProjectConfigFile(this.opts.cwd, this.opts.fs);
    if (projectFile !== null) {
      const cfg = await tryLoadFile(projectFile, this.opts.fs);
      if (cfg !== null) {
        layers.push(cfg);
      }
    }

    return layers;
  }
}

/**
 * Convenience loader that returns only the built-in layer.
 * Used by FileTreeTargetWriter when no hierarchical lookup is needed
 * (e.g. in unit tests or when the caller has not injected a loader).
 */
export class BuiltInOnlyLayoutConfigLoader implements LayoutConfigLoader {
  public load(): Promise<TargetLayoutsConfig[]> {
    return Promise.resolve([builtInLayouts as TargetLayoutsConfig]);
  }
}
