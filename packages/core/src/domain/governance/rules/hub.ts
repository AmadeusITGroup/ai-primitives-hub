/**
 * Hub rules. HUB001/HUB002 report the existing hub validator's results.
 * @module domain/governance/rules/hub
 */
import type {
  GovernanceRule,
} from '../types';

export const HUB_RULES: readonly GovernanceRule[] = [
  { id: 'HUB001', subjects: ['hub'], description: 'Hub syntax, schema, references and source policies',
    defaultSeverity: 'error', disableable: false, configurable: true, needsNetwork: false },
  { id: 'HUB002', subjects: ['hub'], description: 'Hub validation advisories',
    defaultSeverity: 'warning', disableable: true, configurable: true, needsNetwork: false }
];
