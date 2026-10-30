/** Thin CLI delivery for the shared scoped Hub use case. */
import * as path from 'node:path';
import {
  renderGovernanceMarkdown,
  runHubScopedGovernance,
  type SourceAdapterFactoryDeps,
} from '@ai-primitives-hub/app';
import {
  NodeArgvProcessRunner,
} from '@ai-primitives-hub/infra';
import {
  type Context,
  formatOutput,
  type OutputFormat,
} from '../framework';
import type {
  ValidationGovernanceOptions,
} from './validation-governance';

interface ScopedOptions extends ValidationGovernanceOptions {
  config?: string;
  baseRef?: string;
  headRef?: string;
  scopeFile?: string;
  checkSources: boolean;
  verbose?: boolean;
}
/**
 * Delegate scoped validation and render the versioned scope beside the standard report.
 * @param ctx
 * @param options
 * @param output
 * @param sourceAdapterDeps
 */
export async function executeHubScopedGovernance(ctx: Context, options: ScopedOptions, output: OutputFormat, sourceAdapterDeps: SourceAdapterFactoryDeps): Promise<number> {
  if (!['json', 'yaml', 'ndjson', 'text'].includes(output)) {
    ctx.stderr.write('Unsupported output format. Use json, yaml, ndjson, or text.\n');
    return 1;
  }
  const report = await runHubScopedGovernance(ctx.fs, {
    ...options, repoRoot: ctx.cwd(), processRunner: new NodeArgvProcessRunner(), sourceAdapterDeps,
    onProgress: options.verbose ? (event) => ctx.stderr.write(`[scoped validation] ${JSON.stringify(event)}\n`) : undefined,
    onInventoryProgress: options.verbose ? (event) => ctx.stderr.write(`[governance source] ${JSON.stringify(event)}\n`) : undefined,
    minScore: options.minScore === undefined ? undefined : (options.minScore.trim() === '' ? Number.NaN : Number(options.minScore))
  });
  // The report renders the PR scope itself, as a readable list.
  const markdown = renderGovernanceMarkdown(report);
  let writeFailed = false;
  if (options.reportPath !== undefined) {
    try {
      await ctx.fs.writeFile(path.resolve(ctx.cwd(), options.reportPath), markdown);
    } catch {
      ctx.stderr.write('Unable to write scoped governance report.\n');
      writeFailed = true;
    }
  }
  formatOutput({ ctx, command: 'hub.validate', output, status: report.verdict === 'fail' || writeFailed ? 'error' : 'ok', data: report, textRenderer: () => markdown });
  return report.verdict === 'pass' && !writeFailed ? 0 : 1;
}
