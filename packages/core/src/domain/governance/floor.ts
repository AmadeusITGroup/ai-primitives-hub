/**
 * Floor rules: policy can neither disable nor downgrade them.
 * @module domain/governance/floor
 */
import {
  GOVERNANCE_RULES,
} from './rule-registry';

export const FLOOR_RULE_IDS: readonly string[] = GOVERNANCE_RULES.filter((rule) => !rule.disableable && rule.configurable).map((rule) => rule.id);

/**
 * True when a rule id belongs to the floor.
 * @param ruleId
 */
export function isFloorRule(ruleId: string): boolean {
  return FLOOR_RULE_IDS.includes(ruleId);
}
