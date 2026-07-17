/**
 * `collection validate` subcommand.
 *
 * Wraps `@ai-primitives-hub/app`'s `validateAllCollections()`/
 * `generateMarkdown()` (ported from the reference branch's
 * `lib/src/validate.ts`) so the validator's behavior stays verbatim.
 *
 * - Goes through `Context` for the existence check + the markdown
 *   write (`ctx.fs.exists`, `ctx.fs.writeFile`).
 * - Output formatter routes via text/json/yaml/ndjson.
 * - Missing `collections/` dir fails with a `FS.NOT_FOUND`
 *   `RegistryError` (renderError -> stderr in text mode; envelope
 *   error in JSON mode).
 * @module commands/collection-validate
 */
import * as path from 'node:path';
import {
  generateMarkdown,
  listCollectionFiles,
  validateAllCollections,
} from '@ai-primitives-hub/app';
import type {
  AllCollectionsResult,
} from '@ai-primitives-hub/core';
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
 * Validation data.
 */
interface ValidateData {
  ok: boolean;
  totalFiles: number;
  fileResults: AllCollectionsResult['fileResults'];
  errors: string[];
}

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

/**
 * Collection validate command class.
 */
export class CollectionValidateCommand extends Command {
  public static readonly paths = [['collection', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate `*.collection.yml` files against the schema.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub collection validate [options]

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
  public commandContext!: { ctx: Context };

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
