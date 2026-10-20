/**
 * Governance domain types. Pure: no IO.
 * @module domain/governance/types
 */

/** What a governance run validates. */
export type GovernanceSubject = 'hub' | 'collection' | 'primitive';
export type GovernanceSeverity = 'error' | 'warning';

export interface GovernanceFinding {
  ruleId: string;
  severity: GovernanceSeverity;
  message: string;
  file?: string;
  /** Findings whose data could not be verified carry no score weight. */
  verified?: boolean;
  /** How to fix it, shown under the message in reports. */
  hint?: string;
}

/** Static description of one rule; the registry is the single source of truth. */
export interface GovernanceRule {
  id: string;
  subjects: readonly GovernanceSubject[];
  description: string;
  defaultSeverity: GovernanceSeverity;
  /** False for floor rules: policy can neither disable nor downgrade them. */
  disableable: boolean;
  /** False for configuration rules, which are evaluated before any policy applies. */
  configurable: boolean;
  /** True when the rule must contact a source to produce evidence. */
  needsNetwork: boolean;
}

export interface GovernanceRuleOverride {
  enabled?: boolean;
  severity?: GovernanceSeverity;
  reason?: string;
}

export interface GovernancePolicy {
  minScore?: number;
  rules?: Record<string, GovernanceRuleOverride>;
}

export interface GovernanceSuppression {
  ruleId: string;
  action: string;
  reason?: string;
}

/** A network rule that applies to the subject but was not run. Zero score weight. */
export interface GovernanceNotChecked {
  ruleId: string;
  reason: string;
}

export interface GovernanceReport {
  schemaVersion: 1;
  subject: GovernanceSubject;
  mode: 'offline' | 'sources';
  verdict: 'pass' | 'fail';
  score: number;
  minScore?: number;
  findings: GovernanceFinding[];
  suppressions: GovernanceSuppression[];
  notChecked: GovernanceNotChecked[];
}
