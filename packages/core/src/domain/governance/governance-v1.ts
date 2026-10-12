/** Versioned, IO-free governance verdict model. Existing validators remain authoritative. */
import type {
  AllCollectionsResult,
} from '../collection/types';

export { default as GOVERNANCE_POLICY_SCHEMA_V1 } from './policy-v1.schema.json';

export type GovernanceSubjectV1 = 'hub' | 'collection' | 'skill';
export type GovernanceSeverityV1 = 'error' | 'warning';

export interface GovernanceFindingV1 {
  ruleId: string;
  severity: GovernanceSeverityV1;
  message: string;
  file?: string;
  /** Findings whose data could not be verified carry no score weight. */
  verified?: boolean;
}

export interface GovernanceRuleOverrideV1 {
  enabled?: boolean;
  severity?: GovernanceSeverityV1;
  reason?: string;
}

export interface GovernancePolicyV1 {
  minScore?: number;
  rules?: Record<string, GovernanceRuleOverrideV1>;
}

export interface GovernanceReportV1 {
  schemaVersion: 1;
  subject: GovernanceSubjectV1;
  mode: 'offline';
  verdict: 'pass' | 'fail';
  score: number;
  minScore?: number;
  findings: GovernanceFindingV1[];
  suppressions: { ruleId: string; action: string; reason?: string }[];
}

/** These IDs wrap existing validation results; they do not infer rule IDs from error text. */
export const GOVERNANCE_RULES_V1 = {
  HUB001: { mandatory: true, description: 'Hub syntax, schema, references and source policies' },
  HUB002: { mandatory: false, description: 'Hub validation advisories' },
  COL001: { mandatory: true, description: 'Collection IDs and names are unique within the repository' },
  COL003: { mandatory: false, description: 'Collection author is non-empty' },
  COL005: { mandatory: true, description: 'Collection structure and referenced files are valid' },
  COL006: { mandatory: false, description: 'Collection validation advisories' },
  SKL001: { mandatory: true, description: 'Agent Skills specification and folder validation' },
  SKL002: { mandatory: false, description: 'Skill validation advisories' },
  CFG001: { mandatory: true, description: 'Governance configuration is valid' }
} as const;

/**
 * Adapt existing collection findings without duplicating structural validation.
 * @param result
 */
export function collectionGovernanceFindingsV1(result: AllCollectionsResult): GovernanceFindingV1[] {
  const structuralErrors = new Set(result.fileResults.flatMap((file) => file.errors));
  // The existing aggregator adds only repository-wide duplicate IDs/names to file errors.
  const findings: GovernanceFindingV1[] = result.errors.map((message) => ({ ruleId: structuralErrors.has(message) ? 'COL005' : 'COL001', severity: 'error', message }));
  findings.push(...result.warnings.map((message): GovernanceFindingV1 => ({ ruleId: 'COL006', severity: 'warning', message })));
  for (const file of result.fileResults) {
    const collection = file.collection;
    if (!collection || typeof collection !== 'object') {
      continue;
    }
    if (typeof collection.author !== 'string' || collection.author.trim() === '') {
      findings.push({ ruleId: 'COL003', severity: 'error', message: 'Collection author must be non-empty.', file: file.file });
    }
  }
  return findings;
}

/**
 * Policy mistakes cannot disable a mandatory validator or silently pass as typos.
 * @param policy
 */
export function governancePolicyErrorsV1(policy: GovernancePolicyV1): string[] {
  const errors: string[] = [];
  if (policy.minScore !== undefined && (!Number.isFinite(policy.minScore) || policy.minScore < 0 || policy.minScore > 100)) {
    errors.push('minScore must be a number between 0 and 100.');
  }
  for (const [id, override] of Object.entries(policy.rules ?? {})) {
    const rule = Object.hasOwn(GOVERNANCE_RULES_V1, id) ? GOVERNANCE_RULES_V1[id as keyof typeof GOVERNANCE_RULES_V1] : undefined;
    if (!rule) {
      errors.push(`Unknown governance rule '${id}'.`);
    } else if (rule.mandatory && (override.enabled === false || override.severity === 'warning')) {
      errors.push(`Mandatory rule '${id}' cannot be disabled or downgraded.`);
    }
  }
  return errors;
}

/**
 * Apply policy, preserve suppression provenance, and calculate one deterministic gate.
 * @param subject
 * @param input
 * @param policy
 * @param minScore
 */
export function evaluateGovernanceV1(
  subject: GovernanceSubjectV1,
  input: readonly GovernanceFindingV1[],
  policy: GovernancePolicyV1 = {},
  minScore?: number
): GovernanceReportV1 {
  const policyErrors = governancePolicyErrorsV1(policy);
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) {
    policyErrors.push('CLI minimum score must be a number between 0 and 100.');
  }
  const effectivePolicy = policyErrors.length > 0 ? {} : policy;
  const suppressions: GovernanceReportV1['suppressions'] = [];
  for (const [ruleId, override] of Object.entries(effectivePolicy.rules ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (override.enabled === false || override.severity !== undefined) {
      suppressions.push({ ruleId, action: override.enabled === false ? 'disabled' : `severity: ${override.severity}`, reason: override.reason });
    }
  }
  const findings: GovernanceFindingV1[] = policyErrors.map((message) => ({ ruleId: 'CFG001', severity: 'error', message }));
  for (const finding of input) {
    const override = effectivePolicy.rules?.[finding.ruleId];
    if (override?.enabled !== false) {
      findings.push({ ...finding, severity: override?.severity ?? finding.severity });
    }
  }
  const score = Math.max(0, 100 - findings.reduce((penalty, finding) => penalty + (finding.verified === false ? 0 : (finding.severity === 'error' ? 10 : 3)), 0));
  const threshold = minScore ?? effectivePolicy.minScore;
  return {
    schemaVersion: 1,
    subject,
    mode: 'offline',
    verdict: findings.some((finding) => finding.severity === 'error') || (threshold !== undefined && score < threshold) ? 'fail' : 'pass',
    score,
    minScore: threshold,
    findings,
    suppressions
  };
}
