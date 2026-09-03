/** Export an AI Primitives Hub collection as a Microsoft 365 declarative agent. */
import {
  createReadStream,
  createWriteStream,
  readFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  readCollection,
} from '@ai-primitives-hub/app';
import type {
  Collection,
} from '@ai-primitives-hub/core';
import {
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';
import {
  resolveCollectionFile,
} from './bundle-manifest';

const APP_SCHEMA = 'https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json';
const AGENT_SCHEMA = 'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.8/schema.json';
const FIXED_DATE = new Date('1980-01-01T00:00:00.000Z');

interface ExportOptions {
  appId: string;
  version: string;
  developerName: string;
  websiteUrl: string;
  privacyUrl: string;
  termsUrl: string;
}

interface ExportedManifests {
  appManifest: Record<string, unknown>;
  agentManifest: Record<string, unknown>;
  warnings: string[];
}

const truncate = (value: string, limit: number): string => value.slice(0, limit);

/**
 * Convert compatible collection fields into Microsoft 365 manifest objects.
 * @param collection Source collection.
 * @param repoRoot Repository root containing item paths.
 * @param options Required publisher and package identifiers.
 * @returns Manifest objects and explicit conversion warnings.
 */
export function createM365Manifests(
  collection: Collection,
  repoRoot: string,
  options: ExportOptions
): ExportedManifests {
  const warnings: string[] = [];
  const instructionItems = collection.items.filter((item) => ['instruction', 'agent'].includes(item.kind));
  const instructions = instructionItems
    .map((item) => readFileSync(path.join(repoRoot, normalizeRepoRelativePath(item.path)), 'utf8').trim())
    .filter((content) => content.length > 0)
    .join('\n\n---\n\n') || collection.description || `Help users with ${collection.name}.`;
  if (instructions.length > 8000) {
    throw new RegistryError({
      code: 'BUNDLE.INVALID_MANIFEST',
      message: `Microsoft 365 instructions exceed the 8,000 character limit (${String(instructions.length)})`,
      hint: 'Shorten instruction and agent files or split this collection into multiple agents.'
    });
  }

  const promptItems = collection.items.filter((item) => item.kind === 'prompt' && item.description !== undefined);
  const starters = promptItems.slice(0, 12).map((item) => ({
    title: truncate(item.name ?? path.basename(item.path, path.extname(item.path)), 50),
    text: truncate(item.description as string, 128)
  }));
  if (starters.length < 3) {
    warnings.push('Store readiness: add descriptions to at least three prompt items for conversation starters.');
  }
  if (collection.items.some((item) => item.kind === 'skill')) {
    warnings.push('SKILL.md items are not embedded: Microsoft 365 skills require capabilities or MCP/API actions.');
  }
  if (collection.items.some((item) => ['mcp', 'plugin'].includes(item.kind))) {
    warnings.push('MCP/plugin items require a Microsoft 365 plugin manifest and authentication review; they were not exported.');
  }

  const name = truncate(collection.name, 100);
  const description = truncate(collection.description ?? `Microsoft 365 agent for ${collection.name}`, 1000);
  const agentManifest = {
    $schema: AGENT_SCHEMA,
    version: 'v1.8',
    name,
    description,
    instructions,
    ...(starters.length === 0 ? {} : { conversation_starters: starters })
  };
  const appManifest = {
    $schema: APP_SCHEMA,
    manifestVersion: '1.29',
    version: options.version,
    id: options.appId,
    developer: {
      name: options.developerName,
      websiteUrl: options.websiteUrl,
      privacyUrl: options.privacyUrl,
      termsOfUseUrl: options.termsUrl
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    name: { short: truncate(name, 30), full: name },
    description: { short: truncate(description, 80), full: description },
    accentColor: '#FFFFFF',
    copilotAgents: {
      declarativeAgents: [{ id: 'collectionAgent', file: 'declarativeAgent.json' }]
    },
    validDomains: []
  };
  return { appManifest, agentManifest, warnings };
}

function assertPngDimensions(filePath: string, width: number, height: number): void {
  const bytes = readFileSync(filePath);
  const pngSignature = '89504e470d0a1a0a';
  const valid = bytes.length >= 24
    && bytes.subarray(0, 8).toString('hex') === pngSignature
    && bytes.readUInt32BE(16) === width
    && bytes.readUInt32BE(20) === height;
  if (!valid) {
    throw new RegistryError({
      code: 'BUNDLE.INVALID_MANIFEST',
      message: `${filePath} must be a ${String(width)}x${String(height)} PNG`
    });
  }
}

function writePackage(
  zipPath: string,
  files: readonly { name: string; path?: string; content?: string }[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (file.path === undefined) {
        archive.append(file.content as string, { name: file.name, date: FIXED_DATE });
      } else {
        archive.append(createReadStream(file.path), { name: file.name, date: FIXED_DATE });
      }
    }
    archive.finalize().catch(reject);
  });
}

export class BundleExportM365Command extends Command {
  public static readonly paths = [['bundle', 'export-m365']];
  public static readonly usage = Command.Usage({
    description: 'Export a collection as a Microsoft 365 declarative-agent app package.',
    category: 'Build & Author',
    details: `
      Requires a stable Microsoft app ID, publisher URLs, and valid 192x192
      color and 32x32 outline PNG icons. Portable SKILL.md and MCP items are
      reported for explicit follow-up because they cannot be copied directly.
    `
  });

  public collectionFile = Option.String('--collection-file');
  public appId = Option.String('--app-id');
  public version = Option.String('--version', '1.0.0');
  public colorIcon = Option.String('--color-icon');
  public outlineIcon = Option.String('--outline-icon');
  public developerName = Option.String('--developer-name');
  public websiteUrl = Option.String('--website-url');
  public privacyUrl = Option.String('--privacy-url');
  public termsUrl = Option.String('--terms-url');
  public outDir = Option.String('--out-dir', 'dist/m365');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const required = [this.appId, this.colorIcon, this.outlineIcon, this.developerName,
      this.websiteUrl, this.privacyUrl, this.termsUrl];
    if (required.some((value) => value === undefined || value.length === 0)) {
      throw new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'export-m365 requires app id, publisher URLs, developer name, and both icon paths'
      });
    }
    const collectionFile = await resolveCollectionFile(ctx, ctx.cwd(), this.collectionFile);
    const collection = readCollection(ctx.cwd(), collectionFile);
    const colorPath = path.resolve(ctx.cwd(), this.colorIcon as string);
    const outlinePath = path.resolve(ctx.cwd(), this.outlineIcon as string);
    assertPngDimensions(colorPath, 192, 192);
    assertPngDimensions(outlinePath, 32, 32);
    const manifests = createM365Manifests(collection, ctx.cwd(), {
      appId: this.appId as string,
      version: this.version,
      developerName: this.developerName as string,
      websiteUrl: this.websiteUrl as string,
      privacyUrl: this.privacyUrl as string,
      termsUrl: this.termsUrl as string
    });
    const outDir = path.resolve(ctx.cwd(), this.outDir);
    await ctx.fs.mkdir(outDir, { recursive: true });
    const packagePath = path.join(outDir, `${collection.id}.m365.zip`);
    await writePackage(packagePath, [
      { name: 'color.png', path: colorPath },
      { name: 'declarativeAgent.json', content: `${JSON.stringify(manifests.agentManifest, null, 2)}\n` },
      { name: 'manifest.json', content: `${JSON.stringify(manifests.appManifest, null, 2)}\n` },
      { name: 'outline.png', path: outlinePath }
    ]);
    formatOutput({
      ctx,
      command: 'bundle.export-m365',
      output: this.output ?? 'text',
      status: 'ok',
      data: { packagePath, warnings: manifests.warnings },
      textRenderer: (data) => `Built ${data.packagePath}\n${data.warnings.join('\n')}\n`
    });
    return 0;
  }
}
