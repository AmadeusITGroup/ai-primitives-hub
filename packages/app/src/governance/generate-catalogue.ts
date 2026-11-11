/**
 * Write the committed, generated rule catalogue (`docs/author-guide/rule-catalogue.md`).
 * @module app/governance/generate-catalogue
 */
import * as path from 'node:path';
import {
  type FileSystem,
  GOVERNANCE_RULES,
  renderRuleCatalogue,
} from '@ai-primitives-hub/core';

export const RULE_CATALOGUE_PATH = 'docs/author-guide/rule-catalogue.md';

/** The catalogue as it should be committed. */
export function ruleCatalogue(): string {
  return renderRuleCatalogue(GOVERNANCE_RULES);
}

/**
 * Write the catalogue, or only check it when `check` is set.
 * @param fs Filesystem port.
 * @param repoRoot Repository root.
 * @param options `check` compares instead of writing.
 * @param options.check
 * @returns `true` when the committed file is current (check mode) or was written.
 */
export async function generateRuleCatalogue(fs: FileSystem, repoRoot: string, options: { check?: boolean } = {}): Promise<boolean> {
  const target = path.join(repoRoot, RULE_CATALOGUE_PATH);
  const expected = ruleCatalogue();
  if (options.check) {
    return (await fs.exists(target)) && (await fs.readFile(target)) === expected;
  }
  await fs.writeFile(target, expected);
  return true;
}
