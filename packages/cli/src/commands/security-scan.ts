import * as path from 'node:path';
import {
  runSecurityScan,
  type SecurityScanRequest,
  type SecurityScanResult,
} from '@ai-primitives-hub/app';
import {
  RuleBasedSecurityScanEngine,
  type SecurityCancellation,
  type SecuritySeverity,
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
  OutputFormat,
} from '../framework';
import {
  formatOutput,
} from '../framework';

const SEVERITIES: SecuritySeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const severitySelection = (minimum: string | undefined): SecuritySeverity[] | undefined => {
  if (minimum === undefined) {
    return undefined;
  }
  const index = SEVERITIES.indexOf(minimum.toUpperCase() as SecuritySeverity);
  return index === -1 ? undefined : SEVERITIES.slice(0, SEVERITIES.length - index);
};

const reportJson = (result: SecurityScanResult): string => `${JSON.stringify({
  scanner: 'ai-primitives-hub-security',
  version: result.engine.version,
  compatibility: result.compatibility,
  scan_date: result.timing.startedAt,
  scanned_files: result.coverage.scanned.map((file) => file.path),
  ignored_files: result.coverage.ignored.map((file) => String(file.path)),
  summary: {
    total_findings: result.summary.active.total,
    suppressed_findings: result.summary.suppressed.total,
    by_severity: result.summary.active.bySeverity
  },
  findings: result.findings.map((finding) => ({
    rule_id: finding.ruleId,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    section: finding.section,
    vulnerable_content: finding.vulnerableContent,
    risk: finding.risk,
    owasp: finding.owasp,
    fingerprint: finding.fingerprint,
    instance_fingerprint: finding.fingerprint,
    canonical_fingerprint: finding.canonicalFingerprint,
    recommended_fix: finding.recommendedFix,
    is_info_control: finding.isInfoControl ?? false
  })),
  references: { rule_pack: result.engine.rulePackId }
}, null, 2)}\n`;

const reportMarkdown = (result: SecurityScanResult): string => {
  const lines = [
    '# AI Primitives Hub Security Report',
    '',
    `- Complete: **${String(result.complete)}**`,
    `- Compatibility: **${result.compatibility}**`,
    `- Files scanned: **${String(result.coverage.scanned.length)}**`,
    `- Suppressed findings: **${String(result.summary.suppressed.total)}**`,
    '',
    '## Findings',
    ''
  ];
  if (result.findings.length === 0) {
    lines.push('No active findings.');
  }
  for (const finding of result.findings) {
    lines.push(
      `### ${finding.severity} — ${finding.title}`,
      '',
      `- Rule: \`${finding.ruleId}\``,
      `- Location: \`${finding.file}\`${finding.line === undefined ? '' : ` — line ${String(finding.line)}`}`,
      `- Confidence: ${finding.confidence}`,
      `- Fingerprint: \`${finding.fingerprint}\``,
      `- Canonical fingerprint: \`${finding.canonicalFingerprint}\``,
      `- Risk: ${finding.risk.replaceAll('`', '\\`')}`,
      `- Recommended fix: ${finding.recommendedFix.replaceAll('`', '\\`')}`,
      ''
    );
  }
  if (result.warnings.length > 0) {
    lines.push('## Warnings', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }
  return `${lines.join('\n')}\n`;
};

const displayPath = (value: string, roots: readonly string[]): string => {
  if (!path.isAbsolute(value)) {
    return value.replaceAll('\\', '/');
  }
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), value);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return relative.replaceAll('\\', '/') || path.basename(value);
    }
  }
  return path.basename(value);
};

const presentResult = (result: SecurityScanResult, roots: readonly string[]): SecurityScanResult => ({
  ...result,
  coverage: {
    ...result.coverage,
    ignored: result.coverage.ignored.map((file) => ({ ...file, path: displayPath(file.path, roots), source: file.source === undefined ? undefined : displayPath(file.source, roots) })),
    skipped: result.coverage.skipped.map((file) => ({ ...file, path: displayPath(file.path, roots) })),
    errors: result.coverage.errors.map((error) => ({ ...error, path: error.path === undefined ? undefined : displayPath(error.path, roots) }))
  },
  errors: result.errors.map((error) => ({ ...error, path: error.path === undefined ? undefined : displayPath(error.path, roots) })),
  suppressed: result.suppressed.map((item) => ({ ...item, sourcePath: displayPath(item.sourcePath, roots) }))
});

const textResult = (result: SecurityScanResult): string => {
  const counts = result.summary.active.bySeverity;
  return [
    `Security scan ${result.complete ? 'complete' : 'incomplete'}`,
    `Scanned ${String(result.coverage.scanned.length)} file(s)`,
    ...SEVERITIES.map((severity) => `${severity}: ${String(counts[severity] ?? 0)}`),
    `Suppressed: ${String(result.summary.suppressed.total)}`,
    `Policy (${result.summary.policy.failOn}): ${result.summary.policy.passed ? 'passed' : 'failed'}`,
    ...result.errors.map((error) => `Error: ${error.code} — ${error.message}`)
  ].join('\n') + '\n';
};

class StaticCancellation implements SecurityCancellation {
  public readonly cancelled = false;
  public throwIfCancelled(): void {
    return undefined;
  }
}

const writeReports = async (
  ctx: Context,
  result: SecurityScanResult,
  outputDirectory: string | undefined,
  outputName: string,
  reportJsonPath: string | undefined,
  reportMarkdownPath: string | undefined,
  overwrite: string
): Promise<void> => {
  const destinations: { path: string; contents: string }[] = [];
  if (outputDirectory === undefined) {
    if (reportJsonPath !== undefined) {
      destinations.push({ path: reportJsonPath, contents: reportJson(result) });
    }
    if (reportMarkdownPath !== undefined) {
      destinations.push({ path: reportMarkdownPath, contents: reportMarkdown(result) });
    }
  } else {
    const name = path.basename(outputName);
    if (name !== outputName || name === '.' || name === '..') {
      throw new Error('Invalid --output-name; expected a basename');
    }
    destinations.push(
      { path: path.join(outputDirectory, `${name}.json`), contents: reportJson(result) },
      { path: path.join(outputDirectory, `${name}.md`), contents: reportMarkdown(result) }
    );
  }
  const store = new SecureAtomicSecurityReportStore(true);
  for (const destination of destinations) {
    await store.write({ destination: destination.path, contents: destination.contents, overwrite: overwrite === 'replace' ? 'replace' : 'never' });
  }
};

const parsePositive = (value: string | undefined, fallback: number): number | undefined => {
  if (value === undefined) {
    return fallback;
  }
  const match = /^(\d+)(ms|s|m)?$/i.exec(value);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'm' ? 60_000 : (unit === 's' ? 1000 : 1);
  const parsed = amount * multiplier;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const writeNdjson = (ctx: Context, result: SecurityScanResult): void => {
  const records = [
    { type: 'scan.header', schemaVersion: 1, scanId: result.scanId, complete: result.complete },
    ...result.findings.map((finding) => ({ type: 'scan.finding', schemaVersion: 1, scanId: result.scanId, finding })),
    ...result.errors.map((error) => ({ type: 'scan.coverage-error', schemaVersion: 1, scanId: result.scanId, error })),
    { type: 'scan.summary', schemaVersion: 1, scanId: result.scanId, summary: result.summary }
  ];
  for (const record of records) {
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
  }
};

export class SecurityScanCommand extends Command {
  public static readonly paths = [['security', 'scan']];
  public static readonly usage = Command.Usage({
    description: 'Scan AI primitive files for security findings.',
    category: 'Security',
    details: `
      Usage: ai-primitives-hub security scan [PATH...]

      Use --ci for fail-closed CI defaults, --ignore-trust none to disable repository suppressions,
      and --fail-on HIGH to gate on high or critical findings. Secret evidence is redacted by default.
      Reports are opt-in with --report-json, --report-markdown, or --output-directory.
    `
  });

  public output = Option.String('-o,--output');
  public ext = Option.Array('--ext');
  public noRecursive = Option.Boolean('--no-recursive', false);
  public exclude = Option.Array('--exclude');
  public includeDocFiles = Option.Boolean('--include-doc-files', false);
  public severity = Option.Array('--severity');
  public minimumSeverity = Option.String('--minimum-severity');
  public includeLlmControls = Option.Boolean('--include-llm-controls', false);
  public skipInfoControls = Option.Boolean('--skip-info-controls', false);
  public failOn = Option.String('--fail-on', 'HIGH');
  public allowEmpty = Option.Boolean('--allow-empty', false);
  public ci = Option.Boolean('--ci', false);
  public ignoreTrust = Option.String('--ignore-trust');
  public baselineSuppressions = Option.String('--baseline-suppressions');
  public baselineFileIgnore = Option.String('--baseline-file-ignore');
  public reportJson = Option.String('--report-json');
  public reportMarkdown = Option.String('--report-markdown');
  public outputDirectory = Option.String('--output-directory');
  public outputName = Option.String('--output-name', 'security-report');
  public reportOverwrite = Option.String('--report-overwrite', 'never');
  public maxFiles = Option.String('--max-files');
  public maxFileBytes = Option.String('--max-file-bytes');
  public maxTotalBytes = Option.String('--max-total-bytes');
  public maxDepth = Option.String('--max-depth');
  public maxFindings = Option.String('--max-findings');
  public timeout = Option.String('--timeout');
  public report = Option.Boolean('--report', false);
  // eslint-disable-next-line new-cap -- Clipanion exposes Rest as a factory function with an uppercase name.
  public rest = Option.Rest({ required: 0 });
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const output = (this.output ?? 'text').toLowerCase() as OutputFormat;
    if (!['text', 'json', 'yaml', 'ndjson'].includes(output)) {
      ctx.stderr.write(`Invalid --output value: ${String(this.output)}\n`);
      return 64;
    }
    if (this.report && output !== 'text') {
      ctx.stderr.write('--report can only be used with text output\n');
      return 64;
    }
    if (this.outputDirectory !== undefined && (this.reportJson !== undefined || this.reportMarkdown !== undefined)) {
      ctx.stderr.write('--output-directory cannot be combined with explicit report paths\n');
      return 64;
    }
    const roots = this.rest.length > 0 ? this.rest : [ctx.cwd()];
    const rawIgnoreTrust = this.ci ? 'none' : (this.ignoreTrust ?? 'repository');
    if (rawIgnoreTrust !== 'repository' && rawIgnoreTrust !== 'none' && rawIgnoreTrust !== 'baseline') {
      ctx.stderr.write(`Invalid --ignore-trust value: ${rawIgnoreTrust}\n`);
      return 64;
    }
    const ignoreTrust = rawIgnoreTrust;
    const rawFailOn = (this.ci ? 'HIGH' : this.failOn).toUpperCase();
    if (rawFailOn !== 'NONE' && rawFailOn !== 'ANY' && !SEVERITIES.includes(rawFailOn as SecuritySeverity)) {
      ctx.stderr.write(`Invalid --fail-on value: ${rawFailOn}\n`);
      return 64;
    }
    const failOn = rawFailOn === 'NONE' ? 'none' : (rawFailOn === 'ANY' ? 'any' : rawFailOn as SecuritySeverity);
    const severityValues = this.severity ?? [];
    const extensionValues = this.ext ?? [];
    const excludeValues = this.exclude ?? [];
    const selected = severityValues.length > 0
      ? severityValues.map((value) => value.toUpperCase() as SecuritySeverity)
      : severitySelection(this.minimumSeverity);
    if (selected?.some((severity) => !SEVERITIES.includes(severity))) {
      ctx.stderr.write('Invalid --severity value\n');
      return 64;
    }
    if (this.minimumSeverity !== undefined && severitySelection(this.minimumSeverity) === undefined) {
      ctx.stderr.write(`Invalid --minimum-severity value: ${this.minimumSeverity}\n`);
      return 64;
    }
    const request: SecurityScanRequest = {
      roots,
      extensions: extensionValues.length > 0 ? extensionValues : ['.md', '.markdown'],
      recursive: !this.noRecursive,
      excludes: excludeValues.length > 0 ? excludeValues : ['.git', 'node_modules'],
      includeDocFiles: this.includeDocFiles,
      ignoreTrust,
      baselineSuppressionPath: this.baselineSuppressions,
      baselineFileIgnorePath: this.baselineFileIgnore
    };
    const limits = {
      ...SECURITY_DEFAULT_LIMITS,
      maxFiles: parsePositive(this.maxFiles, SECURITY_DEFAULT_LIMITS.maxFiles),
      maxFileBytes: parsePositive(this.maxFileBytes, SECURITY_DEFAULT_LIMITS.maxFileBytes),
      maxTotalBytes: parsePositive(this.maxTotalBytes, SECURITY_DEFAULT_LIMITS.maxTotalBytes),
      maxDepth: parsePositive(this.maxDepth, SECURITY_DEFAULT_LIMITS.maxDepth),
      maxFindings: parsePositive(this.maxFindings, SECURITY_DEFAULT_LIMITS.maxFindings),
      timeoutMs: parsePositive(this.timeout, SECURITY_DEFAULT_LIMITS.timeoutMs)
    };
    if (Object.values(limits).includes(undefined)) {
      ctx.stderr.write('Security scan limits must be positive integers with optional ms, s, or m suffixes\n');
      return 64;
    }
    try {
      const baseEngine = new RuleBasedSecurityScanEngine();
      const result = await runSecurityScan({
        input: new NodeSecurityScanInput(),
        engine: new IsolatedSecurityScanEngine(baseEngine.descriptor, baseEngine.capabilities, SECURITY_DEFAULT_LIMITS.documentTimeoutMs, baseEngine),
        clock: ctx.clock,
        cancellation: new StaticCancellation(),
        request,
        scanOptions: { includeLlmControls: this.includeLlmControls, skipInfoControls: this.skipInfoControls, selectedSeverities: selected },
        failOn,
        limits: limits as typeof SECURITY_DEFAULT_LIMITS
      });
      const visibleResult = presentResult(result, roots);
      await writeReports(ctx, visibleResult, this.outputDirectory, this.outputName, this.reportJson, this.reportMarkdown, this.reportOverwrite);
      if (output === 'ndjson') {
        writeNdjson(ctx, visibleResult);
      } else {
        formatOutput({
          ctx, command: 'security.scan', output,
          status: visibleResult.complete && visibleResult.summary.policy.passed ? 'ok' : 'warning',
          data: visibleResult, textRenderer: textResult
        });
      }
      if (this.report) {
        ctx.stdout.write(reportMarkdown(visibleResult));
      }
      if (!result.complete || (result.coverage.scanned.length === 0 && !this.allowEmpty)) {
        return 65;
      }
      return result.summary.policy.passed ? 0 : 1;
    } catch (error) {
      ctx.stderr.write(`Security scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 74;
    }
  }
}
