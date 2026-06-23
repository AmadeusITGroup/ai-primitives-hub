/**
 * `bundle manifest` subcommand.
 *
 * Replaces `lib/bin/generate-manifest.js`. Reads a collection YAML
 * file plus the referenced primitive files, then writes a deployment
 * manifest YAML to `outFile`.
 *
 * The legacy script accepts a positional version arg. We surface
 * `version` as an option on the factory; a later iteration wires it to a
 * clipanion positional.
 */
import * as path from 'node:path';
import {
  normalizeRepoRelativePath,
} from '@prompt-registry/core';
import * as yaml from 'js-yaml';
import {
  Command,
  copyCommandPrototype,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
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
 * Options for bundle manifest command.
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
  /** Output deployment manifest path. Default 'deployment-manifest.yml'. */
  outFile?: string;
}

/**
 * Command context for bundle manifest command.
 */
interface BundleManifestContext {
  ctx: Context;
}

/**
 * Base class for bundle manifest command.
 */
abstract class BaseBundleManifestCommand extends Command {
  public commandContext: BundleManifestContext = { ctx: null as any };
}

/**
 * Native clipanion class command for bundle manifest.
 */
export class BundleManifestCommand extends BaseBundleManifestCommand {
  public static readonly paths = [['bundle', 'manifest']];

  public static readonly usage = Command.Usage({
    description: 'Generate a deployment-manifest.yml from a collection.yml.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry bundle manifest [options]

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

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const version = this.version ?? '';
    const collectionFile = this.collectionFile;
    const outFile = this.outFile ?? 'deployment-manifest.yml';
    const cwd = ctx.cwd();
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

/**
 * Create a CommandDefinition wrapper for the bundle manifest command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultVersion Default version (optional).
 * @param defaultCollectionFile Default collection file (optional).
 * @param defaultOutFile Default output file (optional).
 * @returns CommandClass.
 */
const createBundleManifestCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultVersion?: string,
  defaultCollectionFile?: string,
  defaultOutFile?: string
): typeof BundleManifestCommand => {
  class ConfiguredCommand extends BundleManifestCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultVersion !== undefined && !this.version) {
        this.version = defaultVersion;
      }
      if (defaultCollectionFile !== undefined && !this.collectionFile) {
        this.collectionFile = defaultCollectionFile;
      }
      if (defaultOutFile !== undefined && !this.outFile) {
        this.outFile = defaultOutFile;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(BundleManifestCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured bundle manifest command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultVersion Default version (optional).
 * @param defaultCollectionFile Default collection file (optional).
 * @param defaultOutFile Default output file (optional).
 * @returns CommandClass.
 */
export const createBundleManifestCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultVersion?: string,
  defaultCollectionFile?: string,
  defaultOutFile?: string
): typeof BundleManifestCommand => {
  return createBundleManifestCommandDefinition(ctx, defaultOutput, defaultVersion, defaultCollectionFile, defaultOutFile);
};

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
): { id: string; name: string; description: string; file: string; type: string; tags: string[] } {
  const { name, description } = extractItemMetadataByPath(itemContent, itemPath);
  const itemId = generateItemId(itemPath, item.kind || '');
  const tags = Array.isArray(collection.tags) ? [...collection.tags] : [];
  const type = KIND_TO_TYPE_MAP[item.kind || ''] ?? item.kind;
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
): Promise<{ id: string; name: string; description: string; file: string; type: string; tags: string[] }[]> {
  const prompts: { id: string; name: string; description: string; file: string; type: string; tags: string[] }[] = [];
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
  prompts: { id: string; name: string; description: string; file: string; type: string; tags: string[] }[],
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
  prompts: { id: string; name: string; description: string; file: string; type: string; tags: string[] }[],
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
  prompts: { id: string; name: string; description: string; file: string; type: string; tags: string[] }[],
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
 * Build the `bundle manifest` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createBundleManifestCommand = (
  opts: BundleManifestOptions
): CommandDefinition =>
  defineCommand({
    path: ['bundle', 'manifest'],
    description: 'Generate a deployment-manifest.yml from a collection.yml.',
    category: 'Build & Author',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const cwd = ctx.cwd();
      const outFile = opts.outFile ?? 'deployment-manifest.yml';
      try {
        await generateBundleManifest(ctx, cwd, opts, outFile);
        return 0;
      } catch (err) {
        const re = err instanceof RegistryError
          ? err
          : new RegistryError({
            code: 'INTERNAL.UNEXPECTED',
            message: err instanceof Error ? err.message : String(err),
            cause: err
          });
        emitError(ctx, opts.output ?? 'text', re);
        return 1;
      }
    }
  });

/**
 * Generate bundle manifest from collection.
 * @param ctx CLI context.
 * @param cwd Current working directory.
 * @param opts Command options.
 * @param outFile Output file path.
 */
async function generateBundleManifest(
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
    // (regression test in lib/test/generate-manifest.test.ts asserts
    // the exact substring `MCP Servers: <n>` to keep CI logs stable).
    lines.push(`  MCP Servers: ${d.mcpServerCount}`);
  }
  return `${lines.join('\n')}\n`;
};
