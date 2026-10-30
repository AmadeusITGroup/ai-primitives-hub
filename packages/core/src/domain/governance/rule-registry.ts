/**
 * The governance rule registry: every rule id, its subjects, default severity and flags.
 * @module domain/governance/rule-registry
 */
import {
  COLLECTION_RULES,
} from './rules/collection';
import {
  CONFIG_RULES,
} from './rules/config';
import {
  HUB_RULES,
} from './rules/hub';
import {
  PRIMITIVE_RULES,
} from './rules/primitive';
import type {
  GovernanceRule,
  GovernanceSubject,
} from './types';

export const GOVERNANCE_RULES: readonly GovernanceRule[] = [
  ...COLLECTION_RULES, ...HUB_RULES, ...PRIMITIVE_RULES, ...CONFIG_RULES
].toSorted((a, b) => a.id.localeCompare(b.id));

/**
 * Look up a rule by id.
 * @param id Rule id, for example COL001.
 */
export function getGovernanceRule(id: string): GovernanceRule | undefined {
  return GOVERNANCE_RULES.find((rule) => rule.id === id);
}

/**
 * Rules that apply to one subject.
 * @param subject
 */
export function rulesForSubject(subject: GovernanceSubject): GovernanceRule[] {
  return GOVERNANCE_RULES.filter((rule) => rule.subjects.includes(subject));
}
