/** Thin delivery helper shared by the existing validation commands. */
import * as path from 'node:path';
import {
  type GovernanceRequest,
  renderGovernanceMarkdown,
  runGovernance,
} from '@ai-primitives-hub/app';
import {
  NodeArgvProcessRunner,
} from '@ai-primitives-hub/infra';
import {
  type Context,
  formatOutput,
  type OutputFormat,
} from '../framework';

export interface ValidationGovernanceOptions {
  governance: boolean;
  policy?: string;
  minScore?: string;
  reportPath?: string;
  additionalReportPaths?: string[];
  /** Repository root to validate; defaults to the current directory. */
  root?: string;
  /** PR mode: exact base and head commits. Only what the PR changed is validated. */
  baseRef?: string;
  headRef?: string;
}

/**
 * Determine whether the caller opted into the governance gate.
 * @param options
 */
export function isGovernanceRequested(options: ValidationGovernanceOptions): boolean {
  return options.governance || options.policy !== undefined || options.minScore !== undefined || options.reportPath !== undefined
    || options.baseRef !== undefined || options.headRef !== undefined;
}

/**
 * Delegate validation and policy to app; format output through the existing CLI framework.
 * @param ctx
 * @param request
 * @param options
 * @param output
 */
export async function executeValidationGovernance(
  ctx: Context,
  request: Omit<GovernanceRequest, 'repoRoot' | 'policy' | 'minScore'>,
  options: ValidationGovernanceOptions,
  output: OutputFormat
): Promise<number> {
  if (!['json', 'yaml', 'ndjson', 'text'].includes(output)) {
    ctx.stderr.write('Unsupported output format. Use json, yaml, ndjson, or text.\n');
    return 1;
  }
  const prMode = options.baseRef !== undefined || options.headRef !== undefined;
  const report = await runGovernance(ctx.fs, {
    ...request,
    repoRoot: options.root === undefined ? ctx.cwd() : path.resolve(ctx.cwd(), options.root),
    baseRef: options.baseRef,
    headRef: options.headRef,
    processRunner: prMode ? new NodeArgvProcessRunner() : undefined,
    policy: options.policy,
    minScore: options.minScore === undefined ? undefined : (options.minScore.trim() === '' ? Number.NaN : Number(options.minScore))
  });
  const markdown = renderGovernanceMarkdown(report);
  let writeFailed = false;
  const reportPaths = new Set([options.reportPath, ...(options.additionalReportPaths ?? [])].filter((file): file is string => file !== undefined));
  for (const reportPath of reportPaths) {
    try {
      await ctx.fs.writeFile(path.resolve(ctx.cwd(), reportPath), markdown);
    } catch (error) {
      ctx.stderr.write(`Unable to write governance report: ${error instanceof Error ? error.message : String(error)}\n`);
      writeFailed = true;
    }
  }
  formatOutput({
    ctx, command: `${request.subject}.validate`, output,
    status: report.verdict === 'fail' || writeFailed ? 'error' : (report.findings.length > 0 ? 'warning' : 'ok'),
    data: report,
    textRenderer: () => markdown
  });
  return report.verdict === 'pass' && !writeFailed ? 0 : 1;
}
