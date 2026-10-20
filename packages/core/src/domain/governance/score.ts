/**
 * Advisory score: starts at 100, minus 10 per error and 3 per warning. Unverified findings weigh nothing.
 * @module domain/governance/score
 */
import type {
  GovernanceFinding,
} from './types';

export const ERROR_PENALTY = 10;
export const WARNING_PENALTY = 3;

/**
 * Compute the 0-100 advisory score.
 * @param findings Findings after policy is applied.
 */
export function governanceScore(findings: readonly GovernanceFinding[]): number {
  const penalty = findings.reduce((total, finding) => {
    if (finding.verified === false) {
      return total;
    }
    return total + (finding.severity === 'error' ? ERROR_PENALTY : WARNING_PENALTY);
  }, 0);
  return Math.max(0, 100 - penalty);
}
