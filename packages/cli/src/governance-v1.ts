/** Additive, versioned governance entry point; the existing executable is unchanged. */
import * as path from 'node:path';
import {
  renderGovernanceMarkdownV1,
} from '@ai-primitives-hub/app/dist/governance/report-v1';
import {
  runGovernanceV1,
} from '@ai-primitives-hub/app/dist/governance/run-governance-v1';
import type {
  GovernanceSubjectV1,
} from '@ai-primitives-hub/core/dist/domain/governance/governance-v1';
import {
  Command,
  type Context,
  createProductionContext,
  formatOutput,
  Option,
  type OutputFormat,
  runCli,
} from './framework';

class GovernanceValidateCommandV1 extends Command {
  public static readonly paths = [['hub', 'validate'], ['collection', 'validate'], ['skill', 'validate']];
  public output = Option.String('-o,--output', 'json');
  public config = Option.String('--config');
  public policy = Option.String('--policy');
  public minScore = Option.String('--min-score');
  public reportPath = Option.String('--report-path');
  public collectionFile = Option.Array('--collection-file');
  public skillsDir = Option.String('--skills-dir');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    if (!['json', 'yaml', 'ndjson', 'text'].includes(this.output)) {
      ctx.stderr.write('Unsupported output format. Use json, yaml, ndjson, or text.\n');
      return 1;
    }
    const subject = this.path[0] as GovernanceSubjectV1;
    const report = await runGovernanceV1(ctx.fs, {
      subject,
      repoRoot: ctx.cwd(),
      config: this.config,
      policy: this.policy,
      minScore: this.minScore === undefined ? undefined : (this.minScore.trim() === '' ? Number.NaN : Number(this.minScore)),
      collectionFiles: this.collectionFile,
      skillsDir: this.skillsDir
    });
    const markdown = renderGovernanceMarkdownV1(report);
    let reportWriteFailed = false;
    if (this.reportPath !== undefined) {
      try {
        await ctx.fs.writeFile(path.resolve(ctx.cwd(), this.reportPath), markdown);
      } catch (error) {
        ctx.stderr.write(`Unable to write governance report: ${error instanceof Error ? error.message : String(error)}\n`);
        reportWriteFailed = true;
      }
    }
    formatOutput({
      ctx,
      command: `${subject}.validate`,
      output: this.output as OutputFormat,
      status: report.verdict === 'fail' || reportWriteFailed ? 'error' : 'ok',
      data: report,
      textRenderer: () => markdown
    });
    return report.verdict === 'pass' && !reportWriteFailed ? 0 : 1;
  }
}

/**
 * Run the additive governance CLI through the existing argument and IO framework.
 * @param args Command-line arguments without the executable name.
 * @param ctx Injected IO context, or the production context for the launcher.
 */
export async function runGovernanceCliV1(args: string[], ctx: Context = createProductionContext()): Promise<number> {
  return runCli(args, {
    ctx,
    commands: [],
    commandClasses: [GovernanceValidateCommandV1],
    name: 'ai-primitives-hub-governance-v1',
    version: '1',
    defaultOutput: 'json'
  });
}
