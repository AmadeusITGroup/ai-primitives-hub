/**
 * Apply a policy over rule defaults, guarded by the floor and configurability flags.
 * @module domain/governance/effective-rules
 */
import {
  rulesForSubject,
} from './rule-registry';
import type {
  GovernanceFinding,
  GovernanceNotChecked,
  GovernancePolicy,
  GovernanceSubject,
  GovernanceSuppression,
} from './types';

/**
 * Overrides that changed something, sorted by rule id, so reports list every suppression.
 * @param policy A policy that already passed the configuration rules.
 */
export function policySuppressions(policy: GovernancePolicy): GovernanceSuppression[] {
  const suppressions: GovernanceSuppression[] = [];
  for (const [ruleId, override] of Object.entries(policy.rules ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (override.enabled === false || override.severity !== undefined) {
      suppressions.push({ ruleId, action: override.enabled === false ? 'disabled' : `severity: ${override.severity}`, reason: override.reason });
    }
  }
  return suppressions;
}

/**
 * Drop disabled findings and apply severity overrides. Non-configurable (CFG) findings pass through.
 * @param findings Raw findings from the rules.
 * @param policy A policy that already passed the configuration rules.
 */
export function applyPolicy(findings: readonly GovernanceFinding[], policy: GovernancePolicy): GovernanceFinding[] {
  const result: GovernanceFinding[] = [];
  for (const finding of findings) {
    const override = finding.ruleId.startsWith('CFG') ? undefined : policy.rules?.[finding.ruleId];
    if (override?.enabled !== false) {
      result.push({ ...finding, severity: override?.severity ?? finding.severity });
    }
  }
  return result;
}

/**
 * Enabled network rules for the subject that an offline run did not execute.
 * @param subject
 * @param policy A policy that already passed the configuration rules.
 */
export function offlineNotChecked(subject: GovernanceSubject, policy: GovernancePolicy): GovernanceNotChecked[] {
  return rulesForSubject(subject)
    .filter((rule) => rule.needsNetwork && policy.rules?.[rule.id]?.enabled !== false)
    .map((rule) => ({ ruleId: rule.id, reason: 'Not checked (offline). Enable source checks to verify.' }));
}
