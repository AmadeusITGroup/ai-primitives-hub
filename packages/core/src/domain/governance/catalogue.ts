/**
 * Render the contributor-facing rule catalogue from the registry.
 * @module domain/governance/catalogue
 */
import {
  ERROR_PENALTY,
  WARNING_PENALTY,
} from './score';
import type {
  GovernanceRule,
} from './types';

/**
 * Escape Markdown table, emphasis and MDX expression characters.
 * @param value
 */
const cell = (value: string): string => value.replaceAll(/[|*{}]/g, (character) => `\\${character}`).replaceAll('<', '&lt;');
const floorCell = (rule: GovernanceRule): string => {
  if (!rule.configurable) {
    return '—';
  }
  return rule.disableable ? 'no' : 'yes';
};

/**
 * Markdown catalogue. Deterministic, so the committed document can be checked for staleness.
 * @param rules The rule registry.
 */
export function renderRuleCatalogue(rules: readonly GovernanceRule[]): string {
  const lines = [
    '# Governance rule catalogue',
    '',
    // Plain text, not an HTML comment: the docs site renders Markdown as MDX.
    'Generated from `packages/core/src/domain/governance/rule-registry.ts`. Do not edit by hand;',
    'regenerate with `pnpm -C packages/app run generate:rule-catalogue`.',
    '',
    `Every run starts at a score of 100 and loses ${ERROR_PENALTY} points per error and ${WARNING_PENALTY} per warning.`,
    'Findings whose data could not be verified carry no score weight. Any error fails the run;',
    'the score fails it only when a minimum score is set.',
    '',
    'Floor rules cannot be disabled or downgraded in `hub-governance.yml`. Configuration rules (CFG)',
    'are evaluated before any policy applies and cannot be configured.',
    '',
    '| Rule | Applies to | Default | Floor | Configurable | Needs network | Description |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const rule of rules) {
    const columns = [rule.id, rule.subjects.join(', '), rule.defaultSeverity, floorCell(rule),
      rule.configurable ? 'yes' : 'no', rule.needsNetwork ? 'yes' : 'no', cell(rule.description)];
    lines.push(`| ${columns.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
