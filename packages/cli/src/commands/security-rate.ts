import * as path from 'node:path';
import {
  type QualityRatingResult,
  renderQualityMarkdown,
  runQualityRating,
} from '@ai-primitives-hub/app';
import {
  gateFailed,
  type QualityFailOn,
  RuleBasedSecurityScanEngine,
  type SecurityCancellation,
} from '@ai-primitives-hub/core';
import {
  IsolatedSecurityScanEngine,
  NodeSecurityScanInput,
  SecureAtomicSecurityReportStore,
  SECURITY_DEFAULT_LIMITS,
} from '@ai-primitives-hub/infra';
import {
  Command,
  Option,
} from 'clipanion';
import type {
  Context,
} from '../framework';
import {
  formatOutput,
} from '../framework';

const FAIL_ON_LEVELS = ['NONE', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const OUTPUT_FORMATS = ['text', 'json', 'yaml'];
const LISTED_FINDINGS = 3;

class StaticCancellation implements SecurityCancellation {
  public readonly cancelled = false;
  public throwIfCancelled(): void {
    return undefined;
  }
}

const textResult = (result: QualityRatingResult, failOn: QualityFailOn): string => {
  const { report } = result;
  const score = (value: number | null): string => (value === null ? 'n/a' : `${String(value)}/100`);
  const failedBundles = report.bundles.filter((bundle) => gateFailed(bundle.score, failOn));
  const gate = failOn === 'none'
    ? 'Gate (none): disabled'
    : `Gate (${failOn}): ${report.gate.passed ? 'passed' : `failed - ${String(failedBundles.length || 1)} below the limit`}`;
  const lines = [
    `Quality rating ${result.scan.complete ? 'complete' : 'incomplete'}`,
    `Source score: ${score(report.repo.score)} (${report.repo.risk}), ${report.repo.basis === 'bundles-average'
      ? `average of ${String(report.bundles.length)} bundle(s)`
      : 'whole repository'}`,
    gate,
    ...result.scan.errors.map((error) => `Error: ${error.code} - ${error.message}`),
    ...result.warnings.map((warning) => `Warning: ${warning}`)
  ];
  for (const bundle of report.bundles) {
    const failed = gateFailed(bundle.score, failOn);
    const { counts } = bundle;
    lines.push(`  ${failed ? 'FAIL' : 'ok  '}  ${bundle.id.padEnd(24)} ${score(bundle.score).padStart(7)}  ${bundle.risk.padEnd(8)}  `
      + `${String(counts.CRITICAL)}C ${String(counts.HIGH)}H ${String(counts.MEDIUM)}M ${String(counts.LOW)}L`);
    if (failed) {
      for (const finding of bundle.findings.slice(0, LISTED_FINDINGS)) {
        lines.push(`        [${finding.severity}] ${finding.ruleId} ${finding.file}:${String(finding.line)} - ${finding.title}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};

export class SecurityRateCommand extends Command {
  public static readonly paths = [['security', 'rate']];
  public static readonly usage = Command.Usage({
    description: 'Rate the collections or skills of a source checkout from a security scan.',
    category: 'Security',
    details: `
      Usage: ai-primitives-hub security rate [PATH]

      Scans PATH (default: the current directory), then scores each collection (or skill) from 0 to 100
      and the source as the average of its bundles. The report is the hub's quality-report.json.
      The gate fails when a bundle scores below the limit of --fail-on (CRITICAL by default, none to disable).
      Repository suppressions are ignored unless --ignore-trust says otherwise.
    `
  });

  public output = Option.String('-o,--output');
  public failOn = Option.String('--fail-on', 'CRITICAL');
  public repository = Option.String('--repository');
  public tag = Option.String('--tag');
  public commit = Option.String('--commit');
  public collectionsPath = Option.String('--collections-path');
  public skillsPath = Option.String('--skills-path');
  public ignoreTrust = Option.String('--ignore-trust', 'none');
  public allowEmpty = Option.Boolean('--allow-empty', false);
  public reportJson = Option.String('--report-json');
  public reportMarkdown = Option.String('--report-markdown');
  public reportOverwrite = Option.String('--report-overwrite', 'never');
  // eslint-disable-next-line new-cap -- Clipanion exposes Rest as a factory function with an uppercase name.
  public rest = Option.Rest({ required: 0 });
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const output = (this.output ?? 'text').toLowerCase();
    if (!OUTPUT_FORMATS.includes(output)) {
      ctx.stderr.write(`Invalid --output value: ${String(this.output)}\n`);
      return 64;
    }
    const level = this.failOn.toUpperCase();
    if (!FAIL_ON_LEVELS.includes(level)) {
      ctx.stderr.write(`Invalid --fail-on value: ${this.failOn}\n`);
      return 64;
    }
    if (this.ignoreTrust !== 'repository' && this.ignoreTrust !== 'none' && this.ignoreTrust !== 'baseline') {
      ctx.stderr.write(`Invalid --ignore-trust value: ${this.ignoreTrust}\n`);
      return 64;
    }
    if (this.rest.length > 1) {
      ctx.stderr.write('security rate takes a single PATH\n');
      return 64;
    }
    const failOn = (level === 'NONE' ? 'none' : level) as QualityFailOn;
    const root = path.resolve(ctx.cwd(), this.rest[0] ?? '.');
    try {
      const baseEngine = new RuleBasedSecurityScanEngine();
      const result = await runQualityRating({
        input: new NodeSecurityScanInput(),
        engine: new IsolatedSecurityScanEngine(baseEngine.descriptor, baseEngine.capabilities, SECURITY_DEFAULT_LIMITS.documentTimeoutMs, baseEngine),
        clock: ctx.clock,
        cancellation: new StaticCancellation(),
        limits: SECURITY_DEFAULT_LIMITS,
        request: {
          root,
          repository: this.repository ?? ctx.env.GITHUB_REPOSITORY ?? `local/${path.basename(root)}`,
          tag: this.tag ?? ctx.env.GITHUB_REF_NAME,
          commit: this.commit ?? ctx.env.GITHUB_SHA,
          failOn,
          collectionsPath: this.collectionsPath,
          skillsPath: this.skillsPath,
          ignoreTrust: this.ignoreTrust
        }
      });
      const store = new SecureAtomicSecurityReportStore(true);
      const overwrite = this.reportOverwrite === 'replace' ? 'replace' : 'never';
      if (this.reportJson !== undefined) {
        await store.write({ destination: this.reportJson, contents: `${JSON.stringify(result.report, null, 2)}\n`, overwrite });
      }
      if (this.reportMarkdown !== undefined) {
        await store.write({ destination: this.reportMarkdown, contents: renderQualityMarkdown(result.report), overwrite });
      }
      const rated = result.report.bundles.length > 0 || result.scan.coverage.scanned.length > 0;
      formatOutput({
        ctx, command: 'security.rate', output: output as 'text' | 'json' | 'yaml',
        status: result.scan.complete && result.report.gate.passed ? 'ok' : 'warning',
        data: { report: result.report, warnings: result.warnings, complete: result.scan.complete },
        textRenderer: () => textResult(result, failOn)
      });
      if (!result.scan.complete || (!rated && !this.allowEmpty)) {
        return 65;
      }
      return result.report.gate.passed ? 0 : 1;
    } catch (error) {
      ctx.stderr.write(`Security rating failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 74;
    }
  }
}
