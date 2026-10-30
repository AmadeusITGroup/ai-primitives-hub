/**
 * Configuration rules CFG001-CFG003. Evaluated before any policy applies; never configurable.
 * CFG001 (syntax/schema) is raised by the infra parser; CFG002-CFG003 are semantic and live here.
 * @module domain/governance/rules/config
 */
import type {
  GovernanceFinding,
  GovernancePolicy,
  GovernanceRule,
} from '../types';

export const CONFIG_RULES: readonly GovernanceRule[] = [
  { id: 'CFG001', subjects: ['hub'], description: 'Governance configuration is readable YAML matching hub-governance.schema.json',
    defaultSeverity: 'error', disableable: false, configurable: false, needsNetwork: false },
  { id: 'CFG002', subjects: ['hub'], description: 'Governance configuration references only known, configurable rule ids',
    defaultSeverity: 'error', disableable: false, configurable: false, needsNetwork: false },
  { id: 'CFG003', subjects: ['hub'], description: 'Governance configuration does not disable or downgrade a floor rule',
    defaultSeverity: 'error', disableable: false, configurable: false, needsNetwork: false }
];

/**
 * Semantic configuration checks. Any finding here means the policy is ignored for the run.
 * @param policy Parsed policy (already schema-valid).
 * @param rules The rule registry.
 * @param file Display path of the configuration file.
 */
export function configFindings(
  policy: GovernancePolicy,
  rules: readonly GovernanceRule[],
  file?: string
): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];
  const add = (ruleId: string, message: string, source = file): void => {
    findings.push({ ruleId, severity: 'error', message, file: source });
  };
  for (const [id, override] of Object.entries(policy.rules ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) {
    const rule = rules.find((candidate) => candidate.id === id);
    if (!rule) {
      add('CFG002', `Unknown governance rule '${id}'.`);
    } else if (!rule.configurable) {
      add('CFG002', `Rule '${id}' is not configurable.`);
    } else if (!rule.disableable && (override.enabled === false || override.severity === 'warning')) {
      add('CFG003', `Rule '${id}' cannot be disabled or downgraded.`);
    }
  }
  return findings;
}
