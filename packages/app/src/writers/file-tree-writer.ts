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
  ExtractedFiles,
  KindRoutes,
  LayoutConfigLoader,
  ManifestPlacementType,
  PrimitiveKind,
  ResourceTransformer,
  Target,
  TargetLayout,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  assertSafeRepositoryInstallPath,
  assertSafeRepositoryRemovalPath,
  decodeUtf8Strict,
  determineFileType,
  expandPath,
  FileWriteJournal,
  getKnowledgeRelativePath,
  getSkillName,
  getTargetFileName,
  manifestPlacementTypeToPrimitiveKind,
  normalizePrimitiveKind,
  normalizePromptId,
  toCopilotFileType,
  UnsafeRepositoryPathError,
  verifyWrittenBytes,
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
  /**
   * Write raw bytes verbatim. Required for binary bundle assets
   * (images, archives, office documents): decoding them through the
   * string `writeFile` path is lossy and corrupts them (issue #357).
   */
  writeFileBytes(p: string, bytes: Uint8Array): Promise<void>;
  /** Byte-level read-back used for post-write integrity verification. */
  readFileBytes(p: string): Promise<Uint8Array>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  realpath?(p: string): Promise<string>;
  lstat?(p: string): Promise<{ isSymbolicLink: boolean }>;
}

/**
 * A manifest-driven placement instruction: "this bundle-relative source
 * file/directory is primitive `id` of placement type `type`". Used by
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
  /** Manifest placement type; auto-detected from `file`/`tags` when omitted. */
  type?: ManifestPlacementType;
  tags?: string[];
}

/**
 * Maps a manifest placement type to the `default-layouts.json` kindRoutes key
 * whose *value* (the output subdirectory) applies to it. Chatmodes are
 * deliberately routed through the agents key because they are associated
 * with agents at runtime.
 */
export const KIND_TO_ROUTE_KEY: Partial<Record<ManifestPlacementType, string>> = {
  prompt: 'prompts/',
  instruction: 'instructions/',
  instructions: 'instructions/',
  'chat-mode': 'agents/',
  chatmode: 'agents/',
  agent: 'agents/',
  skill: 'skills/',
  knowledge: 'knowledge/'
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
export type { KindRoutes, ManifestPlacementType, TargetLayout } from '@ai-primitives-hub/core';

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
  // Cast needed: TypeScript widens JSON string values to `string`, making
  // serversKey: string incompatible with McpServersKey. Values are correct at runtime.
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
 * Re-export of `expandPath` (expands `${VAR}` and a leading `~` in a path).
 * @deprecated Import `expandPath` from `@ai-primitives-hub/core` directly. This re-export
 * is kept for backward compatibility and will be removed in a future version.
 */
export { expandPath, getKnowledgeRelativePath } from '@ai-primitives-hub/core';

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
  private writeJournal: FileWriteJournal | null = null;

  public constructor(private readonly opts: FileTreeTargetWriterOptions) {}

  private containmentRoot(target: Target, baseDir: string): string {
    if (target.scope !== 'repository') {
      return path.resolve(baseDir);
    }
    if (target.rootPath === undefined) {
      throw new UnsafeRepositoryPathError(baseDir, 'cannot be checked against repository root');
    }
    return path.resolve(target.rootPath);
  }

  private assertLexicallyWithinRoot(root: string, paths: readonly string[]): void {
    const resolvedRoot = path.resolve(root);
    for (const filePath of paths) {
      const relative = path.relative(resolvedRoot, path.resolve(filePath));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new UnsafeRepositoryPathError(filePath);
      }
    }
  }

  private async validateInstallPaths(root: string, paths: readonly string[]): Promise<void> {
    const fileSystem = this.opts.fs;
    if (fileSystem.realpath === undefined || fileSystem.lstat === undefined) {
      throw new UnsafeRepositoryPathError(root, 'cannot be checked against repository root');
    }
    for (const filePath of paths) {
      await assertSafeRepositoryInstallPath(
        root,
        filePath,
        fileSystem.realpath.bind(fileSystem),
        fileSystem.lstat.bind(fileSystem)
      );
    }
  }

  private async validateRemovalPaths(root: string, paths: readonly string[]): Promise<void> {
    const fileSystem = this.opts.fs;
    if (fileSystem.realpath === undefined) {
      throw new UnsafeRepositoryPathError(root, 'cannot be checked against repository root');
    }
    for (const filePath of paths) {
      await assertSafeRepositoryRemovalPath(root, filePath, fileSystem.realpath.bind(fileSystem));
    }
  }

  private async rollbackJournal(target: Target, journal: FileWriteJournal): Promise<void> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const root = target.scope === 'repository' ? target.rootPath : baseDir;
    if (root === undefined) {
      throw new UnsafeRepositoryPathError(baseDir, 'cannot be checked against repository root');
    }
    await this.validateRemovalPaths(root, journal.getPaths());
    await journal.rollback();
  }

  /**
   * Determine which extracted bundle files this writer can place without
   * changing the target filesystem.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @returns Deterministic writable/skipped bundle-relative paths.
   */
  public async preflight(target: Target, files: ExtractedFiles): Promise<TargetWritePlan> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const skip = new Set(layout.skipPaths);
    const allowed = target.allowedKinds === undefined
      ? null
      : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));
    const writable: string[] = [];
    const skipped: string[] = [];
    const destinations: string[] = [];

    for (const bundlePath of files.keys()) {
      if (skip.has(bundlePath)) {
        continue;
      }
      const route = pickRoute(bundlePath, layout.kindRoutes);
      if (route === null) {
        skipped.push(bundlePath);
        continue;
      }
      const routeKind = routeToKind(route.prefix);
      if (allowed !== null && (routeKind === null || !allowed.has(routeKind))) {
        skipped.push(bundlePath);
        continue;
      }
      writable.push(bundlePath);
      destinations.push(path.join(baseDir, route.outPrefix, route.tail));
    }

    if (destinations.length > 0) {
      const root = this.containmentRoot(target, baseDir);
      if (target.scope === 'repository' || await this.opts.fs.exists(root)) {
        await this.validateInstallPaths(root, destinations);
      } else {
        this.assertLexicallyWithinRoot(root, destinations);
      }
    }
    return { writable, skipped };
  }

  /**
   * Write the bundle into the target.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @returns TargetWriteResult.
   */
  public async write(target: Target, files: ExtractedFiles): Promise<TargetWriteResult> {
    let plan = await this.preflight(target, files);
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const root = this.containmentRoot(target, baseDir);
    if (plan.writable.length > 0 && target.scope !== 'repository') {
      await this.opts.fs.mkdir(baseDir, { recursive: true });
      plan = await this.preflight(target, files);
    }
    const writable = new Set(plan.writable);
    const written: string[] = [];
    const writtenBundlePaths: string[] = [];
    const journal = new FileWriteJournal(this.opts.fs);
    this.writeJournal = journal;

    try {
      for (const [bundlePath, bytes] of files) {
        if (!writable.has(bundlePath)) {
          continue;
        }
        const route = pickRoute(bundlePath, layout.kindRoutes);
        if (route === null) {
          continue;
        }
        const outPath = path.join(baseDir, route.outPrefix, route.tail);
        await this.writeContent(target, bundlePath, bytes, outPath, root, journal);
        written.push(outPath);
        writtenBundlePaths.push(bundlePath);
      }
    } catch (cause) {
      try {
        await this.rollbackJournal(target, journal);
      } catch (rollbackError) {
        throw new AggregateError([cause, rollbackError], 'Target write failed and rollback was incomplete', { cause });
      }
      throw cause;
    }
    return { written, skipped: plan.skipped, writtenBundlePaths };
  }

  /**
   * Remove files written by a failed or rejected installation.
   * @param target - Target chosen via `--target <name>`.
   * @param written - Absolute paths returned by `write`.
   */
  public async rollback(target: Target, written: readonly string[]): Promise<void> {
    const journal = this.writeJournal;
    if (journal !== null) {
      const layout = await this.resolveLayout(target);
      const baseDir = expandPath(layout.baseDir, this.opts.env);
      const root = target.scope === 'repository' ? target.rootPath : baseDir;
      if (root === undefined) {
        throw new UnsafeRepositoryPathError(baseDir, 'cannot be checked against repository root');
      }
      await this.validateRemovalPaths(root, written);
      await journal.rollback(written);
    }
  }

  /**
   * Write one bundle file to its resolved output path, binary-safe
   * (issue #357).
   *
   * Text payloads (strict UTF-8) go through the optional transformer
   * and are written as strings; anything else is written byte-for-byte
   * — the previous unconditional `TextDecoder` round-trip replaced
   * invalid UTF-8 sequences with U+FFFD and corrupted binary assets
   * such as PPTX files. Every write is verified by re-reading the file
   * and comparing it against the intended bytes.
   * @param target - Install target (passed to the transformer).
   * @param bundlePath - Bundle-relative source path (transformer context).
   * @param bytes - Raw source bytes from the extracted bundle.
   * @param outPath - Absolute destination path.
   * @param root
   * @param journal
   */
  private async writeContent(
    target: Target,
    bundlePath: string,
    bytes: Uint8Array,
    outPath: string,
    root: string,
    journal: FileWriteJournal
  ): Promise<void> {
    const text = decodeUtf8Strict(bytes);
    if (text === null) {
      // Binary payload: write verbatim, never transform.
      await this.validateInstallPaths(root, [outPath]);
      await journal.write(outPath, bytes, async () => {
        await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
        await this.opts.fs.writeFileBytes(outPath, bytes);
        await verifyWrittenBytes(this.opts.fs, outPath, bytes);
      });
      return;
    }

    let content = text;
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
    const writtenBytes = new TextEncoder().encode(content);
    await this.validateInstallPaths(root, [outPath]);
    await journal.write(outPath, writtenBytes, async () => {
      await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
      await this.opts.fs.writeFile(outPath, content);
      await verifyWrittenBytes(this.opts.fs, outPath, writtenBytes);
    });
  }

  public async getKnowledgeTargetPath(target: Target, bundlePath: string): Promise<string | null> {
    const layout = await this.resolveLayout(target);
    if (target.allowedKinds !== undefined
      && !target.allowedKinds.some((kind) => (normalizePrimitiveKind(kind) ?? kind) === 'knowledge')) {
      return null;
    }
    return getKnowledgeTargetPath(layout, expandPath(layout.baseDir, this.opts.env), bundlePath);
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
    const allowed = target.allowedKinds === undefined
      ? null
      : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));
    const written: string[] = [];
    const writtenBundlePaths: string[] = [];
    const skipped: string[] = [];
    const destinations: string[] = [];

    for (const item of items) {
      const type = item.type ?? determineFileType(item.file, item.tags);
      const routeKey = KIND_TO_ROUTE_KEY[type];
      if (routeKey === undefined
        || (allowed !== null && !allowed.has(manifestPlacementTypeToPrimitiveKind(type)))) {
        continue;
      }
      const outPrefix = layout.kindRoutes[routeKey];
      if (outPrefix === undefined) {
        continue;
      }
      if (type === 'skill') {
        if (getSkillName(item.file) !== null) {
          const targetSkillId = normalizePromptId(item.id);
          const sourcePrefix = `${path.posix.dirname(item.file)}/`;
          for (const sourceFilePath of files.keys()) {
            if (sourceFilePath.startsWith(sourcePrefix)) {
              destinations.push(path.join(baseDir, outPrefix, targetSkillId, sourceFilePath.slice(sourcePrefix.length)));
            }
          }
        }
        continue;
      }
      const copilotType = type === 'knowledge' ? null : toCopilotFileType(type);
      const outPath = type === 'knowledge'
        ? getKnowledgeTargetPath(layout, baseDir, item.file)
        : (copilotType === null ? null : path.join(baseDir, outPrefix, getTargetFileName(item.id, copilotType)));
      const bundlePath = this.getManifestSourceKey(files, type, item.file);
      if (outPath !== null && files.has(bundlePath)) {
        destinations.push(outPath);
      }
    }

    const root = destinations.length > 0
      ? this.containmentRoot(target, baseDir)
      : path.resolve(baseDir);
    if (destinations.length > 0) {
      if (target.scope !== 'repository') {
        await this.opts.fs.mkdir(baseDir, { recursive: true });
      }
      await this.validateInstallPaths(root, destinations);
    }
    const journal = new FileWriteJournal(this.opts.fs);
    this.writeJournal = journal;

    try {
      for (const item of items) {
        const type = item.type ?? determineFileType(item.file, item.tags);
        const routeKey = KIND_TO_ROUTE_KEY[type];
        if (routeKey === undefined
          || (allowed !== null && !allowed.has(manifestPlacementTypeToPrimitiveKind(type)))) {
          skipped.push(item.file);
          continue;
        }
        const outPrefix = layout.kindRoutes[routeKey];
        if (outPrefix === undefined) {
          skipped.push(item.file);
          continue;
        }

        if (type === 'skill') {
          const wroteAny = await this.writeSkillItem(baseDir, outPrefix, item, files, written, root, journal);
          if (wroteAny) {
            for (const sourceFilePath of files.keys()) {
              const sourcePrefix = `${path.posix.dirname(item.file)}/`;
              if (sourceFilePath.startsWith(sourcePrefix)) {
                writtenBundlePaths.push(sourceFilePath);
              }
            }
          } else {
            skipped.push(item.file);
          }
          continue;
        }

        const bundlePath = this.getManifestSourceKey(files, type, item.file);
        const bytes = files.get(bundlePath);
        if (bytes === undefined) {
          skipped.push(item.file);
          continue;
        }
        const copilotType = type === 'knowledge' ? null : toCopilotFileType(type);
        const outPath = type === 'knowledge'
          ? getKnowledgeTargetPath(layout, baseDir, item.file)
          : (copilotType === null ? null : path.join(baseDir, outPrefix, getTargetFileName(item.id, copilotType)));
        if (outPath === null) {
          skipped.push(item.file);
          continue;
        }
        await this.writeContent(target, bundlePath, bytes, outPath, root, journal);
        written.push(outPath);
        writtenBundlePaths.push(bundlePath);
      }
    } catch (cause) {
      try {
        await this.rollbackJournal(target, journal);
      } catch (rollbackError) {
        throw new AggregateError([cause, rollbackError], 'Manifest item write failed and rollback was incomplete', { cause });
      }
      throw cause;
    }

    return { written, skipped, writtenBundlePaths };
  }

  private getManifestSourceKey(files: ExtractedFiles, type: ManifestPlacementType, file: string): string {
    const relativePath = type === 'knowledge' ? getKnowledgeRelativePath(file) : null;
    const canonicalPath = relativePath === null ? null : `knowledge/${relativePath}`;
    return canonicalPath !== null && files.has(canonicalPath) ? canonicalPath : file;
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
   * @param root
   * @param journal
   * @returns true if at least one file was written.
   */
  private async writeSkillItem(
    baseDir: string,
    outPrefix: string,
    item: ManifestPlacementItem,
    files: ExtractedFiles,
    written: string[],
    root: string,
    journal: FileWriteJournal
  ): Promise<boolean> {
    if (getSkillName(item.file) === null) {
      return false;
    }
    const targetSkillId = normalizePromptId(item.id);
    const sourcePrefix = `${path.posix.dirname(item.file)}/`;
    let wroteAny = false;

    for (const [bundlePath, bytes] of files) {
      if (!bundlePath.startsWith(sourcePrefix)) {
        continue;
      }
      const tail = bundlePath.slice(sourcePrefix.length);
      const outPath = path.join(baseDir, outPrefix, targetSkillId, tail);
      // Skill directories carry arbitrary assets (scripts, images,
      // office documents) — copy byte-for-byte, never transform.
      await this.validateInstallPaths(root, [outPath]);
      await journal.write(outPath, bytes, async () => {
        await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
        await this.opts.fs.writeFileBytes(outPath, bytes);
        await verifyWrittenBytes(this.opts.fs, outPath, bytes);
      });
      written.push(outPath);
      wroteAny = true;
    }

    return wroteAny;
  }

  private repositoryKnowledgeRoute(
    target: Target,
    layout: TargetLayout,
    baseDir: string
  ): { prefix: string; outPrefix: string } | null {
    if (target.scope !== 'repository') {
      return null;
    }
    const routeKey = KIND_TO_ROUTE_KEY.knowledge;
    const outPrefix = routeKey === undefined ? undefined : layout.kindRoutes[routeKey];
    if (outPrefix === undefined) {
      return null;
    }
    if (target.rootPath === undefined) {
      throw new UnsafeRepositoryPathError(baseDir, 'cannot be checked against repository root');
    }
    const root = path.resolve(target.rootPath);
    const destination = path.resolve(path.join(baseDir, outPrefix));
    const relative = path.relative(root, destination);
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new UnsafeRepositoryPathError(destination);
    }
    return { prefix: `${relative.split(path.sep).join('/')}/`, outPrefix };
  }

  private pickRemovalRoute(
    target: Target,
    filePath: string,
    layout: TargetLayout,
    baseDir: string
  ): PickedRoute | null {
    const raw = filePath.replaceAll('\\', '/');
    const rawSegments = raw.split('/');
    const dotHostKnowledgePath = rawSegments[0]?.startsWith('.') === true && rawSegments[1] === 'knowledge';
    if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || rawSegments.includes('..')
      || (dotHostKnowledgePath && rawSegments.length < 3)) {
      throw new UnsafeRepositoryPathError(filePath);
    }
    const configuredKnowledgeRoute = this.repositoryKnowledgeRoute(target, layout, baseDir);
    const looksLikeKnowledgePath = raw.startsWith('knowledge/')
      || dotHostKnowledgePath
      || (configuredKnowledgeRoute !== null && raw.startsWith(configuredKnowledgeRoute.prefix));
    if (looksLikeKnowledgePath && getKnowledgeRelativePath(raw) === null) {
      throw new UnsafeRepositoryPathError(filePath);
    }

    const normalized = normalizeBundlePath(raw);
    if (normalized.startsWith('knowledge/')) {
      const relativePath = getKnowledgeRelativePath(normalized);
      const routeKey = KIND_TO_ROUTE_KEY.knowledge;
      const outPrefix = routeKey === undefined ? undefined : layout.kindRoutes[routeKey];
      if (relativePath === null || outPrefix === undefined) {
        throw new UnsafeRepositoryPathError(filePath, 'knowledge route is not configured for this target');
      }
      return { prefix: 'knowledge/', outPrefix, tail: relativePath };
    }

    if (configuredKnowledgeRoute !== null && normalized.startsWith(configuredKnowledgeRoute.prefix)) {
      const tail = normalized.slice(configuredKnowledgeRoute.prefix.length);
      if (getKnowledgeRelativePath(tail) === null) {
        throw new UnsafeRepositoryPathError(filePath);
      }
      return { ...configuredKnowledgeRoute, tail };
    }
    const segments = normalized.split('/');
    if (segments[0]?.startsWith('.') === true && segments[1] === 'knowledge' && segments.length > 2) {
      throw new UnsafeRepositoryPathError(filePath, 'physical knowledge path does not match this target layout');
    }
    return pickRoute(normalized, layout.kindRoutes);
  }

  public async preflightRemoval(target: Target, filePaths: readonly string[]): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const root = target.scope === 'repository' ? target.rootPath : path.resolve(baseDir);
    if (root === undefined) {
      throw new UnsafeRepositoryPathError(baseDir, 'cannot be checked against repository root');
    }
    const destinations = filePaths.flatMap((filePath) => {
      const route = this.pickRemovalRoute(target, filePath, layout, baseDir);
      if (route === null) {
        if (target.scope === 'repository') {
          throw new UnsafeRepositoryPathError(filePath, 'does not match a repository layout route');
        }
        return [];
      }
      return [path.join(baseDir, route.outPrefix, route.tail)];
    });
    await this.validateRemovalPaths(root, destinations);
  }

  /**
   * Remove a file from the target.
   * @param target - Target chosen via `--target <name>`.
   * @param filePath - Relative file path to remove (from bundle root).
   */
  public async remove(target: Target, filePath: string): Promise<void> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const route = this.pickRemovalRoute(target, filePath, layout, baseDir);
    if (route === null) {
      if (target.scope === 'repository') {
        throw new UnsafeRepositoryPathError(filePath, 'does not match a repository layout route');
      }
      return;
    }
    const outPath = path.join(baseDir, route.outPrefix, route.tail);
    await this.preflightRemoval(target, [filePath]);
    await this.opts.fs.remove(outPath);
  }
}

interface PickedRoute {
  prefix: string;
  outPrefix: string;
  tail: string;
}

const pickRoute = (bundlePath: string, routes: KindRoutes): PickedRoute | null => {
  const normalizedBundlePath = normalizeBundlePath(bundlePath);
  const sorted = Object.entries(routes).toSorted((a, b) => b[0].length - a[0].length);
  for (const [prefix, outPrefix] of sorted) {
    if (normalizedBundlePath.startsWith(prefix)) {
      return { prefix, outPrefix, tail: normalizedBundlePath.slice(prefix.length) };
    }
  }
  return null;
};

/**
 * Normalize legacy bundle directory aliases before route matching.
 *
 * `chatmodes/` was the historical authoring path while the canonical
 * vocabulary uses `chat-modes/`. Keep accepting both on disk without
 * duplicating aliases in every target layout. The original path remains in
 * lockfile/checksum data; only the routing view is normalized.
 * @param bundlePath
 */
const normalizeBundlePath = (bundlePath: string): string =>
  bundlePath.startsWith('chatmodes/')
    ? `chat-modes/${bundlePath.slice('chatmodes/'.length)}`
    : bundlePath;

/**
 * Map a layout prefix back to the primitive kind it represents.
 * Used to honor `target.allowedKinds`.
 * @param prefix - Layout prefix (e.g., "prompts/").
 * @returns Kind name without trailing slash.
 */
const ROUTE_PREFIX_KINDS: Record<string, PrimitiveKind> = {
  '.kiro/steering/': 'steering',
  '.kiro/specs/': 'spec',
  '.claude/commands/': 'command',
  '.claude/output-styles/': 'output-style',
  '.cursor/rules/': 'rule',
  '.cursor/agents/': 'agent',
  '.cursor/skills/': 'skill',
  '.cursor/commands/': 'command',
  '.opencode/tools/': 'tool',
  '.opencode/commands/': 'command',
  '.opencode/agents/': 'agent',
  '.opencode/skills/': 'skill',
  '.opencode/rules/': 'rule',
  '.opencode/hooks/': 'hook',
  '.opencode/plugins/': 'plugin',
  '.devin/knowledge/': 'knowledge',
  '.devin/playbooks/': 'playbook',
  '.devin/powers/': 'power',
  '.devin/prompts/': 'prompt',
  '.devin/instructions/': 'instruction',
  '.devin/agents/': 'agent',
  '.devin/skills/': 'skill',
  '.devin/hooks/': 'hook',
  '.devin/plugins/': 'plugin'
};

const routeToKind = (prefix: string): PrimitiveKind | null => {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return normalizePrimitiveKind(prefix.replace(/\/$/, ''))
    ?? ROUTE_PREFIX_KINDS[normalizedPrefix]
    ?? null;
};

export const getKnowledgeTargetPath = (
  layout: TargetLayout,
  baseDir: string,
  bundlePath: string
): string | null => {
  const routeKey = KIND_TO_ROUTE_KEY.knowledge;
  const outPrefix = routeKey === undefined ? undefined : layout.kindRoutes[routeKey];
  const relativePath = getKnowledgeRelativePath(bundlePath);
  return outPrefix === undefined || relativePath === null
    ? null
    : path.join(baseDir, outPrefix, relativePath);
};
