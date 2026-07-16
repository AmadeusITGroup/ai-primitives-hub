/**
 * TargetWriter interface + FileTreeTargetWriter.
 *
 * Writer = "given a Target, an Installable's manifest, and the
 * extracted file map, route the bundle's primitive files into the
 * target's filesystem layout".
 *
 * Layout definitions are loaded from a data-driven configuration
 * (see `infra/writers/default-layouts.json`, re-exported through
 * `@ai-primitives-hub/infra`'s barrel as `defaultLayouts` — this
 * module deliberately does not keep its own copy; the reference
 * branch this was ported from had two independently-drifted copies,
 * one in `infra` and one here, which is exactly the defect this
 * single-source-of-truth import avoids). The `resolveLayout` function
 * is a synchronous compatibility shim that uses the built-in defaults
 * only; async callers with a `LayoutConfigLoader` can use
 * `resolveLayoutAsync` for hierarchical overrides (built-in → user →
 * project).
 *
 * The writer is fully context-driven: no Node globals, all IO
 * through the injected `WriterFs`.
 * @module writers/file-tree-writer
 */
import * as path from 'node:path';
import type {
  CopilotFileType,
  ExtractedFiles,
  KindRoutes,
  LayoutConfigLoader,
  ResourceTransformer,
  Target,
  TargetLayout,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  determineFileType,
  getSkillName,
  getTargetFileName,
  normalizePromptId,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts as builtInLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';

export type {
  ExtractedFiles,
} from '@ai-primitives-hub/core';

export type {
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

export interface WriterFs {
  writeFile(p: string, contents: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

/**
 * A manifest-driven placement instruction: "this bundle-relative source
 * file/directory is primitive `id` of Copilot type `type`". Used by
 * `FileTreeTargetWriter.writeManifestItems` for targets/scopes (e.g. the
 * VS Code extension's user/repository scopes) whose real on-disk
 * convention renames every file to `{id}.{type-extension}` rather than
 * preserving the bundle's own directory layout — see migration plan
 * §7.5 item 2 for why this is a separate mode from `write()`'s
 * prefix-preserving routing.
 */
export interface ManifestPlacementItem {
  /** Manifest item id; used to compute the renamed on-disk file name. */
  id: string;
  /** Bundle-relative source path (looked up in the `ExtractedFiles` map). */
  file: string;
  /** Copilot file type; auto-detected from `file`/`tags` when omitted. */
  type?: CopilotFileType;
  tags?: string[];
}

/**
 * Maps a `CopilotFileType` to the `default-layouts.json` kindRoutes key
 * whose *value* (the output subdirectory) applies to it. Chatmodes are
 * deliberately routed through the agents key because they are associated
 * with agents at runtime.
 */
const KIND_TO_ROUTE_KEY: Record<CopilotFileType, string> = {
  prompt: 'prompts/',
  instructions: 'instructions/',
  chatmode: 'agents/',
  agent: 'agents/',
  skill: 'skills/'
};

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
export type { KindRoutes, TargetLayout } from '@ai-primitives-hub/core';

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
  const result = resolveLayoutFromLayers(target, [builtInLayouts]);
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
  /** Optional resource transformer for target-specific content transformations. */
  transformer?: ResourceTransformer;
  /** Optional hierarchical layout loader; built-in defaults are used when omitted. */
  layoutLoader?: LayoutConfigLoader;
}

/**
 * Generic writer that routes bundle files into a target tree using
 * the layout returned by resolveLayout(target).
 */
/* eslint-disable @typescript-eslint/member-ordering -- public API kept above helpers. */
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
    const layout = await this.resolveLayout(target);
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

      // Decode content
      let content = new TextDecoder().decode(bytes);

      // Apply transformation if transformer is provided
      if (this.opts.transformer !== undefined) {
        try {
          const result = this.opts.transformer.transform({
            target,
            filePath: bundlePath,
            content
          });
          content = result.content;
        } catch {
          // Fail-safe: on transformation error, use original content
          // In production, this would log a warning
        }
      }

      const outPath = path.join(baseDir, route.outPrefix, route.tail);
      await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
      await this.opts.fs.writeFile(outPath, content);
      written.push(outPath);
    }
    return { written, skipped };
  }

  /**
   * Write bundle files into the target using manifest-driven, ID-based
   * renaming rather than `write()`'s prefix-preserving routing.
   *
   * For each item: the Copilot file type (explicit or auto-detected from
   * `file`/`tags`) selects the output subdirectory via
   * {@link KIND_TO_ROUTE_KEY} + the layout's `kindRoutes`, and the output
   * file name is `{id}.{type-extension}` (via `core`'s `getTargetFileName`)
   * rather than the source file's own name. Skill items are the exception:
   * every bundle file under the skill's `skills/<sourceId>/` prefix is
   * copied, preserving its relative path, into
   * `{baseDir}/{skillsRoute}/{normalizedId}/`.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @param items - Manifest-derived placement instructions.
   * @returns TargetWriteResult.
   */
  public async writeManifestItems(
    target: Target,
    files: ExtractedFiles,
    items: readonly ManifestPlacementItem[]
  ): Promise<TargetWriteResult> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const allowed = target.allowedKinds === undefined ? null : new Set(target.allowedKinds);
    const written: string[] = [];
    const skipped: string[] = [];

    for (const item of items) {
      const type = item.type ?? determineFileType(item.file, item.tags);
      const routeKey = KIND_TO_ROUTE_KEY[type];
      // `allowedKinds` is keyed on the same vocabulary as `write()`'s
      // `routeToKind` (plural route-key names, e.g. "skills"/"prompts"),
      // not on the singular `CopilotFileType` domain vocabulary.
      if (allowed !== null && !allowed.has(routeToKind(routeKey))) {
        skipped.push(item.file);
        continue;
      }
      const outPrefix = layout.kindRoutes[routeKey];
      if (outPrefix === undefined) {
        // Target's layout has no route for this kind at all.
        skipped.push(item.file);
        continue;
      }

      if (type === 'skill') {
        const wroteAny = await this.writeSkillItem(baseDir, outPrefix, item, files, written);
        if (!wroteAny) {
          skipped.push(item.file);
        }
        continue;
      }

      const bytes = files.get(item.file);
      if (bytes === undefined) {
        skipped.push(item.file);
        continue;
      }
      const outPath = path.join(baseDir, outPrefix, getTargetFileName(item.id, type));
      let content = new TextDecoder().decode(bytes);
      if (this.opts.transformer !== undefined) {
        try {
          const result = this.opts.transformer.transform({ target, filePath: item.file, content });
          content = result.content;
        } catch {
          // Fail-safe: on transformation error, use original content
        }
      }
      await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
      await this.opts.fs.writeFile(outPath, content);
      written.push(outPath);
    }

    return { written, skipped };
  }

  private async resolveLayout(target: Target): Promise<TargetLayout> {
    if (this.opts.layoutLoader === undefined) {
      return resolveLayout(target);
    }
    return await resolveLayoutAsync(target, this.opts.layoutLoader);
  }

  /**
   * Copy every bundle file under a skill's `skills/<sourceId>/` prefix
   * into `{baseDir}/{outPrefix}/{normalizedId}/`, preserving each file's
   * relative path under the skill root.
   * @param baseDir - Expanded target base directory.
   * @param outPrefix - Layout output subdirectory for the `skill` kind.
   * @param item - Skill placement item (its `file` points at the skill's
   *   manifest file, e.g. `skills/my-skill/SKILL.md`).
   * @param files - Extracted bundle files.
   * @param written - Accumulator for written absolute paths.
   * @returns true if at least one file was written.
   */
  private async writeSkillItem(
    baseDir: string,
    outPrefix: string,
    item: ManifestPlacementItem,
    files: ExtractedFiles,
    written: string[]
  ): Promise<boolean> {
    const sourceSkillId = getSkillName(item.file);
    if (sourceSkillId === null) {
      return false;
    }
    const targetSkillId = normalizePromptId(item.id);
    const sourcePrefix = `skills/${sourceSkillId}/`;
    let wroteAny = false;

    for (const [bundlePath, bytes] of files) {
      if (!bundlePath.startsWith(sourcePrefix)) {
        continue;
      }
      const tail = bundlePath.slice(sourcePrefix.length);
      const outPath = path.join(baseDir, outPrefix, targetSkillId, tail);
      await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
      await this.opts.fs.writeFile(outPath, new TextDecoder().decode(bytes));
      written.push(outPath);
      wroteAny = true;
    }

    return wroteAny;
  }

  /**
   * Remove a file from the target.
   * @param target - Target chosen via `--target <name>`.
   * @param filePath - Relative file path to remove (from bundle root).
   */
  public async remove(target: Target, filePath: string): Promise<void> {
    const layout = await this.resolveLayout(target);
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
