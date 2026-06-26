/**
 * `collection validate` subcommand.
 *
 * Replaces `lib/bin/validate-collections.js`. Wraps the existing
 * `validateAllCollections()` and `generateMarkdown()` helpers from
 * `lib/src/validate.ts` so we keep the validator's behavior verbatim.
 *
 * Improvements over the legacy script:
 *
 * - Goes through `Context` for the existence check + the markdown
 *   write (`ctx.fs.exists`, `ctx.fs.writeFile`).
 * - Output formatter routes via text/json/yaml/ndjson; legacy was a
 *   bespoke mix of `console.log` and `console.error`.
 * - Missing `collections/` dir fails with a `FS.NOT_FOUND`
 *   `RegistryError` (renderError → stderr in text mode; envelope
 *   error in JSON mode).
 *
 * The `validateAllCollections()` helper still uses synchronous
 * `node:fs` internally because it reads YAML files. Wrapping it in
 * `Context` would touch `lib/src/validate.ts` — an audit
 * said feature-layer IO stays in feature layers. Future iterations
 * will revisit if needed.
 */
import * as path from 'node:path';
import {
  listCollectionFiles,
} from '../collections';
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
import {
  type AllCollectionsResult,
} from '../types';
import {
  generateMarkdown,
  validateAllCollections,
} from '../validate';

/**
 * Validation data.
 */
interface ValidateData {
  ok: boolean;
  totalFiles: number;
  fileResults: AllCollectionsResult['fileResults'];
  errors: string[];
}

/**
 * Options for collection validate command.
 */
export interface CollectionValidateOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /**
   * Optional path to write a PR-comment-style markdown report to.
   * Mirrors the legacy `--output-markdown` flag.
   */
  markdownPath?: string;
  /**
   * Optional explicit list of collection files (repo-relative). When
   * unset, the command lists everything under `<cwd>/collections/`.
   */
  collectionFiles?: string[];
  /** Verbose mode prints each ok file in text mode (legacy behavior). */
  verbose?: boolean;
}

/**
 * Command context for collection validate command.
 */
interface CollectionValidateContext {
  ctx: Context;
}

/**
 * Base class for collection validate command.
 */
abstract class BaseCollectionValidateCommand extends Command {
  public commandContext: CollectionValidateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for collection validate.
 */
export class CollectionValidateCommand extends BaseCollectionValidateCommand {
  public static readonly paths = [['collection', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate `*.collection.yml` files against the schema.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry collection validate [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --markdown-path <path>     Write markdown report to file
        --collection-file <path>    Collection file path (can be repeated)
        --verbose                   Print each ok file in text mode
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public markdownPath = Option.String('--markdown-path');
  public collectionFile = Option.Array('--collection-file');
  public verbose = Option.Boolean('--verbose', false);

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const collectionsDir = path.join(cwd, 'collections');
    if (!(await ctx.fs.exists(collectionsDir))) {
      const err = new RegistryError({
        code: 'FS.NOT_FOUND',
        message: `collections/ directory not found under ${cwd}`,
        hint: 'Run from a repo root that contains a `collections/` folder.',
        context: { collectionsDir }
      });
      emitError(ctx, fmt, err);
      return 1;
    }

    const files = this.collectionFile && this.collectionFile.length > 0
      ? this.collectionFile
      : listCollectionFiles(cwd);
    const result = validateAllCollections(cwd, files);
    const data: ValidateData = {
      ok: result.ok,
      totalFiles: files.length,
      fileResults: result.fileResults,
      errors: result.errors
    };

    if (this.markdownPath !== undefined) {
      const md = generateMarkdown(result, files.length);
      await ctx.fs.writeFile(this.markdownPath, md);
    }

    formatOutput({
      ctx,
      command: 'collection.validate',
      output: fmt,
      status: result.ok ? 'ok' : 'error',
      data,
      textRenderer: (d) => renderText(d, this.verbose)
    });
    return result.ok ? 0 : 1;
  }
}

/**
 * Create a CommandDefinition wrapper for the collection validate command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultMarkdownPath Default markdown path (optional).
 * @param defaultCollectionFiles Default collection files (optional).
 * @param defaultVerbose Default verbose flag (optional).
 * @returns CommandClass.
 */
const createCollectionValidateCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultMarkdownPath?: string,
  defaultCollectionFiles?: string[],
  defaultVerbose?: boolean
): typeof CollectionValidateCommand => {
  class ConfiguredCommand extends CollectionValidateCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultMarkdownPath !== undefined && !this.markdownPath) {
        this.markdownPath = defaultMarkdownPath;
      }
      if (defaultCollectionFiles !== undefined && (!this.collectionFile || this.collectionFile.length === 0)) {
        this.collectionFile = defaultCollectionFiles;
      }
      if (defaultVerbose !== undefined && !this.verbose) {
        this.verbose = defaultVerbose;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(CollectionValidateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured collection validate command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultMarkdownPath Default markdown path (optional).
 * @param defaultCollectionFiles Default collection files (optional).
 * @param defaultVerbose Default verbose flag (optional).
 * @returns CommandClass.
 */
export const createCollectionValidateCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultMarkdownPath?: string,
  defaultCollectionFiles?: string[],
  defaultVerbose?: boolean
): typeof CollectionValidateCommand => {
  return createCollectionValidateCommandDefinition(ctx, defaultOutput, defaultMarkdownPath, defaultCollectionFiles, defaultVerbose);
};

/**
 * Build the `collection validate` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createCollectionValidateCommand = (
  opts: CollectionValidateOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['collection', 'validate'],
    description: 'Validate `*.collection.yml` files against the schema.',
    category: 'Build & Author',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const cwd = ctx.cwd();
      const collectionsDir = path.join(cwd, 'collections');
      if (!(await ctx.fs.exists(collectionsDir))) {
        const err = new RegistryError({
          code: 'FS.NOT_FOUND',
          message: `collections/ directory not found under ${cwd}`,
          hint: 'Run from a repo root that contains a `collections/` folder.',
          context: { collectionsDir }
        });
        emitError(ctx, opts.output ?? 'text', err);
        return 1;
      }

      const files = opts.collectionFiles && opts.collectionFiles.length > 0
        ? opts.collectionFiles
        : listCollectionFiles(cwd);
      const result = validateAllCollections(cwd, files);
      const data: ValidateData = {
        ok: result.ok,
        totalFiles: files.length,
        fileResults: result.fileResults,
        errors: result.errors
      };

      if (opts.markdownPath !== undefined) {
        const md = generateMarkdown(result, files.length);
        await ctx.fs.writeFile(opts.markdownPath, md);
      }

      formatOutput({
        ctx,
        command: 'collection.validate',
        output: opts.output ?? 'text',
        status: result.ok ? 'ok' : 'error',
        data,
        textRenderer: (d) => renderText(d, opts.verbose ?? false)
      });
      return result.ok ? 0 : 1;
    }
  });

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
      command: 'collection.validate',
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
 * Render validation results as text.
 * @param d Validation data.
 * @param verbose Verbose flag.
 * @returns Formatted text output.
 */
const renderText = (d: ValidateData, verbose: boolean): string => {
  const lines: string[] = [`Found ${d.totalFiles} collection(s)`];
  for (const fileResult of d.fileResults) {
    if (!fileResult.ok) {
      lines.push(`[FAIL] ${fileResult.file}: invalid`);
      for (const e of fileResult.errors) {
        lines.push(`  - ${e}`);
      }
    } else if (verbose) {
      lines.push(`[ OK ] ${fileResult.file}: valid`);
    }
  }
  const crossCollectionErrors = d.errors.filter((e) => e.includes('Duplicate collection'));
  if (crossCollectionErrors.length > 0) {
    lines.push('', 'Cross-collection errors:');
    for (const e of crossCollectionErrors) {
      lines.push(`  - ${e}`);
    }
  }
  if (d.ok) {
    lines.push('', `All ${d.totalFiles} collection(s) valid`);
  } else {
    lines.push('', `Validation failed with ${d.errors.length} error(s)`);
  }
  return `${lines.join('\n')}\n`;
};
