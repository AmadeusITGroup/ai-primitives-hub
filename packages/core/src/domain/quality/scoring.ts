/**
 * Weighted quality scoring of scanner findings.
 *
 * Every finding costs points; none is ignored:
 *
 *   points  = severityPoints x confidenceFactor x contextFactor x ruleFactor x repeatFactor
 *   penalty = sum of points
 *   score   = round(100 x exp(-penalty / curveScale))
 *   risk    = band of the score (higher score, lower risk)
 *
 * The weights, curve and bands are chosen together so that one full-strength finding of each
 * severity lands in its own band (LOW 93 low, MEDIUM 82 medium, HIGH 61 high, CRITICAL 37
 * critical).
 * @module domain/quality/scoring
 */
import type {
  QualityConfidence,
  QualityFinding,
  QualitySeverity,
} from './types';

export type PathContext = 'primitive' | 'doc' | 'vendored';

/** Risk label of a score; `unknown` when there is no score. */
export type QualityRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/** Gate level: a bundle fails when its score is below the limit of this level. */
export type QualityFailOn = 'none' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ScoringWeights {
  readonly severityPoints: Readonly<Record<QualitySeverity, number>>;
  readonly confidenceFactor: Readonly<Record<QualityConfidence, number>>;
  readonly contextFactor: Readonly<Record<PathContext, number>>;
  readonly ruleFactor: Readonly<Record<string, number>>;
  /** Factor for the 1st, 2nd, 3rd and later finding of one rule in one file. */
  readonly repeatFactor: readonly number[];
  readonly curveScale: number;
  /** A score at or above `low` is low risk, at or above `medium` medium, at or above `high` high. */
  readonly riskBands: { readonly low: number; readonly medium: number; readonly high: number };
  readonly docBasenames: readonly string[];
  readonly docPathParts: readonly string[];
  readonly vendoredPathParts: readonly string[];
  readonly vendoredSuffixes: readonly string[];
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  severityPoints: { CRITICAL: 40, HIGH: 20, MEDIUM: 8, LOW: 3, INFO: 0 },
  confidenceFactor: { HIGH: 1, MEDIUM: 0.5, LOW: 0.25 },
  contextFactor: { primitive: 1, doc: 0.25, vendored: 0.1 },
  ruleFactor: { 'INJ-002': 0.25, 'HKS-008': 0.25, 'MD-001': 0.25 },
  repeatFactor: [1, 0.5, 0.25],
  curveScale: 40,
  riskBands: { low: 90, medium: 70, high: 40 },
  docBasenames: [
    'readme.md', 'agents.md', 'claude.md', 'contributing.md', 'code_of_conduct.md',
    'security.md', 'communication.md', 'changelog.md', 'release_notes.md'
  ],
  docPathParts: ['/docs/', '/references/', '/change-logs/', '/changelogs/'],
  vendoredPathParts: ['/node_modules/', '/vendor/', '/third_party/', '/.yarn/', '/dist/', '/build/'],
  vendoredSuffixes: ['.min.js', '.min.css', '.map']
};

export type ScoredFinding = Pick<QualityFinding, 'ruleId' | 'severity' | 'confidence' | 'file' | 'line'>;

export interface ScoredFindings {
  score: number;
  risk: QualityRisk;
  penalty: number;
  /** Points of each input finding, in input order. */
  points: number[];
}

/**
 * Where a finding is: vendored code and docs cost less than real primitives.
 * @param file - Finding file path, any separator and case
 * @param weights - Scoring weights
 */
export const classifyPath = (file: string, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): PathContext => {
  const normalized = `/${file.replaceAll('\\', '/').toLowerCase().replaceAll(/^\/+|\/+$/g, '')}`;
  const folders = `${normalized}/`;
  if (weights.vendoredPathParts.some((part) => folders.includes(part))
    || weights.vendoredSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    return 'vendored';
  }
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (weights.docPathParts.some((part) => folders.includes(part)) || weights.docBasenames.includes(basename)) {
    return 'doc';
  }
  return 'primitive';
};

/**
 * Risk label of a score.
 * @param score - 0-100, or null when unscored
 * @param weights - Scoring weights
 */
export const riskFromScore = (score: number | null, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): QualityRisk => {
  if (score === null) {
    return 'unknown';
  }
  const { low, medium, high } = weights.riskBands;
  if (score >= low) {
    return 'low';
  }
  if (score >= medium) {
    return 'medium';
  }
  return score >= high ? 'high' : 'critical';
};

export const scoreFromPenalty = (penalty: number, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): number =>
  Math.floor((100 * Math.exp(-penalty / weights.curveScale)) + 0.5);

/**
 * Code point order, so repeats are counted the same way on every platform and locale.
 * @param a
 * @param b
 */
const compare = (a: string | number, b: string | number): number => (a < b ? -1 : (a > b ? 1 : 0));

/**
 * Score a list of findings.
 * @param findings - Findings with severity, confidence, rule and location
 * @param weights - Scoring weights
 */
export const scoreFindings = (
  findings: readonly ScoredFinding[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoredFindings => {
  const points = Array.from<number>({ length: findings.length }).fill(0);
  const seen = new Map<string, number>();
  const order = findings.map((_, index) => index).toSorted((a, b) =>
    compare(findings[a].file, findings[b].file)
    || compare(findings[a].line ?? 0, findings[b].line ?? 0)
    || compare(findings[a].ruleId, findings[b].ruleId)
    || compare(weights.severityPoints[findings[b].severity], weights.severityPoints[findings[a].severity])
    || compare(weights.confidenceFactor[findings[b].confidence] ?? 1, weights.confidenceFactor[findings[a].confidence] ?? 1));
  const lastRepeat = weights.repeatFactor.length - 1;
  for (const index of order) {
    const item = findings[index];
    const key = `${item.ruleId}\u0000${item.file}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    points[index] = weights.severityPoints[item.severity]
      * (weights.confidenceFactor[item.confidence] ?? 1)
      * weights.contextFactor[classifyPath(item.file, weights)]
      * (Object.hasOwn(weights.ruleFactor, item.ruleId) ? weights.ruleFactor[item.ruleId] : 1)
      * weights.repeatFactor[Math.min(occurrence, lastRepeat)];
  }
  const penalty = points.reduce((sum, value) => sum + value, 0);
  const score = scoreFromPenalty(penalty, weights);
  return { score, risk: riskFromScore(score, weights), penalty, points };
};

/**
 * Score below which the gate fails a bundle: CRITICAL fails the critical band, HIGH the high and
 * critical bands, MEDIUM everything below the low band, LOW any score under 100.
 * @param failOn - Gate level other than `none`
 * @param weights - Scoring weights
 */
export const gateScoreLimit = (
  failOn: Exclude<QualityFailOn, 'none'>,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number => {
  const limits = { CRITICAL: weights.riskBands.high, HIGH: weights.riskBands.medium, MEDIUM: weights.riskBands.low, LOW: 100 };
  return limits[failOn];
};

/**
 * Whether a score trips the gate.
 * @param score - 0-100, or null when unscored
 * @param failOn - Gate level
 * @param weights - Scoring weights
 */
export const gateFailed = (
  score: number | null,
  failOn: QualityFailOn,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): boolean => failOn !== 'none' && score !== null && score < gateScoreLimit(failOn, weights);
