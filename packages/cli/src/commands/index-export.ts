/**
 * `prompt-registry index export` — export a shortlist as a hub
 * profile YAML (and optionally a suggested collection YAML).
 *
 * Replaces the legacy `primitive-index export` verb. Output goes
 * through `formatOutput` so JSON callers get the canonical envelope
 * with `profileFile` and (when `--suggest-collection`) `collectionFile`
 * paths.
 * @module cli/commands/index-export
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  exportShortlistAsProfile,
} from '@prompt-registry/app';
import {
  defaultIndexFile,
  loadIndex,
} from '@prompt-registry/infra';
import {
  dump as toYaml,
} from 'js-yaml';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

export interface IndexExportOptions {
  output?: OutputFormat;
  /** Path to the index JSON. */
  indexFile?: string;
  /** Shortlist id to export. Required. */
  shortlistId: string;
  /** Target profile id. Required. */
  profileId: string;
  /** Output directory. Defaults to ".". */
  outDir?: string;
  /** Profile name override. */
  profileName?: string;
  /** Profile description override. */
  description?: string;
  /** Profile icon override. */
  icon?: string;
  /** Also emit a curated collection YAML for loose primitives. */
  suggestCollection?: boolean;
}

interface ExportResult {
  profileFile: string;
  collectionFile?: string;
  warnings: string[];
}

/**
 * Build the `index export` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexExportCommand = (
  opts: IndexExportOptions
): CommandDefinition =>
  defineCommand({
    path: ['index', 'export'],
    description: 'Export a shortlist as a hub profile YAML.',
    category: 'Index & Search',
    run: ({ ctx }: { ctx: Context }): number | Promise<number> => {
      const fmt = opts.output ?? 'text';
      if (opts.shortlistId.length === 0) {
        return failWith(ctx, fmt, 'index.export', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index export: --shortlist <SHORTLIST_ID> is required'
        }));
      }
      if (opts.profileId.length === 0) {
        return failWith(ctx, fmt, 'index.export', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index export: --profile-id <ID> is required'
        }));
      }
      const indexPath = opts.indexFile ?? defaultIndexFile(ctx.env);
      try {
        const idx = loadIndex(indexPath);
        const sl = idx.getShortlist(opts.shortlistId);
        if (sl === undefined) {
          return failWith(ctx, fmt, 'index.export', new RegistryError({
            code: 'INDEX.SHORTLIST_NOT_FOUND',
            message: `index export: unknown shortlist "${opts.shortlistId}"`
          }));
        }
        const result = exportShortlistAsProfile(idx, sl, {
          profileId: opts.profileId,
          profileName: opts.profileName,
          description: opts.description,
          icon: opts.icon,
          suggestCollection: opts.suggestCollection
        });
        const outDir = opts.outDir ?? '.';
        fs.mkdirSync(outDir, { recursive: true });
        const profileFile = path.join(outDir, `${opts.profileId}.profile.yml`);
        fs.writeFileSync(profileFile, toYaml(result.profile), 'utf8');
        const data: ExportResult = {
          profileFile,
          warnings: result.warnings
        };
        if (result.suggestedCollection !== undefined) {
          const collectionFile = path.join(outDir, `${result.suggestedCollection.id}.collection.yml`);
          fs.writeFileSync(collectionFile, toYaml(result.suggestedCollection), 'utf8');
          data.collectionFile = collectionFile;
        }
        formatOutput({
          ctx, command: 'index.export', output: fmt, status: 'ok',
          data,
          warnings: result.warnings,
          textRenderer: (d) =>
            `wrote ${d.profileFile}`
            + (d.collectionFile === undefined ? '' : `\nwrote ${d.collectionFile}`)
            + '\n'
        });
        return Promise.resolve(0);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const err = /ENOENT|no such file/i.test(msg)
          ? new RegistryError({
            code: 'INDEX.NOT_FOUND',
            message: `index not found: ${indexPath}`,
            hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
            cause: cause instanceof Error ? cause : undefined
          })
          : new RegistryError({
            code: 'INDEX.EXPORT_FAILED',
            message: `index export failed: ${msg}`,
            cause: cause instanceof Error ? cause : undefined
          });
        return failWith(ctx, fmt, 'index.export', err);
      }
    }
  });

const buildIndexExportError = (cause: unknown, indexPath: string): RegistryError => {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return /ENOENT|no such file/i.test(msg)
    ? new RegistryError({
      code: 'INDEX.NOT_FOUND',
      message: `index not found: ${indexPath}`,
      hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
      cause: cause instanceof Error ? cause : undefined
    })
    : new RegistryError({
      code: 'INDEX.EXPORT_FAILED',
      message: `index export failed: ${msg}`,
      hint: 'Please check the error message and try again.',
      cause: cause instanceof Error ? cause : undefined
    });
};

/**
 * Index export command class.
 * Exports a shortlist as a hub profile YAML.
 */
export class IndexExportCommand extends Command {
  public static readonly paths = [['index', 'export']];

  public static readonly usage = Command.Usage({
    description: 'Export a shortlist as a hub profile YAML.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index export --shortlist <SHORTLIST_ID> --profile-id <ID> [options]

      Examples:
        prompt-registry index export --shortlist my-list --profile-id custom-profile
        prompt-registry index export --shortlist my-list --profile-id custom-profile --out-dir ./exports
        prompt-registry index export --shortlist my-list --profile-id custom-profile --suggest-collection
    `
  });

  public shortlist = Option.String('--shortlist');
  public profileId = Option.String('--profile-id');
  public outDir = Option.String('--out-dir');
  public profileName = Option.String('--profile-name');
  public description = Option.String('--description');
  public icon = Option.String('--icon');
  public suggestCollection = Option.Boolean('--suggest-collection');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;

    if (!this.shortlist || this.shortlist.length === 0) {
      return failWith(ctx, fmt, 'index.export', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index export: --shortlist <SHORTLIST_ID> is required'
      }));
    }
    if (!this.profileId || this.profileId.length === 0) {
      return failWith(ctx, fmt, 'index.export', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index export: --profile-id <ID> is required'
      }));
    }

    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    try {
      const idx = loadIndex(indexPath);
      const sl = idx.getShortlist(this.shortlist);
      if (sl === undefined) {
        return failWith(ctx, fmt, 'index.export', new RegistryError({
          code: 'INDEX.SHORTLIST_NOT_FOUND',
          message: `index export: unknown shortlist "${this.shortlist}"`
        }));
      }
      const result = exportShortlistAsProfile(idx, sl, {
        profileId: this.profileId,
        profileName: this.profileName,
        description: this.description,
        icon: this.icon,
        suggestCollection: this.suggestCollection
      });
      const outDir = this.outDir ?? '.';
      fs.mkdirSync(outDir, { recursive: true });
      const profileFile = path.join(outDir, `${this.profileId}.profile.yml`);
      fs.writeFileSync(profileFile, toYaml(result.profile), 'utf8');
      const data: ExportResult = {
        profileFile,
        warnings: result.warnings
      };
      if (result.suggestedCollection !== undefined) {
        const collectionFile = path.join(outDir, `${result.suggestedCollection.id}.collection.yml`);
        fs.writeFileSync(collectionFile, toYaml(result.suggestedCollection), 'utf8');
        data.collectionFile = collectionFile;
      }
      formatOutput({
        ctx, command: 'index.export', output: fmt, status: 'ok',
        data,
        warnings: result.warnings,
        textRenderer: (d) =>
          `wrote ${d.profileFile}`
          + (d.collectionFile === undefined ? '' : `\nwrote ${d.collectionFile}`)
          + '\n'
      });
      return 0;
    } catch (cause) {
      return failWith(ctx, fmt, 'index.export', buildIndexExportError(cause, indexPath));
    }
  }
}
