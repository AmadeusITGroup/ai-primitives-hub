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
  createCollectionReleaseLookup,
  generateMarkdown,
  listCollectionFiles,
  validateAllCollections,
} from '@ai-primitives-hub/app';
import type {
  AllCollectionsResult,
  HttpClient,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  defaultTokenProvider,
  NodeHttpClient,
  NodeProcessRunner,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';
import {
  executeValidationGovernance,
  isGovernanceRequested,
} from './validation-governance';

/**
 * Validation data.
 */
interface ValidateData {
  ok: boolean;
  totalFiles: number;
  fileResults: AllCollectionsResult['fileResults'];
  errors: string[];
  warnings: string[];
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
        --governance               Enable governance verdict and scoring
        --policy <path>            Apply governance policy (enables governance)
        --min-score <number>       Enforce a 0-100 score floor (enables governance)
        --report-path <path>       Write provider report (enables governance)
        --check-releases           Verify published releases (enables governance/network)
        --repository <owner/repo>  Repository for release verification
        --collection-file <path>    Collection file path (can be repeated)
        --root <dir>                Repository root to validate (default: current directory)
        --base-ref <commit>         PR mode: exact base commit (with --head-ref; enables governance)
        --head-ref <commit>         PR mode: exact head commit; only collections the PR touched are validated
        --verbose                   Print each ok file in text mode
    `
  });

  public output = Option.String('-o,--output');
  public markdownPath = Option.String('--markdown-path');
  public governance = Option.Boolean('--governance', false);
  public policy = Option.String('--policy');
  public minScore = Option.String('--min-score');
  public reportPath = Option.String('--report-path');
  public checkReleases = Option.Boolean('--check-releases', false);
  public repository = Option.String('--repository');
  public collectionFile = Option.Array('--collection-file');
  public root = Option.String('--root');
  public baseRef = Option.String('--base-ref');
  public headRef = Option.String('--head-ref');
  public verbose = Option.Boolean('--verbose', false);
  public commandContext!: { ctx: Context; http?: HttpClient; tokens?: TokenProvider };

  public async execute(): Promise<number> {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    if (isGovernanceRequested(this) || this.checkReleases) {
      const releaseLookup = this.checkReleases && this.repository !== undefined
        ? createCollectionReleaseLookup(this.repository, {
          fs: ctx.fs, clock: ctx.clock, httpClient: http ?? new NodeHttpClient(), processRunner: new NodeProcessRunner(),
          fallbackTokenProviders: tokens === undefined ? [defaultTokenProvider(ctx.env)] : [tokens]
        })
        : undefined;
      return executeValidationGovernance(ctx, {
        subject: 'collection', collectionFiles: this.collectionFile, checkReleases: this.checkReleases, repository: this.repository, releaseLookup
      },
      { ...this, additionalReportPaths: this.markdownPath === undefined ? [] : [this.markdownPath] }, fmt);
    }
    const cwd = this.root === undefined ? ctx.cwd() : path.resolve(ctx.cwd(), this.root);
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
    const warnings = result.warnings;
    const data: ValidateData = {
      ok: result.ok,
      totalFiles: files.length,
      fileResults: result.fileResults,
      errors: result.errors,
      warnings
    };

    if (this.markdownPath !== undefined) {
      const md = generateMarkdown(result, files.length);
      // Relative to the command's working directory, like --report-path, not the process cwd.
      await ctx.fs.writeFile(path.resolve(ctx.cwd(), this.markdownPath), md);
    }

    formatOutput({
      ctx,
      command: 'collection.validate',
      output: fmt,
      status: result.ok ? (warnings.length > 0 ? 'warning' : 'ok') : 'error',
      data,
      warnings,
      textRenderer: (d) => renderText(d, this.verbose)
    });
    return result.ok ? 0 : 1;
  }
}
