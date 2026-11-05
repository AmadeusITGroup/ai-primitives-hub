/**
 * Quality report: rates each bundle (collection) on its own and the source as the average of its
 * bundles, from the findings of a scan.
 *
 * The JSON shape is `quality-report.schema.json` (schemaVersion 1).
 * @module domain/quality/quality-report
 */
import * as path from 'node:path';
import {
  recommendedFixFor,
} from './remediation';
import {
  DEFAULT_SCORING_WEIGHTS,
  gateFailed,
  type QualityFailOn,
  type QualityRisk,
  riskFromScore,
  scoreFindings,
  type ScoringWeights,
} from './scoring';
import type {
  QualityFinding,
  QualitySeverity,
} from './types';
import {
  QUALITY_SEVERITIES,
} from './types';

export type QualityReportMode = 'release-archives' | 'collections' | 'skills' | 'repository';

export interface QualityFindingEntry {
  ruleId: string;
  severity: QualitySeverity;
  /** Points this finding costs. */
  points: number;
  file: string;
  line: number;
  title: string;
  /** How to fix it. */
  fix: string;
}

export interface QualityBlock {
  score: number | null;
  risk: QualityRisk;
  penalty: number;
  counts: Record<QualitySeverity, number>;
  /** The costliest findings; counts cover all of them. */
  findings: QualityFindingEntry[];
}

export interface QualityBundleMetadata {
  author: string | null;
  kind: Record<string, number>;
  labels: string[];
}

export interface QualityBundle extends QualityBlock {
  id: string;
  version: string;
  metadata?: QualityBundleMetadata;
}

export interface QualitySourceBlock extends QualityBlock {
  /** `bundles-average`, or `repository` when no bundles were found and the whole checkout was rated. */
  basis: 'bundles-average' | 'repository';
}

export interface QualityReport {
  schemaVersion: 1;
  generatedAt: string;
  scanner: { name: string };
  source: { repository: string; tag: string; commit: string; mode: QualityReportMode };
  repo: QualitySourceBlock;
  bundles: QualityBundle[];
  gate: { failOn: Uppercase<QualityFailOn>; passed: boolean };
}

/** A bundle and the repository-relative files it ships. */
export interface BundleFiles {
  id: string;
  version: string;
  files: readonly string[];
  metadata?: QualityBundleMetadata;
}

export interface RateOptions {
  weights?: ScoringWeights;
  /** How many of the costliest findings to list. */
  maxFindings?: number;
}

export const DEFAULT_MAX_LISTED_FINDINGS = 20;

const emptyCounts = (): Record<QualitySeverity, number> =>
  Object.fromEntries(QUALITY_SEVERITIES.map((severity) => [severity, 0])) as Record<QualitySeverity, number>;

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
export const rateFindings = (findings: readonly QualityFinding[], options: RateOptions = {}): QualityBlock => {
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
export const aggregateQualityBlocks = (
  blocks: readonly QualityBlock[],
  maxFindings: number = DEFAULT_MAX_LISTED_FINDINGS,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): QualityBlock => {
  const scores = blocks.flatMap((block) => (block.score === null ? [] : [block.score]));
  const score = scores.length === 0 ? null : Math.floor((2 * scores.reduce((sum, value) => sum + value, 0) + scores.length) / (2 * scores.length));
  const counts = emptyCounts();
  for (const block of blocks) {
    for (const severity of QUALITY_SEVERITIES) {
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

export interface BuildQualityReportInput {
  findings: readonly QualityFinding[];
  /** Bundles to rate; empty rates the whole repository as one unit. */
  bundles: readonly BundleFiles[];
  mode: QualityReportMode;
  failOn: QualityFailOn;
  generatedAt: string;
  scanner: { name: string };
  source: { repository: string; tag: string; commit: string };
  weights?: ScoringWeights;
  maxFindings?: number;
}

/**
 * Build the quality report of a scan.
 * @param input - Scan findings, the bundles with their files, and report metadata
 */
export const buildQualityReport = (input: BuildQualityReportInput): QualityReport => {
  const weights = input.weights ?? DEFAULT_SCORING_WEIGHTS;
  const options: RateOptions = { weights, maxFindings: input.maxFindings };
  const limit = input.maxFindings ?? DEFAULT_MAX_LISTED_FINDINGS;
  const bundles: QualityBundle[] = input.bundles.map((bundle) => {
    const files = new Set(bundle.files.map((file) => normalizeReportPath(file)));
    const own = input.findings.filter((item) => files.has(normalizeReportPath(item.file)));
    return {
      id: bundle.id,
      version: bundle.version,
      ...rateFindings(own, options),
      ...(bundle.metadata === undefined ? {} : { metadata: bundle.metadata })
    };
  });
  const repo: QualitySourceBlock = bundles.length > 0
    ? { ...aggregateQualityBlocks(bundles, limit, weights), basis: 'bundles-average' }
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
    gate: { failOn: input.failOn.toUpperCase() as Uppercase<QualityFailOn>, passed: !failed }
  };
};
