import type {
  Clock,
  FailurePolicy,
  SecurityCancellation,
  SecurityFinding,
  SecurityInputRequest,
  SecurityResourceLimits,
  SecurityScanEngine,
  SecurityScanInput,
  SuppressedFinding,
} from '@ai-primitives-hub/core';
import {
  applySuppressions,
  evaluateFailurePolicy,
  SECURITY_SEVERITIES,
  selectSeverities,
} from '@ai-primitives-hub/core';

export interface SecurityScanRequest {
  roots: readonly string[];
  extensions: readonly string[];
  recursive: boolean;
  excludes: readonly string[];
  includeDocFiles: boolean;
  ignoreTrust: 'repository' | 'none' | 'baseline';
  baselineSuppressionPath?: string;
  baselineFileIgnorePath?: string;
}

export interface SecurityScanOptions {
  includeLlmControls: boolean;
  skipInfoControls: boolean;
  selectedSeverities?: readonly (typeof SECURITY_SEVERITIES[number])[];
}

export interface SecurityScanCoverage {
  scanned: readonly { path: string; rootId: string; bytes: number }[];
  ignored: readonly { path: string; reason: string; source?: string }[];
  skipped: readonly { path: string; reason: string }[];
  errors: readonly { path?: string; code: string; message: string }[];
}

export interface SecuritySuppressedSummary {
  ruleId: string;
  severity: SecurityFinding['severity'];
  fingerprint: string;
  kind: 'instance' | 'canonical';
  sourcePath: string;
}

export interface SecurityScanResult {
  schemaVersion: 1;
  scanId: string;
  complete: boolean;
  engine: SecurityScanEngine['descriptor'];
  compatibility: string;
  options: SecurityScanOptions & { failOn: FailurePolicy; ignoreTrust: SecurityScanRequest['ignoreTrust'] };
  coverage: SecurityScanCoverage;
  summary: {
    active: { total: number; bySeverity: Record<string, number> };
    suppressed: { total: number; bySeverity: Record<string, number> };
    policy: { failOn: FailurePolicy; passed: boolean; blocking: string[] };
  };
  findings: readonly SecurityFinding[];
  suppressed: readonly SecuritySuppressedSummary[];
  warnings: readonly string[];
  errors: readonly { code: string; message: string; path?: string }[];
  timing: { startedAt: string; completedAt: string; durationMs: number };
}

export interface SecurityScanDependencies {
  input: SecurityScanInput;
  engine: SecurityScanEngine;
  clock: Clock;
  cancellation: SecurityCancellation;
}

const DEFAULT_LIMITS: SecurityResourceLimits = {
  maxFiles: 10_000,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 104_857_600,
  maxDepth: 64,
  maxFindings: 5000,
  maxIgnoreBytes: 65_536,
  maxIgnoreLines: 1024,
  maxReportBytes: 10_485_760,
  timeoutMs: 60_000,
  documentTimeoutMs: 2000
};

const bySeverity = (findings: readonly Pick<SecurityFinding, 'severity'>[]): Record<string, number> => {
  const counts: Record<string, number> = Object.fromEntries(SECURITY_SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
};

const sortFindings = (findings: readonly SecurityFinding[]): SecurityFinding[] => findings.toSorted((a, b) =>
  a.file.localeCompare(b.file)
  || (a.line ?? 0) - (b.line ?? 0)
  || a.ruleId.localeCompare(b.ruleId)
  || (a.variantId ?? '').localeCompare(b.variantId ?? '')
  || a.canonicalFingerprint.localeCompare(b.canonicalFingerprint));

const toInputRequest = (request: SecurityScanRequest): SecurityInputRequest => request;

export const runSecurityScan = async (
  options: SecurityScanDependencies & {
    request: SecurityScanRequest;
    scanOptions?: SecurityScanOptions;
    limits?: SecurityResourceLimits;
    failOn?: FailurePolicy;
    compatibility?: string;
  }
): Promise<SecurityScanResult> => {
  const startedAt = options.clock.now();
  const scanOptions = options.scanOptions ?? { includeLlmControls: false, skipInfoControls: false };
  const failOn = options.failOn ?? 'HIGH';
  const limits = options.limits ?? DEFAULT_LIMITS;
  options.cancellation.throwIfCancelled();
  const collection = await options.input.collect(toInputRequest(options.request), limits, options.cancellation);
  const scanned: { path: string; rootId: string; bytes: number }[] = [];
  const coverageErrors = [...collection.errors];
  const allFindings: SecurityFinding[] = [];
  let totalBytes = 0;

  for (const candidate of collection.candidates) {
    options.cancellation.throwIfCancelled();
    const read = await options.input.read(candidate, limits, options.cancellation);
    if (read.error !== undefined || read.document === undefined) {
      coverageErrors.push({ path: candidate.displayPath, code: read.error?.code ?? 'SECURITY.INPUT_UNREADABLE', message: read.error?.message ?? 'Input could not be read.' });
      continue;
    }
    totalBytes += read.document.metadata.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      coverageErrors.push({ path: candidate.displayPath, code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum total input bytes exceeded.' });
      break;
    }
    const findings = await options.engine.scanDocument(read.document, {
      includeLlmControls: scanOptions.includeLlmControls,
      skipInfoControls: scanOptions.skipInfoControls,
      maxFindings: limits.maxFindings
    }, options.cancellation);
    scanned.push({ path: candidate.displayPath, rootId: candidate.rootId, bytes: read.document.metadata.bytes });
    allFindings.push(...findings);
    if (allFindings.length >= limits.maxFindings) {
      coverageErrors.push({ code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum finding count exceeded.' });
      break;
    }
  }

  const suppressed: SuppressedFinding[] = [];
  const active: SecurityFinding[] = [];
  const rootIds = new Set(scanned.map((file) => file.rootId));
  for (const rootId of rootIds) {
    const rootFindings = allFindings.filter((finding) => finding.rootId === rootId || (finding.rootId === undefined && scanned.some((file) => file.rootId === rootId && file.path === finding.file)));
    const result = applySuppressions(rootFindings, collection.suppressions, rootId);
    active.push(...result.active);
    suppressed.push(...result.suppressed);
  }
  const sortedActive = sortFindings(selectSeverities(active, scanOptions.selectedSeverities));
  const policy = evaluateFailurePolicy(active, failOn);
  const completedAt = options.clock.now();
  const errors = coverageErrors.map((error) => ({ path: error.path, code: error.code, message: error.message }));

  return {
    schemaVersion: 1,
    scanId: `${startedAt}-${options.engine.descriptor.rulePackDigest.slice(-12)}`,
    complete: errors.length === 0,
    engine: options.engine.descriptor,
    compatibility: options.compatibility ?? 'md-security-scanner@1.10.9',
    options: { ...scanOptions, failOn, ignoreTrust: options.request.ignoreTrust },
    coverage: { scanned, ignored: collection.ignoredFiles, skipped: collection.skippedFiles, errors },
    summary: {
      active: { total: sortedActive.length, bySeverity: bySeverity(sortedActive) },
      suppressed: { total: suppressed.length, bySeverity: bySeverity(suppressed.map((item) => item.finding)) },
      policy: { failOn, passed: policy.passed && errors.length === 0, blocking: policy.blocking }
    },
    findings: sortedActive,
    suppressed: suppressed.map((item) => ({
      ruleId: item.finding.ruleId,
      severity: item.finding.severity,
      fingerprint: item.kind === 'instance' ? item.finding.fingerprint : item.finding.canonicalFingerprint,
      kind: item.kind,
      sourcePath: item.declaration.sourcePath
    })),
    warnings: collection.warnings.map((warning) => `${warning.sourcePath}:${warning.line}: ${warning.message}`),
    errors,
    timing: { startedAt: new Date(startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(), durationMs: completedAt - startedAt }
  };
};

export { DEFAULT_LIMITS as SECURITY_SCAN_DEFAULT_LIMITS };
