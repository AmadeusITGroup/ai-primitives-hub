/**
 * Use-case service for inspecting, mutating, validating, and scaffolding
 * `.collection.yml` documents and their referenced primitive files across the
 * Visual Collection Editor, Collections Tree View, and YAML Text Editor Intelligence.
 * @module collection-editor/collection-editor-service
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  type CollectionChangeSummary,
  type CollectionCursorNodeContext,
  type CollectionInlineDecoration,
  type CollectionItemDefinition,
  type CollectionManifest,
  type CollectionValidationDiagnostic,
  defaultPathForPrimitiveKind,
  generateSanitizedId,
  inferPrimitiveKindFromPath,
  isSafeRepoRelativePath,
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
  parsePrimitiveFrontmatter,
  serializePrimitiveFrontmatter,
  type SourceRange,
} from '@ai-primitives-hub/core';
import {
  applyCollectionYamlMutation,
  type CollectionFileProbeResult,
  type CollectionYamlMutation,
  locateCollectionYamlCursor,
  type SiblingCollectionSummary,
  summarizeCollectionYamlChanges,
  validateCollectionYaml,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  createPlugin,
} from '../collection/create-plugin';

export interface CollectionItemFileStatus {
  index: number;
  path: string;
  kind: string;
  inferredKind: string;
  title?: string;
  description?: string;
  tags?: string[];
  exists: boolean;
  routeMismatch: boolean;
  previewTitle?: string;
  previewDescription?: string;
}

export interface WorkspacePrimitiveCandidate {
  path: string;
  kind: string;
  title: string;
  description?: string;
}

export interface CollectionDocumentInspection {
  valid: boolean;
  manifest?: CollectionManifest;
  errors: string[];
  warnings: string[];
  diagnostics: CollectionValidationDiagnostic[];
  inlineDecorations: CollectionInlineDecoration[];
  nodeRanges: Map<string, SourceRange>;
  itemStatuses: CollectionItemFileStatus[];
  readmeExists: boolean;
  unassignedPrimitives: WorkspacePrimitiveCandidate[];
}

export interface WorkspaceCollectionSummary {
  filePath: string;
  relPath: string;
  id: string;
  name: string;
  version: string;
  description: string;
  itemCount: number;
  mcpServerCount: number;
  valid: boolean;
  errorCount: number;
  warningCount: number;
  inspection: CollectionDocumentInspection;
}

export interface WorkspaceCollectionsOverview {
  workspaceRoot: string;
  collectionsPath: string;
  collections: WorkspaceCollectionSummary[];
  workspacePrimitives: WorkspacePrimitiveCandidate[];
  totalErrors: number;
  totalWarnings: number;
  valid: boolean;
}

export interface PrimitiveVisualContent {
  relPath: string;
  absPath: string;
  kind: string;
  exists: boolean;
  format: 'markdown-frontmatter' | 'plugin-json' | 'json' | 'raw';
  frontmatter: Record<string, unknown>;
  body: string;
  rawContent: string;
  rawFrontmatter?: string;
  parseError?: string;
  pluginManifest?: Record<string, unknown>;
}

export interface PrimitiveVisualContentUpdate {
  kind?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  pluginManifest?: Record<string, unknown>;
  rawContent?: string;
}

export interface CreateCollectionVisualInput {
  id: string;
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  collectionsPath?: string;
  createReadme?: boolean;
}

export interface ScaffoldPrimitiveForCollectionInput {
  kind: string;
  name: string;
  description?: string;
  author?: string;
  body?: string;
  customRelPath?: string;
  applyTo?: string;
  tools?: string[];
  model?: string;
  tags?: string[];
  addToCollection?: boolean;
}

const PRIMITIVE_SCAN_DIRS = [
  'prompts',
  'instructions',
  'agents',
  'chat-modes',
  'chatmodes',
  'skills',
  'plugins',
  'hooks',
  'mcp-servers',
  'knowledge',
  'playbooks',
  'powers',
  '.kiro/steering',
  '.kiro/specs',
  '.claude/commands',
  '.claude/output-styles',
  '.cursor/rules',
  '.opencode/tools'
];

const humanizeSlug = (slug: string): string =>
  slug
    .replace(/\.(?:prompt|instructions?|agent|chatmode|skill|hook|mcp)\.(?:md|json)$/i, '')
    .replace(/\.(?:md|mdc|json|py|ts|js)$/i, '')
    .split(/[-_./]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const WORKSPACE_SCAN_CACHE_TTL_MS = 2000;

export class CollectionEditorService {
  private readonly primitivesCacheByWorkspace = new Map<
    string,
    { candidates: WorkspacePrimitiveCandidate[]; cachedAt: number }
  >();

  private readonly siblingsCacheByDir = new Map<
    string,
    { siblings: SiblingCollectionSummary[]; cachedAt: number }
  >();

  private buildFileProbe(workspaceRoot?: string): ((relPath: string) => CollectionFileProbeResult) | undefined {
    if (!workspaceRoot) {
      return undefined;
    }
    return (relPath: string): CollectionFileProbeResult => {
      try {
        const normalized = normalizeRepoRelativePath(relPath);
        const abs = path.join(workspaceRoot, normalized);
        if (!fs.existsSync(abs)) {
          return { exists: false };
        }
        const stat = fs.statSync(abs);
        const isFile = stat.isFile();
        const content = isFile ? fs.readFileSync(abs, 'utf8') : undefined;
        return {
          exists: true,
          isFile,
          content
        };
      } catch {
        return { exists: false };
      }
    };
  }

  private collectSiblingSummaries(
    workspaceRoot: string | undefined,
    collectionsPath = 'collections',
    excludeFilePath?: string
  ): SiblingCollectionSummary[] {
    if (!workspaceRoot) {
      return [];
    }
    const dir = path.join(workspaceRoot, collectionsPath);
    const cacheKey = path.resolve(dir);
    const now = Date.now();
    const cached = this.siblingsCacheByDir.get(cacheKey);
    let allSiblings: SiblingCollectionSummary[];

    if (cached && now - cached.cachedAt < WORKSPACE_SCAN_CACHE_TTL_MS) {
      allSiblings = cached.siblings;
    } else {
      if (!fs.existsSync(dir)) {
        return [];
      }
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir).filter((f) => /\.collection\.ya?ml$/i.test(f));
      } catch {
        return [];
      }

      allSiblings = [];
      for (const fileName of entries) {
        const absPath = path.join(dir, fileName);
        const relLabel = path.relative(workspaceRoot, absPath).replaceAll('\\', '/');
        try {
          const parsed = yaml.load(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown> | undefined;
          allSiblings.push({
            file: relLabel,
            id: typeof parsed?.id === 'string' ? parsed.id : undefined,
            name: typeof parsed?.name === 'string' ? parsed.name : undefined
          });
        } catch {
          allSiblings.push({ file: relLabel });
        }
      }
      this.siblingsCacheByDir.set(cacheKey, { siblings: allSiblings, cachedAt: now });
    }

    if (!excludeFilePath) {
      return allSiblings;
    }
    const excludedRel = path.relative(workspaceRoot, excludeFilePath).replaceAll('\\', '/');
    return allSiblings.filter((s) => s.file !== excludedRel);
  }

  /**
   * Invalidate cached workspace primitive and sibling collection scans.
   * @param workspaceRoot Optional workspace root path to clear; clears all when omitted.
   */
  public clearWorkspaceCache(workspaceRoot?: string): void {
    if (!workspaceRoot) {
      this.primitivesCacheByWorkspace.clear();
      this.siblingsCacheByDir.clear();
      return;
    }
    const normalizedRoot = path.resolve(workspaceRoot);
    this.primitivesCacheByWorkspace.delete(normalizedRoot);
    for (const key of this.siblingsCacheByDir.keys()) {
      if (key.startsWith(normalizedRoot)) {
        this.siblingsCacheByDir.delete(key);
      }
    }
  }

  /**
   * Discover all candidate primitive files across standard repository folders.
   * @param workspaceRoot Repository root path.
   */
  public discoverWorkspacePrimitives(workspaceRoot: string): WorkspacePrimitiveCandidate[] {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
      return [];
    }

    const cacheKey = path.resolve(workspaceRoot);
    const now = Date.now();
    const cached = this.primitivesCacheByWorkspace.get(cacheKey);
    if (cached && now - cached.cachedAt < WORKSPACE_SCAN_CACHE_TTL_MS) {
      return cached.candidates;
    }

    const candidates: WorkspacePrimitiveCandidate[] = [];
    const seen = new Set<string>();

    const addCandidate = (relPath: string): void => {
      const normalized = relPath.replaceAll('\\', '/');
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      const kind = inferPrimitiveKindFromPath(normalized);
      const abs = path.join(workspaceRoot, normalized);
      let title = humanizeSlug(
        kind === 'skill' || kind === 'plugin' || kind === 'power'
          ? path.basename(path.dirname(normalized))
          : path.basename(normalized)
      );
      let description: string | undefined;

      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const text = fs.readFileSync(abs, 'utf8');
          if (normalized.endsWith('.json')) {
            const jsonObj = JSON.parse(text) as Record<string, unknown>;
            if (typeof jsonObj.name === 'string' && jsonObj.name) {
              title = jsonObj.name;
            }
            if (typeof jsonObj.description === 'string' && jsonObj.description) {
              description = jsonObj.description;
            }
          } else {
            const fm = parsePrimitiveFrontmatter(text);
            if (typeof fm.frontmatter.name === 'string' && fm.frontmatter.name) {
              title = fm.frontmatter.name;
            } else if (typeof fm.frontmatter.title === 'string' && fm.frontmatter.title) {
              title = fm.frontmatter.title;
            }
            if (typeof fm.frontmatter.description === 'string' && fm.frontmatter.description) {
              description = fm.frontmatter.description;
            }
          }
        }
      } catch {
        // Fallback to humanized slug
      }

      candidates.push({
        path: normalized,
        kind,
        title,
        description
      });
    };

    const walkDir = (absDir: string, maxDepth = 3): void => {
      if (maxDepth < 0 || !fs.existsSync(absDir)) {
        return;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const childAbs = path.join(absDir, entry.name);
        const rel = path.relative(workspaceRoot, childAbs).replaceAll('\\', '/');
        if (entry.isDirectory()) {
          // If it's a skill directory with SKILL.md, register SKILL.md directly
          const skillMd = path.join(childAbs, 'SKILL.md');
          if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
            addCandidate(path.relative(workspaceRoot, skillMd).replaceAll('\\', '/'));
            continue;
          }
          // If it's a plugin directory with plugin.json, register plugin.json directly
          const pluginJson = path.join(childAbs, 'plugin.json');
          if (fs.existsSync(pluginJson) && fs.statSync(pluginJson).isFile()) {
            addCandidate(path.relative(workspaceRoot, pluginJson).replaceAll('\\', '/'));
            continue;
          }
          // If it's a power directory with POWER.md, register POWER.md directly
          const powerMd = path.join(childAbs, 'POWER.md');
          if (fs.existsSync(powerMd) && fs.statSync(powerMd).isFile()) {
            addCandidate(path.relative(workspaceRoot, powerMd).replaceAll('\\', '/'));
            continue;
          }
          walkDir(childAbs, maxDepth - 1);
        } else if (entry.isFile() && /\.(?:md|mdc|json|py|ts|js)$/i.test(entry.name)) {
          addCandidate(rel);
        }
      }
    };

    for (const scanRel of PRIMITIVE_SCAN_DIRS) {
      walkDir(path.join(workspaceRoot, scanRel), 3);
    }

    const sortedCandidates = candidates.toSorted((a, b) => a.path.localeCompare(b.path));
    this.primitivesCacheByWorkspace.set(cacheKey, {
      candidates: sortedCandidates,
      cachedAt: Date.now()
    });
    return sortedCandidates;
  }

  /**
   * Inspect a `.collection.yml` document string and resolve item statuses,
   * diagnostics, inline decorations, and unassigned workspace primitives.
   * @param content Raw YAML document string.
   * @param options Optional file path, workspace root, sibling summaries, and pre-discovered primitives.
   * @param options.filePath
   * @param options.workspaceRoot
   * @param options.siblingCollections
   * @param options.workspacePrimitives
   */
  public inspectDocument(
    content: string,
    options?: {
      filePath?: string;
      workspaceRoot?: string;
      siblingCollections?: SiblingCollectionSummary[];
      workspacePrimitives?: WorkspacePrimitiveCandidate[];
    }
  ): CollectionDocumentInspection {
    const workspaceRoot = options?.workspaceRoot
      ?? (options?.filePath ? path.resolve(path.dirname(options.filePath), '..') : undefined);
    const fileLabel = (options?.filePath && workspaceRoot)
      ? path.relative(workspaceRoot, options.filePath).replaceAll('\\', '/')
      : (options?.filePath ? path.basename(options.filePath) : 'collection.yml');

    const checkFile = this.buildFileProbe(workspaceRoot);
    const siblingCollections = options?.siblingCollections
      ?? this.collectSiblingSummaries(workspaceRoot, 'collections', options?.filePath);

    const validation = validateCollectionYaml(content, {
      fileLabel,
      checkFile,
      siblingCollections
    });

    const manifest = validation.manifest;
    const items: CollectionItemDefinition[] = Array.isArray(manifest?.items) ? manifest.items : [];
    const workspacePrimitives = options?.workspacePrimitives
      ?? (workspaceRoot ? this.discoverWorkspacePrimitives(workspaceRoot) : []);
    const primitiveByPath = new Map(workspacePrimitives.map((p) => [p.path, p]));
    const assignedPaths = new Set<string>();

    const itemStatuses: CollectionItemFileStatus[] = items.map((item, idx) => {
      const rawPath = typeof item?.path === 'string' ? item.path : '';
      let normalizedPath = rawPath;
      try {
        normalizedPath = normalizeRepoRelativePath(rawPath);
      } catch {
        // Keep rawPath
      }
      if (normalizedPath) {
        assignedPaths.add(normalizedPath);
      }

      const probe = (checkFile && normalizedPath && isSafeRepoRelativePath(normalizedPath))
        ? checkFile(normalizedPath)
        : { exists: false };

      const routeMismatch = validation.diagnostics.some(
        (d) => d.code === 'COLLECTION_KIND_ROUTE_MISMATCH' && d.jsonPath[0] === 'items' && d.jsonPath[1] === idx
      );
      const candidateMeta = primitiveByPath.get(normalizedPath);

      return {
        index: idx,
        path: rawPath,
        kind: typeof item?.kind === 'string' ? item.kind : 'prompt',
        inferredKind: inferPrimitiveKindFromPath(normalizedPath || rawPath),
        title: item?.title ?? item?.name,
        description: item?.description,
        tags: item?.tags,
        exists: probe.exists,
        routeMismatch,
        previewTitle: item?.title ?? item?.name ?? candidateMeta?.title,
        previewDescription: item?.description ?? candidateMeta?.description
      };
    });

    let readmeExists = false;
    if (manifest?.readme?.path && isSafeRepoRelativePath(manifest.readme.path) && checkFile) {
      readmeExists = checkFile(normalizeRepoRelativePath(manifest.readme.path)).exists;
    }

    const unassignedPrimitives = workspacePrimitives.filter((p) => !assignedPaths.has(p.path));

    return {
      valid: validation.valid,
      manifest,
      errors: validation.errors,
      warnings: validation.warnings,
      diagnostics: validation.diagnostics,
      inlineDecorations: validation.inlineDecorations,
      nodeRanges: validation.nodeRanges,
      itemStatuses,
      readmeExists,
      unassignedPrimitives
    };
  }

  /**
   * Detect and inspect all `*.collection.{yml,yaml}` files in a workspace.
   * @param workspaceRoot Workspace root directory.
   * @param collectionsPath Relative collections folder (default `'collections'`).
   */
  public detectWorkspaceCollections(
    workspaceRoot: string,
    collectionsPath = 'collections'
  ): WorkspaceCollectionsOverview {
    const collectionsDir = path.join(workspaceRoot, collectionsPath);
    const workspacePrimitives = this.discoverWorkspacePrimitives(workspaceRoot);
    if (!fs.existsSync(collectionsDir)) {
      return {
        workspaceRoot,
        collectionsPath,
        collections: [],
        workspacePrimitives,
        totalErrors: 0,
        totalWarnings: 0,
        valid: true
      };
    }

    const files = fs.readdirSync(collectionsDir)
      .filter((f) => /\.collection\.ya?ml$/i.test(f))
      .toSorted();

    const rawContentsByFile = new Map<string, string>();
    const siblingCollections: SiblingCollectionSummary[] = files.map((fileName) => {
      const absPath = path.join(collectionsDir, fileName);
      const relPath = path.relative(workspaceRoot, absPath).replaceAll('\\', '/');
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        rawContentsByFile.set(fileName, text);
        const parsed = yaml.load(text) as Record<string, unknown> | undefined;
        return {
          file: relPath,
          id: typeof parsed?.id === 'string' ? parsed.id : undefined,
          name: typeof parsed?.name === 'string' ? parsed.name : undefined
        };
      } catch {
        return { file: relPath };
      }
    });

    this.siblingsCacheByDir.set(path.resolve(collectionsDir), {
      siblings: siblingCollections,
      cachedAt: Date.now()
    });

    const collections: WorkspaceCollectionSummary[] = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const fileName of files) {
      const filePath = path.join(collectionsDir, fileName);
      const relPath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/');
      const content = rawContentsByFile.get(fileName) ?? fs.readFileSync(filePath, 'utf8');
      const inspection = this.inspectDocument(content, {
        filePath,
        workspaceRoot,
        siblingCollections,
        workspacePrimitives
      });
      const manifest = inspection.manifest;
      const errorCount = inspection.diagnostics.filter((d) => d.severity === 'error').length;
      const warningCount = inspection.diagnostics.filter((d) => d.severity === 'warning').length;
      totalErrors += errorCount;
      totalWarnings += warningCount;

      collections.push({
        filePath,
        relPath,
        id: manifest?.id ?? fileName.replace(/\.collection\.ya?ml$/i, ''),
        name: manifest?.name ?? fileName,
        version: manifest?.version ?? '1.0.0',
        description: manifest?.description ?? '',
        itemCount: Array.isArray(manifest?.items) ? manifest.items.length : 0,
        mcpServerCount: manifest?.mcp?.items ? Object.keys(manifest.mcp.items).length : 0,
        valid: inspection.valid,
        errorCount,
        warningCount,
        inspection
      });
    }

    return {
      workspaceRoot,
      collectionsPath,
      collections,
      workspacePrimitives,
      totalErrors,
      totalWarnings,
      valid: totalErrors === 0
    };
  }

  /**
   * Apply a comment-preserving YAML mutation and re-inspect the document.
   * @param content Current YAML content.
   * @param mutation Mutation payload.
   * @param options Inspection context options.
   * @param options.filePath
   * @param options.workspaceRoot
   * @param options.siblingCollections
   */
  public applyMutation(
    content: string,
    mutation: CollectionYamlMutation,
    options?: {
      filePath?: string;
      workspaceRoot?: string;
      siblingCollections?: SiblingCollectionSummary[];
    }
  ): {
    updatedContent: string;
    inspection: CollectionDocumentInspection;
  } {
    const updatedContent = applyCollectionYamlMutation(content, mutation);
    const inspection = this.inspectDocument(updatedContent, options);
    return {
      updatedContent,
      inspection
    };
  }

  public locateCursor(content: string, line: number): CollectionCursorNodeContext {
    return locateCollectionYamlCursor(content, line);
  }

  public summarizeChanges(baseContent: string | undefined, currentContent: string): CollectionChangeSummary {
    return summarizeCollectionYamlChanges(baseContent, currentContent);
  }

  /**
   * Create a new `.collection.yml` file (and optional starter README) on disk.
   * @param workspaceRoot Workspace root directory.
   * @param input New collection configuration.
   */
  public createCollectionFile(
    workspaceRoot: string,
    input: CreateCollectionVisualInput
  ): {
    filePath: string;
    relPath: string;
    content: string;
    inspection: CollectionDocumentInspection;
  } {
    const id = generateSanitizedId(input.id) || 'my-collection';
    const collectionsPath = input.collectionsPath?.trim() || 'collections';
    const collectionsDir = path.join(workspaceRoot, collectionsPath);
    fs.mkdirSync(collectionsDir, { recursive: true });

    const filePath = path.join(collectionsDir, `${id}.collection.yml`);
    if (fs.existsSync(filePath)) {
      throw new Error(`Collection '${id}' already exists at ${filePath}`);
    }

    const name = input.name?.trim() || `${humanizeSlug(id)} Collection`;
    const description = input.description?.trim() || `Curated AI primitives for ${name}.`;
    const version = input.version?.trim() || '1.0.0';
    const author = input.author?.trim() || 'Team';
    const tags = (input.tags ?? ['ai', 'prompts']).map((t) => t.trim()).filter((t) => t.length > 0);
    const readmeRelPath = `docs/${id}/README.md`;

    if (input.createReadme !== false) {
      const readmeAbs = path.join(workspaceRoot, readmeRelPath);
      if (!fs.existsSync(readmeAbs)) {
        fs.mkdirSync(path.dirname(readmeAbs), { recursive: true });
        fs.writeFileSync(
          readmeAbs,
          `# ${name}\n\n${description}\n\n## Included Primitives\n\nAdd prompts, instructions, agents, skills, or plugins using the Visual Collection Editor.\n`,
          'utf8'
        );
      }
    }

    const lines = [
      '# yaml-language-server: $schema=../schemas/collection.schema.json',
      `id: ${id}`,
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      `version: ${version}`,
      `author: ${JSON.stringify(author)}`,
      'tags:',
      ...tags.map((t) => `  - ${t}`),
      ...(input.createReadme === false
        ? []
        : ['readme:', `  path: ${readmeRelPath}`]),
      'display:',
      '  ordering: manual',
      '  show_badge: true',
      'items: []',
      ''
    ];
    const content = lines.join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
    this.clearWorkspaceCache(workspaceRoot);

    const relPath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/');
    const inspection = this.inspectDocument(content, { filePath, workspaceRoot });
    return {
      filePath,
      relPath,
      content,
      inspection
    };
  }

  /**
   * Duplicate an existing `.collection.yml` file under a new `id` and `name`.
   * @param workspaceRoot Workspace root directory.
   * @param sourceFilePath Existing `.collection.yml` path (absolute or relative).
   * @param newId New collection ID.
   * @param newName Optional new collection display name.
   */
  public duplicateCollectionFile(
    workspaceRoot: string,
    sourceFilePath: string,
    newId: string,
    newName?: string
  ): {
    filePath: string;
    relPath: string;
    content: string;
    inspection: CollectionDocumentInspection;
  } {
    const absSource = path.isAbsolute(sourceFilePath)
      ? sourceFilePath
      : path.join(workspaceRoot, sourceFilePath);
    if (!fs.existsSync(absSource)) {
      throw new Error(`Source collection file not found: ${sourceFilePath}`);
    }

    const sanitizedId = generateSanitizedId(newId) || 'duplicated-collection';
    const targetFilePath = path.join(path.dirname(absSource), `${sanitizedId}.collection.yml`);
    if (fs.existsSync(targetFilePath)) {
      throw new Error(`Collection '${sanitizedId}' already exists at ${targetFilePath}`);
    }

    const sourceContent = fs.readFileSync(absSource, 'utf8');
    const displayName = newName?.trim() || `${humanizeSlug(sanitizedId)} Collection`;
    const updatedContent = applyCollectionYamlMutation(sourceContent, {
      kind: 'update-metadata',
      metadata: {
        id: sanitizedId,
        name: displayName
      }
    });

    fs.writeFileSync(targetFilePath, updatedContent, 'utf8');
    this.clearWorkspaceCache(workspaceRoot);
    const relPath = path.relative(workspaceRoot, targetFilePath).replaceAll('\\', '/');
    const inspection = this.inspectDocument(updatedContent, {
      filePath: targetFilePath,
      workspaceRoot
    });

    return {
      filePath: targetFilePath,
      relPath,
      content: updatedContent,
      inspection
    };
  }

  /**
   * Delete a `.collection.yml` file from disk.
   * @param workspaceRoot Workspace root directory.
   * @param filePath Collection file path (absolute or relative).
   */
  public deleteCollectionFile(workspaceRoot: string, filePath: string): void {
    const root = path.resolve(workspaceRoot);
    const abs = path.resolve(root, filePath);
    const rel = path.relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Refusing to delete '${filePath}': path is outside the workspace.`);
    }
    if (!/\.collection\.ya?ml$/i.test(abs)) {
      throw new Error(`Refusing to delete '${filePath}': not a .collection.yml or .collection.yaml file.`);
    }
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
    }
    this.clearWorkspaceCache(workspaceRoot);
  }

  /**
   * Scaffold a new or missing primitive file (`prompt`, `instruction`, `agent`,
   * `skill`, `plugin`, `hook`, `readme`, etc.) on disk and optionally add it to
   * the collection manifest.
   * @param workspaceRoot Workspace root directory.
   * @param collectionContent Current `.collection.yml` content.
   * @param input Scaffolding parameters.
   * @param options Optional inspection options.
   * @param options.filePath
   * @param options.siblingCollections
   */
  public async scaffoldPrimitiveForCollection(
    workspaceRoot: string,
    collectionContent: string,
    input: ScaffoldPrimitiveForCollectionInput,
    options?: {
      filePath?: string;
      siblingCollections?: SiblingCollectionSummary[];
    }
  ): Promise<{
    createdFileRelPath: string;
    createdFileAbsPath: string;
    updatedCollectionContent: string;
    inspection: CollectionDocumentInspection;
  }> {
    const kind = input.kind.trim().toLowerCase();

    if (kind === 'readme') {
      const readmeRelPath = normalizeRepoRelativePath(
        input.customRelPath?.trim() || `docs/${generateSanitizedId(input.name || 'collection')}/README.md`
      );
      const readmeAbsPath = path.join(workspaceRoot, readmeRelPath);
      if (!fs.existsSync(readmeAbsPath)) {
        fs.mkdirSync(path.dirname(readmeAbsPath), { recursive: true });
        const body = input.body?.trim()
          || `# ${input.name || 'Collection Documentation'}\n\n${input.description || 'Overview and usage guide for this collection.'}\n`;
        fs.writeFileSync(readmeAbsPath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
      }
      const readmeUpdatedYaml = applyCollectionYamlMutation(collectionContent, {
        kind: 'update-readme',
        path: readmeRelPath
      });
      this.clearWorkspaceCache(workspaceRoot);
      const readmeInspection = this.inspectDocument(readmeUpdatedYaml, {
        filePath: options?.filePath,
        workspaceRoot,
        siblingCollections: options?.siblingCollections
      });
      return {
        createdFileRelPath: readmeRelPath,
        createdFileAbsPath: readmeAbsPath,
        updatedCollectionContent: readmeUpdatedYaml,
        inspection: readmeInspection
      };
    }

    const canonicalKind = normalizePrimitiveKind(kind) ?? 'prompt';
    const slug = generateSanitizedId(input.name) || 'example';
    const relPath = normalizeRepoRelativePath(
      input.customRelPath?.trim() || defaultPathForPrimitiveKind(canonicalKind, slug)
    );
    const absPath = path.join(workspaceRoot, relPath);

    if (canonicalKind === 'plugin' && !fs.existsSync(absPath)) {
      const pluginName = path.basename(path.dirname(relPath));
      const parentDir = path.dirname(path.dirname(absPath));
      fs.mkdirSync(parentDir, { recursive: true });
      const res = await createPlugin({
        parentDir,
        name: pluginName,
        description: input.description || `A ${pluginName} plugin`,
        author: input.author || 'Author'
      });
      if (!res.success && !fs.existsSync(absPath)) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(
          absPath,
          `${JSON.stringify({
            $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
            name: pluginName,
            version: '1.0.0',
            description: input.description || `A ${pluginName} plugin`,
            author: { name: input.author || 'Author' }
          }, null, 2)}\n`,
          'utf8'
        );
      }
    } else if (!fs.existsSync(absPath)) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      if (relPath.endsWith('.json')) {
        const jsonPayload = canonicalKind === 'hook'
          ? {
            name: slug,
            description: input.description || `Hook for ${input.name}`,
            event: 'pre-commit',
            command: 'echo "Running hook"'
          }
          : {
            name: slug,
            description: input.description || `Configuration for ${input.name}`
          };
        fs.writeFileSync(absPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');
      } else {
        const frontmatter: Record<string, unknown> = {
          name: canonicalKind === 'skill' ? slug : input.name,
          description: input.description || `Guidance and instructions for ${input.name}.`,
          ...(canonicalKind === 'instruction' ? { applyTo: input.applyTo || '**' } : {}),
          ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
          ...(input.model ? { model: input.model } : {})
        };
        const defaultBody = input.body?.trim()
          || `# ${input.name}\n\n${input.description || `Instructions for ${input.name}.`}\n\n## Guidelines\n\n- Follow project conventions.\n`;
        const fileText = serializePrimitiveFrontmatter(frontmatter, defaultBody, { forceFrontmatter: true });
        fs.writeFileSync(absPath, fileText, 'utf8');
      }
    }

    let updatedCollectionContent = collectionContent;
    if (input.addToCollection !== false) {
      const currentParsed = (yaml.load(collectionContent) ?? {}) as Partial<CollectionManifest>;
      const alreadyInItems = (currentParsed.items ?? []).some((it) => it?.path === relPath);
      if (!alreadyInItems) {
        updatedCollectionContent = applyCollectionYamlMutation(collectionContent, {
          kind: 'add-item',
          item: {
            path: relPath,
            kind: canonicalKind,
            title: input.name,
            ...(input.description ? { description: input.description } : {}),
            ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {})
          }
        });
      }
    }

    this.clearWorkspaceCache(workspaceRoot);
    const inspection = this.inspectDocument(updatedCollectionContent, {
      filePath: options?.filePath,
      workspaceRoot,
      siblingCollections: options?.siblingCollections
    });

    return {
      createdFileRelPath: relPath,
      createdFileAbsPath: absPath,
      updatedCollectionContent,
      inspection
    };
  }

  /**
   * Read a referenced primitive file or README into a structured visual model
   * (YAML frontmatter + Markdown body, or parsed `plugin.json`).
   * @param workspaceRoot Workspace root directory.
   * @param relPath Repo-relative path to the primitive file.
   * @param kind Optional primitive kind override.
   */
  public readPrimitiveContent(
    workspaceRoot: string,
    relPath: string,
    kind?: string
  ): PrimitiveVisualContent {
    const normalized = normalizeRepoRelativePath(relPath);
    const absPath = path.join(workspaceRoot, normalized);
    const effectiveKind = kind ?? inferPrimitiveKindFromPath(normalized);

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return {
        relPath: normalized,
        absPath,
        kind: effectiveKind,
        exists: false,
        format: normalized.endsWith('plugin.json')
          ? 'plugin-json'
          : (normalized.endsWith('.json') ? 'json' : 'markdown-frontmatter'),
        frontmatter: {},
        body: '',
        rawContent: ''
      };
    }

    const rawContent = fs.readFileSync(absPath, 'utf8');
    if (normalized.endsWith('plugin.json')) {
      let pluginManifest: Record<string, unknown> = {};
      try {
        pluginManifest = JSON.parse(rawContent) as Record<string, unknown>;
      } catch {
        pluginManifest = {};
      }
      return {
        relPath: normalized,
        absPath,
        kind: effectiveKind,
        exists: true,
        format: 'plugin-json',
        frontmatter: {},
        body: rawContent,
        rawContent,
        pluginManifest
      };
    }

    if (normalized.endsWith('.json')) {
      return {
        relPath: normalized,
        absPath,
        kind: effectiveKind,
        exists: true,
        format: 'json',
        frontmatter: {},
        body: rawContent,
        rawContent
      };
    }

    const parsed = parsePrimitiveFrontmatter(rawContent);
    return {
      relPath: normalized,
      absPath,
      kind: effectiveKind,
      exists: true,
      format: 'markdown-frontmatter',
      frontmatter: parsed.frontmatter,
      body: parsed.body.replace(/^\r?\n/, ''),
      rawContent,
      rawFrontmatter: parsed.rawFrontmatter,
      parseError: parsed.parseError
    };
  }

  /**
   * Write visual edits (frontmatter + Markdown body, `plugin.json` manifest, or
   * raw text) back to a referenced primitive file on disk.
   * @param workspaceRoot Workspace root directory.
   * @param relPath Repo-relative path to the primitive file.
   * @param update Content update payload.
   */
  public writePrimitiveContent(
    workspaceRoot: string,
    relPath: string,
    update: PrimitiveVisualContentUpdate
  ): PrimitiveVisualContent {
    const normalized = normalizeRepoRelativePath(relPath);
    const absPath = path.join(workspaceRoot, normalized);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    let nextRaw: string;
    if (update.rawContent !== undefined) {
      nextRaw = update.rawContent;
    } else if (normalized.endsWith('plugin.json') && update.pluginManifest) {
      const existing = this.readPrimitiveContent(workspaceRoot, normalized, update.kind);
      const existingAuthor = (existing.pluginManifest?.author && typeof existing.pluginManifest.author === 'object')
        ? (existing.pluginManifest.author as Record<string, unknown>)
        : {};
      const incomingAuthor = (update.pluginManifest.author && typeof update.pluginManifest.author === 'object')
        ? (update.pluginManifest.author as Record<string, unknown>)
        : {};
      const mergedAuthor = {
        ...existingAuthor,
        ...Object.fromEntries(
          Object.entries(incomingAuthor).filter(([, val]) => val !== undefined && val !== '')
        )
      };
      const merged = {
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
        ...existing.pluginManifest,
        ...update.pluginManifest,
        ...(Object.keys(mergedAuthor).length > 0 ? { author: mergedAuthor } : {})
      };
      nextRaw = `${JSON.stringify(merged, null, 2)}\n`;
    } else {
      const existing = this.readPrimitiveContent(workspaceRoot, normalized, update.kind);
      const body = update.body ?? existing.body;
      const incomingEntries = Object.entries(update.frontmatter ?? {}).filter(
        ([, val]) => val !== undefined && val !== '' && (!Array.isArray(val) || val.length > 0)
      );
      if (existing.parseError && existing.rawFrontmatter !== undefined && incomingEntries.length === 0) {
        const normalizedBody = body.replace(/^\r?\n/, '');
        const full = `---\n${existing.rawFrontmatter}\n---\n\n${normalizedBody}`;
        nextRaw = full.endsWith('\n') ? full : `${full}\n`;
      } else {
        const mergedFrontmatter = {
          ...existing.frontmatter,
          ...update.frontmatter
        };
        nextRaw = serializePrimitiveFrontmatter(mergedFrontmatter, body);
      }
    }

    fs.writeFileSync(absPath, nextRaw, 'utf8');
    this.clearWorkspaceCache(workspaceRoot);
    return this.readPrimitiveContent(workspaceRoot, normalized, update.kind);
  }
}
