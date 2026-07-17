/**
 * `bundle manifest` subcommand.
 *
 * Reads a collection YAML file plus the referenced primitive files, then
 * writes a deployment manifest YAML to `outFile`.
 * @module commands/bundle-manifest
 */
import * as path from 'node:path';
import {
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Bundle manifest data.
 */
interface BundleManifestData {
  id: string;
  version: string;
  outFile: string;
  totalItems: number;
  itemsByType: Record<string, number>;
  mcpServerCount: number;
}

/**
 * Options accepted by {@link generateBundleManifest}.
 */
export interface BundleManifestOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /** Bundle version (e.g. '1.0.0'). Required. */
  version: string;
  /**
   * Collection file (repo-relative). When unset, the first
   * `*.collection.yml` under `<cwd>/collections/` is used.
   */
  collectionFile?: string;
}

/**
 * Kind to type mapping for deployment manifest.
 */
const KIND_TO_TYPE_MAP: Record<string, string> = {
  instruction: 'instructions',
  'chat-mode': 'chatmode',
  plugin: 'plugin',
  hook: 'hook'
};

/**
 * Raw collection structure.
 */
interface RawCollection {
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  items?: { path?: string; kind?: string }[];
  mcpServers?: Record<string, unknown>;
  mcp?: { items?: Record<string, unknown> };
}

interface PromptEntry {
  id: string;
  name: string;
  description: string;
  file: string;
  type: string;
  tags: string[];
}

/**
 * Extract item metadata from markdown content.
 * @param itemContent Markdown content.
 * @returns Extracted name and description.
 */
function extractItemMetadata(itemContent: string): { name: string; description: string } {
  const nameMatch = /^#\s+(.+)$/m.exec(itemContent);
  const descMatch = /^##?\s*Description[:\s]+(.+)$/im.exec(itemContent)
    ?? /^>\s*(.+)$/m.exec(itemContent);
  return {
    name: nameMatch === null ? '' : nameMatch[1],
    description: descMatch === null ? '' : descMatch[1]
  };
}

/**
 * Extract item metadata from JSON content (plugin.json or hook config).
 * Falls back to empty strings when fields are absent.
 * @param itemContent Raw JSON string.
 * @returns Extracted name and description.
 */
function extractJsonItemMetadata(itemContent: string): { name: string; description: string } {
  try {
    const parsed = JSON.parse(itemContent) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : ''
    };
  } catch {
    return { name: '', description: '' };
  }
}

/**
 * Extract item metadata from file content, dispatching by extension.
 * @param itemContent Raw file content.
 * @param itemPath Repo-relative path (used to determine format).
 * @returns Extracted name and description.
 */
function extractItemMetadataByPath(
  itemContent: string,
  itemPath: string
): { name: string; description: string } {
  return itemPath.endsWith('.json')
    ? extractJsonItemMetadata(itemContent)
    : extractItemMetadata(itemContent);
}

/**
 * Generate item ID from path and kind.
 * @param itemPath Item path.
 * @param kind Item kind.
 * @returns Generated item ID.
 */
function generateItemId(itemPath: string, kind: string): string {
  const extension = path.extname(itemPath);
  if (kind === 'skill' || kind === 'plugin') {
    const parts = itemPath.split('/');
    return parts.length >= 2
      ? (parts.at(-2) ?? path.basename(itemPath, extension))
      : path.basename(itemPath, extension);
  }
  return path.basename(itemPath, extension);
}

/**
 * Build a prompt entry for the deployment manifest.
 * @param item Collection item.
 * @param item.path
 * @param item.kind
 * @param itemPath Item path.
 * @param collection Raw collection.
 * @param itemContent Item markdown content.
 * @returns Prompt entry.
 */
function buildPromptEntry(
  item: { path?: string; kind?: string },
  itemPath: string,
  collection: RawCollection,
  itemContent: string
): PromptEntry {
  const { name, description } = extractItemMetadataByPath(itemContent, itemPath);
  const itemId = generateItemId(itemPath, item.kind || '');
  const tags = Array.isArray(collection.tags) ? [...collection.tags] : [];
  const type = KIND_TO_TYPE_MAP[item.kind || ''] ?? item.kind ?? '';
  return {
    id: itemId,
    name: name || itemId,
    description,
    file: itemPath,
    type,
    tags
  };
}

/**
 * Process collection items into prompt entries.
 * @param items Collection items.
 * @param collection Raw collection.
 * @param ctx CLI context.
 * @param cwd Current working directory.
 * @returns Array of prompt entries.
 */
async function processCollectionItems(
  items: { path?: string; kind?: string }[],
  collection: RawCollection,
  ctx: Context,
  cwd: string
): Promise<PromptEntry[]> {
  const prompts: PromptEntry[] = [];
  for (const item of items) {
    if (item.path === undefined || item.kind === undefined) {
      continue;
    }
    const itemPath = normalizeRepoRelativePath(item.path);
    const itemAbs = path.join(cwd, itemPath);
    if (!(await ctx.fs.exists(itemAbs))) {
      throw new RegistryError({
        code: 'BUNDLE.ITEM_NOT_FOUND',
        message: `Referenced ${item.kind} file not found: ${itemPath}`,
        context: { itemPath, kind: item.kind }
      });
    }
    const itemContent = await ctx.fs.readFile(itemAbs);
    prompts.push(buildPromptEntry(item, itemPath, collection, itemContent));
  }
  return prompts;
}

/**
 * Count items by type.
 * @param prompts Prompt entries.
 * @returns Record of type to count.
 */
function countItemsByType(prompts: { type: string }[]): Record<string, number> {
  const itemsByType: Record<string, number> = {};
  for (const p of prompts) {
    itemsByType[p.type] = (itemsByType[p.type] ?? 0) + 1;
  }
  return itemsByType;
}

/**
 * Write manifest file to disk.
 * @param collection Raw collection.
 * @param prompts Prompt entries.
 * @param version Bundle version.
 * @param outFile Output file path.
 * @param ctx CLI context.
 */
async function writeManifestFile(
  collection: RawCollection,
  prompts: PromptEntry[],
  version: string,
  outFile: string,
  ctx: Context
): Promise<void> {
  const manifest = buildManifest(collection, prompts, version);
  await ctx.fs.mkdir(path.dirname(outFile), { recursive: true });
  await ctx.fs.writeFile(outFile, yaml.dump(manifest, { lineWidth: -1 }));
}

/**
 * Build manifest data for output.
 * @param collection Raw collection.
 * @param prompts Prompt entries.
 * @param version Bundle version.
 * @param outFile Output file path.
 * @returns Bundle manifest data.
 */
function buildManifestData(
  collection: RawCollection,
  prompts: PromptEntry[],
  version: string,
  outFile: string
): BundleManifestData {
  const itemsByType = countItemsByType(prompts);
  const manifestId = collection.id ?? 'unknown';
  const mcpServers = collection.mcpServers ?? collection.mcp?.items;
  return {
    id: manifestId,
    version,
    outFile,
    totalItems: prompts.length,
    itemsByType,
    mcpServerCount: mcpServers === undefined ? 0 : Object.keys(mcpServers).length
  };
}

/**
 * Build deployment manifest.
 * @param collection Raw collection.
 * @param prompts Prompt entries.
 * @param version Bundle version.
 * @returns Deployment manifest object.
 */
function buildManifest(
  collection: RawCollection,
  prompts: PromptEntry[],
  version: string
): unknown {
  const manifestId = collection.id ?? 'unknown';
  const mcpServers = collection.mcpServers ?? collection.mcp?.items;
  return {
    id: manifestId,
    version,
    name: collection.name ?? '',
    description: collection.description ?? '',
    author: collection.author ?? 'Prompt Registry',
    tags: collection.tags ?? [],
    environments: ['vscode', 'windsurf', 'cursor'],
    license: 'MIT',
    repository: '',
    prompts,
    dependencies: [],
    ...(mcpServers !== undefined && Object.keys(mcpServers).length > 0 ? { mcpServers } : {})
  };
}

/**
 * Resolve collection file path.
 * @param ctx CLI context.
 * @param cwd Current working directory.
 * @param explicit Explicit collection file path.
 * @returns Resolved collection file path.
 */
const resolveCollectionFile = async (
  ctx: Context,
  cwd: string,
  explicit: string | undefined
): Promise<string> => {
  if (explicit !== undefined) {
    return explicit;
  }
  const collectionsDir = path.join(cwd, 'collections');
  if (!(await ctx.fs.exists(collectionsDir))) {
    throw new RegistryError({
      code: 'FS.NOT_FOUND',
      message: `collections/ directory not found under ${cwd}`,
      hint: 'Pass --collection-file or run from a repo with a collections/ folder.'
    });
  }
  const entries = await ctx.fs.readDir(collectionsDir);
  const first = entries.find((e) => e.endsWith('.collection.yml'));
  if (first === undefined) {
    throw new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: 'no `*.collection.yml` files in collections/'
    });
  }
  return path.join('collections', first);
};

/**
 * Render bundle manifest data as text.
 * @param d Bundle manifest data.
 * @returns Formatted text output.
 */
const renderText = (d: BundleManifestData): string => {
  const lines: string[] = [`Generated ${d.outFile}`, `  id: ${d.id}`, `  version: ${d.version}`, `  total items: ${d.totalItems}`];
  for (const [type, count] of Object.entries(d.itemsByType)) {
    lines.push(`    ${type}: ${count}`);
  }
  if (d.mcpServerCount > 0) {
    // Capitalised "MCP Servers" preserves the legacy script's text
    // (a legacy regression test asserted the exact substring
    // `MCP Servers: <n>` to keep CI logs stable).
    lines.push(`  MCP Servers: ${d.mcpServerCount}`);
  }
  return `${lines.join('\n')}\n`;
};

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'bundle.manifest',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};

/**
 * Generate a deployment manifest from a collection, writing it to
 * `outFile` and emitting the result via `formatOutput`.
 *
 * Exported (unlike the reference branch's module-private equivalent) so
 * `bundle build` can call it directly as an in-process sub-step instead
 * of constructing a `CommandDefinition` and invoking `.run()` — this
 * branch dropped that dual class/`defineCommand` indirection everywhere
 * (see `target-*`/`index-*` PROGRESS.md notes), so the sub-step call
 * goes straight to the underlying function instead.
 * @param ctx CLI context.
 * @param cwd Current working directory.
 * @param opts Command options.
 * @param outFile Output file path.
 */
export async function generateBundleManifest(
  ctx: Context,
  cwd: string,
  opts: BundleManifestOptions,
  outFile: string
): Promise<void> {
  const collectionFile = await resolveCollectionFile(ctx, cwd, opts.collectionFile);
  const collectionAbs = path.isAbsolute(collectionFile)
    ? collectionFile
    : path.join(cwd, collectionFile);
  const collection = yaml.load(await ctx.fs.readFile(collectionAbs)) as RawCollection;
  const items = Array.isArray(collection.items) ? collection.items : [];
  const prompts = await processCollectionItems(items, collection, ctx, cwd);

  await writeManifestFile(collection, prompts, opts.version, outFile, ctx);
  const data = buildManifestData(collection, prompts, opts.version, outFile);
  formatOutput({
    ctx,
    command: 'bundle.manifest',
    output: opts.output ?? 'text',
    status: 'ok',
    data,
    textRenderer: renderText
  });
}

/**
 * Bundle manifest command class.
 */
export class BundleManifestCommand extends Command {
  public static readonly paths = [['bundle', 'manifest']];

  public static readonly usage = Command.Usage({
    description: 'Generate a deployment-manifest.yml from a collection.yml.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub bundle manifest [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --version <version>         Bundle version (e.g. 1.0.0)
        --collection-file <path>    Collection file path (repo-relative)
        --out-file <path>          Output file path (default: deployment-manifest.yml)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public version = Option.String('--version');
  public collectionFile = Option.String('--collection-file');
  public outFile = Option.String('--out-file');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const version = this.version ?? '';
    const collectionFile = this.collectionFile;
    const cwd = ctx.cwd();
    const outFileRel = this.outFile ?? 'deployment-manifest.yml';
    // Resolve against ctx.cwd() (not process.cwd()) so the command
    // honors injected working directories (Context invariant — see
    // bundle-build.ts's outDir resolution for the same pattern).
    const outFile = path.isAbsolute(outFileRel) ? outFileRel : path.join(cwd, outFileRel);
    try {
      await generateBundleManifest(ctx, cwd, { version, collectionFile, output: fmt }, outFile);
      return 0;
    } catch (err) {
      const re = err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'INTERNAL.UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
          cause: err
        });
      emitError(ctx, fmt, re);
      return 1;
    }
  }
}
