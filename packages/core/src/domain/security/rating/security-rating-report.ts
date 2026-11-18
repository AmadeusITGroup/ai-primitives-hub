/**
 * Security rating report: rates each bundle (collection) on its own and the source as the average of its
 * bundles, from the findings of a scan.
 *
 * The JSON shape is `security-rating-report.schema.json` (schemaVersion 1).
 * @module domain/security/rating/security-rating-report
 */
import * as path from 'node:path';
import {
  recommendedFixFor,
} from '../remediations';
import {
  DEFAULT_SCORING_WEIGHTS,
  gateFailed,
  riskFromScore,
  scoreFindings,
  type ScoringWeights,
  type SecurityRatingFailOn,
  type SecurityRatingRisk,
} from './scoring';
import type {
  SecurityRatingFinding,
  SecurityRatingSeverity,
} from './types';
import {
  SECURITY_RATING_SEVERITIES,
} from './types';

export type SecurityRatingReportMode = 'release-archives' | 'collections' | 'skills' | 'repository';

export interface SecurityRatingFindingEntry {
  ruleId: string;
  severity: SecurityRatingSeverity;
  /** Points this finding costs. */
  points: number;
  file: string;
  line: number;
  title: string;
  /** How to fix it. */
  fix: string;
}

export interface SecurityRatingBlock {
  score: number | null;
  risk: SecurityRatingRisk;
  penalty: number;
  counts: Record<SecurityRatingSeverity, number>;
  /** The costliest findings; counts cover all of them. */
  findings: SecurityRatingFindingEntry[];
}

export interface SecurityRatingBundleMetadata {
  author: string | null;
  kind: Record<string, number>;
  labels: string[];
}

export interface SecurityRatingBundle extends SecurityRatingBlock {
  id: string;
  version: string;
  metadata?: SecurityRatingBundleMetadata;
}

export interface SecurityRatingSourceBlock extends SecurityRatingBlock {
  /** `bundles-average`, or `repository` when no bundles were found and the whole checkout was rated. */
  basis: 'bundles-average' | 'repository';
}

export interface SecurityRatingReport {
  schemaVersion: 1;
  generatedAt: string;
  scanner: { name: string };
  source: { repository: string; tag: string; commit: string; mode: SecurityRatingReportMode };
  repo: SecurityRatingSourceBlock;
  bundles: SecurityRatingBundle[];
  gate: { failOn: Uppercase<SecurityRatingFailOn>; passed: boolean };
}

/** A bundle and the repository-relative files it ships. */
export interface BundleFiles {
  id: string;
  version: string;
  files: readonly string[];
  metadata?: SecurityRatingBundleMetadata;
}

export interface RateOptions {
  weights?: ScoringWeights;
  /** How many of the costliest findings to list. */
  maxFindings?: number;
}

export const DEFAULT_MAX_LISTED_FINDINGS = 20;

const emptyCounts = (): Record<SecurityRatingSeverity, number> =>
  Object.fromEntries(SECURITY_RATING_SEVERITIES.map((severity) => [severity, 0])) as Record<SecurityRatingSeverity, number>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Normalise a path for matching: forward slashes, no leading `./`.
 * @param file - Path as reported by the scanner or a collection
 */
export const normalizeReportPath = (file: string): string => path.posix.normalize(file.replaceAll('\\', '/'));

/**
 * Rate a list of findings.
 * @param findings - Findings of one bundle, or of the whole repository
 * @param options - Weights and list size
 */
export const rateFindings = (findings: readonly SecurityRatingFinding[], options: RateOptions = {}): SecurityRatingBlock => {
  const weights = options.weights ?? DEFAULT_SCORING_WEIGHTS;
  const scored = scoreFindings(findings, weights);
  const counts = emptyCounts();
  for (const item of findings) {
    counts[item.severity] += 1;
  }
  const ranked = findings.map((_, index) => index)
    .filter((index) => scored.points[index] > 0)
    .toSorted((a, b) => scored.points[b] - scored.points[a]
      || findings[a].file.localeCompare(findings[b].file) || (findings[a].line ?? 0) - (findings[b].line ?? 0));
  return {
    score: scored.score,
    risk: scored.risk,
    penalty: round1(scored.penalty),
    counts,
    findings: ranked.slice(0, options.maxFindings ?? DEFAULT_MAX_LISTED_FINDINGS).map((index) => ({
      ruleId: findings[index].ruleId,
      severity: findings[index].severity,
      points: round1(scored.points[index]),
      file: normalizeReportPath(findings[index].file),
      line: findings[index].line ?? 0,
      title: findings[index].title,
      fix: findings[index].recommendedFix ?? recommendedFixFor(findings[index].ruleId)
    }))
  };
};

/**
 * Average of the scored blocks (halves rounded up), the risk band of that average, and the summed
 * penalty and counts. Unscored blocks are left out.
 * @param blocks - Bundle blocks
 * @param maxFindings - How many of the costliest findings to list
 * @param weights - Scoring weights
 */
export const aggregateSecurityRatingBlocks = (
  blocks: readonly SecurityRatingBlock[],
  maxFindings: number = DEFAULT_MAX_LISTED_FINDINGS,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): SecurityRatingBlock => {
  const scores = blocks.flatMap((block) => (block.score === null ? [] : [block.score]));
  const score = scores.length === 0 ? null : Math.floor((2 * scores.reduce((sum, value) => sum + value, 0) + scores.length) / (2 * scores.length));
  const counts = emptyCounts();
  for (const block of blocks) {
    for (const severity of SECURITY_RATING_SEVERITIES) {
      counts[severity] += block.counts[severity];
    }
  }
  return {
    score,
    risk: riskFromScore(score, weights),
    penalty: round1(blocks.reduce((sum, block) => sum + block.penalty, 0)),
    counts,
    findings: blocks.flatMap((block) => block.findings)
      .toSorted((a, b) => b.points - a.points || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, maxFindings)
  };
};

export interface BuildSecurityRatingReportInput {
  findings: readonly SecurityRatingFinding[];
  /** Bundles to rate; empty rates the whole repository as one unit. */
  bundles: readonly BundleFiles[];
  mode: SecurityRatingReportMode;
  failOn: SecurityRatingFailOn;
  generatedAt: string;
  scanner: { name: string };
  source: { repository: string; tag: string; commit: string };
  weights?: ScoringWeights;
  maxFindings?: number;
}

/**
 * Build the security rating report of a scan.
 * @param input - Scan findings, the bundles with their files, and report metadata
 */
export const buildSecurityRatingReport = (input: BuildSecurityRatingReportInput): SecurityRatingReport => {
  const weights = input.weights ?? DEFAULT_SCORING_WEIGHTS;
  const options: RateOptions = { weights, maxFindings: input.maxFindings };
  const limit = input.maxFindings ?? DEFAULT_MAX_LISTED_FINDINGS;
  const bundles: SecurityRatingBundle[] = input.bundles.map((bundle) => {
    const files = new Set(bundle.files.map((file) => normalizeReportPath(file)));
    const own = input.findings.filter((item) => files.has(normalizeReportPath(item.file)));
    return {
      id: bundle.id,
      version: bundle.version,
      ...rateFindings(own, options),
      ...(bundle.metadata === undefined ? {} : { metadata: bundle.metadata })
    };
  });
  const repo: SecurityRatingSourceBlock = bundles.length > 0
    ? { ...aggregateSecurityRatingBlocks(bundles, limit, weights), basis: 'bundles-average' }
    : { ...rateFindings(input.findings, options), basis: 'repository' };
  const failed = bundles.length > 0
    ? bundles.some((bundle) => gateFailed(bundle.score, input.failOn, weights))
    : gateFailed(repo.score, input.failOn, weights);
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    scanner: input.scanner,
    source: { ...input.source, mode: bundles.length > 0 ? input.mode : 'repository' },
    repo,
    bundles,
    gate: { failOn: input.failOn.toUpperCase() as Uppercase<SecurityRatingFailOn>, passed: !failed }
  };
};
