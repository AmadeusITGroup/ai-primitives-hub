/** Security finding severity and gating policy helpers. */
import type {
  FailurePolicy,
  FailurePolicyResult,
  SecurityFinding,
  SecuritySeverity,
} from './types';
import {
  SECURITY_SEVERITIES,
} from './types';

const severityRank = (severity: SecuritySeverity): number => SECURITY_SEVERITIES.indexOf(severity);

/**
 * Return the ordered severities that block a policy.
 * @param findings
 * @param policy
 */
export const evaluateFailurePolicy = (
  findings: readonly Pick<SecurityFinding, 'severity'>[],
  policy: FailurePolicy
): FailurePolicyResult => {
  if (policy === 'none') {
    return { passed: true, blocking: [] };
  }
  const blocking = policy === 'any'
    ? findings.map((finding) => finding.severity)
    : findings.filter((finding) => severityRank(finding.severity) <= severityRank(policy)).map((finding) => finding.severity);
  return {
    passed: blocking.length === 0,
    blocking: [...new Set(blocking)].toSorted((a, b) => severityRank(a) - severityRank(b))
  };
};

/**
 * Select findings by an exact severity list.
 * @param findings
 * @param selected
 */
export const selectSeverities = <T extends { severity: SecuritySeverity }>(
  findings: readonly T[],
  selected: readonly SecuritySeverity[] | undefined
): T[] => selected === undefined ? [...findings] : findings.filter((finding) => selected.includes(finding.severity));
