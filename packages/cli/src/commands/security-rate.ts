/**
 * `security rate` subcommand.
 *
 * Rates the collections (or skills) of a source checkout: each bundle and the source get a 0-100 score,
 * a risk band and a pass/fail gate. The findings come from the security scanner, or from a scan report
 * given with `--findings`.
 * @module commands/security-rate
 */
import * as path from 'node:path';
import {
  type QualityRatingResult,
  renderQualityMarkdown,
  runQualityRating,
  scanAndRate,
  type SecurityScanResult,
} from '@ai-primitives-hub/app';
import {
  gateFailed,
  parseFindingsDocument,
  type QualityFailOn,
  RuleBasedSecurityScanEngine,
  type SecurityCancellation,
} from '@ai-primitives-hub/core';
import {
  IsolatedSecurityScanEngine,
  NodeSecurityScanInput,
  SECURITY_DEFAULT_LIMITS,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

const FAIL_ON_LEVELS = ['NONE', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const OUTPUT_FORMATS: readonly string[] = ['text', 'json', 'yaml', 'ndjson'];
const isOutputFormat = (value: string): value is OutputFormat => OUTPUT_FORMATS.includes(value);
const LISTED_FINDINGS = 3;
const EXIT_USAGE = 64;
const EXIT_BAD_INPUT = 65;
const EXIT_IO = 74;

const score = (value: number | null): string => (value === null ? 'n/a' : `${String(value)}/100`);

class StaticCancellation implements SecurityCancellation {
  public readonly cancelled = false;
  public throwIfCancelled(): void {
    return undefined;
  }
}

const renderText = (result: QualityRatingResult, failOn: QualityFailOn, skipped: number, scan?: SecurityScanResult): string => {
  const { report } = result;
  const failedBundles = report.bundles.filter((bundle) => gateFailed(bundle.score, failOn));
  const gate = failOn === 'none'
    ? 'Gate (none): disabled'
    : `Gate (${failOn}): ${report.gate.passed ? 'passed' : `failed - ${String(failedBundles.length || 1)} below the limit`}`;
  const lines = [
    'Quality rating',
    `Source score: ${score(report.repo.score)} (${report.repo.risk}), ${report.repo.basis === 'bundles-average'
      ? `average of ${String(report.bundles.length)} bundle(s)`
      : 'whole repository'}`,
    gate,
    ...(scan === undefined ? [] : [`Scanned ${String(scan.coverage.scanned.length)} file(s)${scan.complete ? '' : ' (incomplete)'}`]),
    ...(scan?.errors ?? []).map((error) => `Error: ${error.code} - ${error.message}`),
    ...(skipped > 0 ? [`Warning: ${String(skipped)} finding(s) without a rule id, file or severity were skipped`] : []),
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

/**
 * Write a report, refusing to replace an existing file unless asked to.
 * @param ctx CLI context.
 * @param destination File to write.
 * @param contents File contents.
 * @param overwrite Whether an existing file may be replaced.
 */
const writeReport = async (ctx: Context, destination: string, contents: string, overwrite: boolean): Promise<void> => {
  const target = path.resolve(ctx.cwd(), destination);
  if (!overwrite && await ctx.fs.exists(target)) {
    throw new Error(`${destination} already exists; pass --overwrite to replace it`);
  }
  await ctx.fs.mkdir(path.dirname(target), { recursive: true });
  await ctx.fs.writeFile(target, contents);
};

/**
 * Security rate command class.
 */
export class SecurityRateCommand extends Command {
  public static readonly paths = [['security', 'rate']];

  public static readonly usage = Command.Usage({
    description: 'Scan a source checkout and rate its collections or skills, or rate the findings of another scanner.',
    category: 'Security',
    details: `
      Usage: ai-primitives-hub security rate [PATH] [--findings <report.json>] [options]

      Scores each collection (or skill) of PATH (default: the current directory) from 0 to 100 and
      the source as the average of its bundles. Without --findings, PATH is scanned with the security
      scanner (the same rules as "security scan"; repository suppressions are ignored). With --findings,
      the findings of a scan report are rated instead, for example the --report-json of "security scan":
      a JSON object with a "findings" array, or a bare array, where each finding needs ruleId, file and
      severity. The gate fails when a bundle scores below the limit of --fail-on (CRITICAL by default,
      none to disable); the exit code is then 1, and 65 when the scan is incomplete.

      Options:
        --findings <file>          Rate the findings of this scan report instead of scanning
        --fail-on <level>          none, CRITICAL, HIGH, MEDIUM or LOW (default: CRITICAL)
        --repository <owner/repo>  Recorded in the report (default: GITHUB_REPOSITORY, else local/<dir>)
        --tag <tag>                Release tag (default: GITHUB_REF_NAME when GITHUB_REF_TYPE is tag)
        --commit <sha>             Commit (default: GITHUB_SHA)
        --collections-path <dir>   Collections folder (default: collections)
        --skills-path <dir>        Skills folder (default: skills)
        --scanner-name <name>      Scanner recorded in the report (default: ai-primitives-hub-security,
                                   or unspecified with --findings)
        --report-json <file>       Write the quality report as JSON
        --report-markdown <file>   Write the report as Markdown
        --overwrite                Replace existing report files
        -o, --output <format>      Output format (text, json, yaml, ndjson)
    `
  });

  public findings = Option.String('--findings');
  public failOn = Option.String('--fail-on', 'CRITICAL');
  public repository = Option.String('--repository');
  public tag = Option.String('--tag');
  public commit = Option.String('--commit');
  public collectionsPath = Option.String('--collections-path');
  public skillsPath = Option.String('--skills-path');
  public scannerName = Option.String('--scanner-name');
  public reportJson = Option.String('--report-json');
  public reportMarkdown = Option.String('--report-markdown');
  public overwrite = Option.Boolean('--overwrite', false);
  public output = Option.String('-o,--output');
  // eslint-disable-next-line new-cap -- Clipanion exposes Rest as a factory function with an uppercase name.
  public rest = Option.Rest({ required: 0 });
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const requested = this.output ?? 'text';
    if (!isOutputFormat(requested)) {
      ctx.stderr.write(`Invalid --output value: ${String(this.output)}\n`);
      return EXIT_USAGE;
    }
    const fmt = requested;
    const level = this.failOn.toUpperCase();
    if (!FAIL_ON_LEVELS.includes(level)) {
      ctx.stderr.write(`Invalid --fail-on value: ${this.failOn}\n`);
      return EXIT_USAGE;
    }
    if (this.rest.length > 1) {
      ctx.stderr.write('security rate takes a single PATH\n');
      return EXIT_USAGE;
    }
    const failOn = (level === 'NONE' ? 'none' : level) as QualityFailOn;
    const root = path.resolve(ctx.cwd(), this.rest[0] ?? '.');
    const isDirectory = await ctx.fs.stat(root).then((stat) => stat.isDirectory, () => false);
    if (!isDirectory) {
      ctx.stderr.write(`PATH is not an existing directory: ${root}\n`);
      return EXIT_USAGE;
    }
    const destinations = [this.reportJson, this.reportMarkdown].filter((destination): destination is string => destination !== undefined);
    if (new Set(destinations.map((destination) => path.resolve(ctx.cwd(), destination))).size < destinations.length) {
      ctx.stderr.write('--report-json and --report-markdown must name different files\n');
      return EXIT_USAGE;
    }
    if (!this.overwrite) {
      for (const destination of destinations) {
        if (await ctx.fs.exists(path.resolve(ctx.cwd(), destination))) {
          ctx.stderr.write(`${destination} already exists; pass --overwrite to replace it\n`);
          return EXIT_IO;
        }
      }
    }

    const request = {
      root,
      repository: this.repository ?? ctx.env.GITHUB_REPOSITORY ?? `local/${path.basename(root)}`,
      tag: this.tag ?? (ctx.env.GITHUB_REF_TYPE === 'tag' ? ctx.env.GITHUB_REF_NAME : undefined),
      commit: this.commit ?? ctx.env.GITHUB_SHA,
      failOn,
      collectionsPath: this.collectionsPath,
      skillsPath: this.skillsPath
    };

    let result: QualityRatingResult;
    let scan: SecurityScanResult | undefined;
    let skipped = 0;
    try {
      if (this.findings === undefined) {
        const baseEngine = new RuleBasedSecurityScanEngine();
        const scanned = await scanAndRate({
          input: new NodeSecurityScanInput(),
          engine: new IsolatedSecurityScanEngine(baseEngine.descriptor, baseEngine.capabilities, SECURITY_DEFAULT_LIMITS.documentTimeoutMs),
          clock: ctx.clock,
          cancellation: new StaticCancellation(),
          limits: SECURITY_DEFAULT_LIMITS,
          request: { ...request, scannerName: this.scannerName }
        });
        ({ scan } = scanned);
        result = scanned;
      } else {
        let parsed: ReturnType<typeof parseFindingsDocument>;
        try {
          parsed = parseFindingsDocument(JSON.parse(await ctx.fs.readFile(path.resolve(ctx.cwd(), this.findings))));
        } catch (error) {
          ctx.stderr.write(`Cannot read findings from ${this.findings}: ${error instanceof Error ? error.message : String(error)}\n`);
          return EXIT_BAD_INPUT;
        }
        skipped = parsed.skipped;
        if (parsed.findings.length === 0 && parsed.skipped > 0) {
          ctx.stderr.write(`No usable findings in ${this.findings}: ${String(parsed.skipped)} entries lack a rule id, file or severity\n`);
          return EXIT_BAD_INPUT;
        }
        result = runQualityRating({
          findings: parsed.findings,
          generatedAt: ctx.clock.nowIso(),
          request: { ...request, scannerName: this.scannerName ?? 'unspecified' }
        });
      }
      if (this.reportJson !== undefined) {
        await writeReport(ctx, this.reportJson, `${JSON.stringify(result.report, null, 2)}\n`, this.overwrite);
      }
      if (this.reportMarkdown !== undefined) {
        await writeReport(ctx, this.reportMarkdown, renderQualityMarkdown(result.report), this.overwrite);
      }
      formatOutput({
        ctx,
        command: 'security.rate',
        output: fmt,
        status: result.report.gate.passed && scan?.complete !== false ? 'ok' : 'warning',
        data: {
          report: result.report,
          warnings: result.warnings,
          skippedFindings: skipped,
          scannedFiles: scan?.coverage.scanned.length,
          complete: scan?.complete
        },
        textRenderer: () => renderText(result, failOn, skipped, scan)
      });
      if (scan?.complete === false) {
        return EXIT_BAD_INPUT;
      }
      return result.report.gate.passed ? 0 : 1;
    } catch (error) {
      ctx.stderr.write(`Security rating failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_IO;
    }
  }
}
