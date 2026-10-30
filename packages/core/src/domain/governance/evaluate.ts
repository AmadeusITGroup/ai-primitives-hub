/**
 * One deterministic gate: configuration rules, policy, score and verdict.
 * @module domain/governance/evaluate
 */
import {
  applyPolicy,
  offlineNotChecked,
  policySuppressions,
} from './effective-rules';
import {
  GOVERNANCE_RULES,
} from './rule-registry';
import {
  configFindings,
} from './rules/config';
import {
  governanceScore,
} from './score';
import type {
  GovernanceFinding,
  GovernancePolicy,
  GovernanceReport,
  GovernanceSubject,
} from './types';

export interface EvaluateOptions {
  /** Whether network rules ran. Offline runs list them under `notChecked`. Defaults to offline. */
  mode?: GovernanceReport['mode'];
  /** Display path of the configuration file, used on CFG findings. */
  configFile?: string;
}

/**
 * Evaluate findings into a report. A policy with any CFG finding is ignored for the run.
 * @param subject What was validated.
 * @param input Raw rule findings (including CFG001 from the parser, if any).
 * @param policy Parsed, schema-valid policy.
 * @param cliMinScore Minimum score from the command line; takes precedence over the policy.
 * @param options Mode and configuration file path.
 */
export function evaluateGovernance(
  subject: GovernanceSubject,
  input: readonly GovernanceFinding[],
  policy: GovernancePolicy = {},
  cliMinScore?: number,
  options: EvaluateOptions = {}
): GovernanceReport {
  const mode = options.mode ?? 'offline';
  const configErrors = configFindings(policy, cliMinScore, GOVERNANCE_RULES, options.configFile);
  const parserErrors = input.some((finding) => finding.ruleId === 'CFG001');
  const effective = configErrors.length > 0 || parserErrors ? {} : policy;
  const findings = [...configErrors, ...applyPolicy(input, effective)];
  const score = governanceScore(findings);
  const threshold = configErrors.some((finding) => finding.ruleId === 'CFG004') ? undefined : (cliMinScore ?? effective.minScore);
  return {
    schemaVersion: 1,
    subject,
    mode,
    verdict: findings.some((finding) => finding.severity === 'error') || (threshold !== undefined && score < threshold) ? 'fail' : 'pass',
    score,
    minScore: threshold,
    findings,
    suppressions: policySuppressions(effective),
    notChecked: mode === 'offline' ? offlineNotChecked(subject, effective) : []
  };
}
