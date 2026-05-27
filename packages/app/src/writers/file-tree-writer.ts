/**
 * TargetWriter interface + FileTreeTargetWriter.
 *
 * Writer = "given a Target, an Installable's manifest, and the
 * extracted file map, route the bundle's primitive files into the
 * target's filesystem layout".
 *
 * Layout definitions are loaded from a data-driven configuration
 * (see `src/infra/writers/default-layouts.json` for built-in defaults
 * and `src/public/schemas/target-layouts.schema.json` for the format).
 * The `resolveLayout` function is a synchronous compatibility shim that
 * uses the built-in defaults only; async callers with a
 * `LayoutConfigLoader` can use `resolveLayoutAsync` for hierarchical
 * overrides (built-in → user → project).
 *
 * The writer is fully Context-driven: no Node globals, all IO
 * through the injected `WriterFs`.
 */
import * as path from 'node:path';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';
import type {
  Target,
} from '@prompt-registry/core';
import type {
  KindRoutes,
  TargetLayout,
  TargetLayoutsConfig,
} from '@prompt-registry/core';
import type {
  ExtractedFiles,
} from '@prompt-registry/core';
import type {
  LayoutConfigLoader,
} from '@prompt-registry/core';
import type {
  TargetWriter,
  TargetWriteResult,
} from '@prompt-registry/core';
import builtInLayouts from './default-layouts.json';

export type {
  ExtractedFiles,
} from '@prompt-registry/core';

export type {
  TargetWriter,
  TargetWriteResult,
} from '@prompt-registry/core';

export interface WriterFs {
  writeFile(p: string, contents: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

/**
 * Result of a remove operation.
 * Contains removed and skipped file paths.
 */
export interface TargetRemoveResult {
  /** Absolute paths of files removed. */
  removed: string[];
  /** Files not found (skipped). */
  skipped: string[];
}

// Re-export domain types for backward compatibility with existing callers.
export type { KindRoutes, TargetLayout } from '@prompt-registry/core';

// Satisfy local usage (TypeScript needs the types in scope for the functions below).
// The re-export above covers external callers.

/**
 * Resolve the layout for a given Target using the built-in defaults.
 * Synchronous; uses the embedded JSON config (no filesystem IO).
 * For hierarchical override support (user + project configs) use
 * `resolveLayoutAsync` instead.
 * @param target - Target to resolve.
 * @returns Resolved TargetLayout.
 */
export const resolveLayout = (target: Target): TargetLayout => {
  const result = resolveLayoutFromLayers(target, [builtInLayouts as TargetLayoutsConfig]);
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

/**
 * Resolve the layout for a given Target using all available layers
 * (built-in + user config + project config).
 * @param target - Target to resolve.
 * @param loader - Layout config loader (injected for testability).
 * @returns Resolved TargetLayout.
 */
export const resolveLayoutAsync = async (
  target: Target,
  loader: LayoutConfigLoader
): Promise<TargetLayout> => {
  const layers = await loader.load();
  const result = resolveLayoutFromLayers(target, layers);
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

/**
 * Expand `${VAR}` and leading `~` in a path. Pure; HOME comes from the
 * injected env map.
 * @param p - Path with possible ${VAR} or ~ tokens.
 * @param env - Process env map.
 * @returns Expanded path.
 */
export const expandPath = (p: string, env: Record<string, string | undefined>): string => {
  let out = p.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? '');
  if (out.startsWith('~')) {
    const home = env.HOME ?? env.USERPROFILE ?? '';
    out = home + out.slice(1);
  }
  return out;
};

/**
 * Options for FileTreeTargetWriter.
 */
export interface FileTreeTargetWriterOptions {
  fs: WriterFs;
  /** Process env, used for ${VAR} expansion. */
  env: Record<string, string | undefined>;
}

/**
 * Generic writer that routes bundle files into a target tree using
 * the layout returned by resolveLayout(target).
 */
export class FileTreeTargetWriter implements TargetWriter {
  /**
   * Construct a FileTreeTargetWriter.
   * @param opts Writer options including filesystem and environment.
   */
  public constructor(private readonly opts: FileTreeTargetWriterOptions) {}

  /**
   * Write the bundle into the target.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @returns TargetWriteResult.
   */
  public async write(target: Target, files: ExtractedFiles): Promise<TargetWriteResult> {
    const layout = resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const skip = new Set(layout.skipPaths);
    const allowed = target.allowedKinds === undefined ? null : new Set(target.allowedKinds);
    const written: string[] = [];
    const skipped: string[] = [];

    // Eager mkdir of the routed-kind directories; reduces churn over
    // calling mkdir per file. Per-kind subdir creation is recursive
    // so root + nested dirs are covered.
    for (const sub of Object.values(layout.kindRoutes)) {
      await this.opts.fs.mkdir(path.join(baseDir, sub), { recursive: true });
    }

    for (const [bundlePath, bytes] of files) {
      if (skip.has(bundlePath)) {
        continue;
      }
      const route = pickRoute(bundlePath, layout.kindRoutes);
      if (route === null) {
        // Unrouted file; not an error (bundles may carry extras).
        skipped.push(bundlePath);
        continue;
      }
      // Skip when allowedKinds explicitly excludes this kind.
      if (allowed !== null && !allowed.has(routeToKind(route.prefix))) {
        skipped.push(bundlePath);
        continue;
      }
      const outPath = path.join(baseDir, route.outPrefix, route.tail);
      await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
      await this.opts.fs.writeFile(outPath, new TextDecoder().decode(bytes));
      written.push(outPath);
    }
    return { written, skipped };
  }

  /**
   * Remove a file from the target.
   * @param target - Target chosen via `--target <name>`.
   * @param filePath - Relative file path to remove (from bundle root).
   */
  public async remove(target: Target, filePath: string): Promise<void> {
    const layout = resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const route = pickRoute(filePath, layout.kindRoutes);
    if (route === null) {
      return; // Unrouted file, nothing to do
    }
    const outPath = path.join(baseDir, route.outPrefix, route.tail);
    await this.opts.fs.remove(outPath);
  }
}

interface PickedRoute {
  prefix: string;
  outPrefix: string;
  tail: string;
}

const pickRoute = (bundlePath: string, routes: KindRoutes): PickedRoute | null => {
  for (const [prefix, outPrefix] of Object.entries(routes)) {
    if (bundlePath.startsWith(prefix)) {
      return { prefix, outPrefix, tail: bundlePath.slice(prefix.length) };
    }
  }
  return null;
};

/**
 * Map a layout prefix back to the primitive kind it represents.
 * Used to honor `target.allowedKinds`.
 * @param prefix - Layout prefix (e.g., "prompts/").
 * @returns Kind name without trailing slash.
 */
const routeToKind = (prefix: string): string => prefix.replace(/\/$/, '');
