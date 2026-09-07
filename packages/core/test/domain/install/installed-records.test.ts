/**
 * Tests for domain/install/installed-records.ts.
 *
 * These helpers are the rules both executors of a `TargetWritePlan` share, so
 * they are tested directly rather than only through either writer.
 */
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  installedChecksum,
  prunableSkillDirectories,
  skillRootDirectory,
} from '../../../src/domain/install/installed-records';
import type {
  InstalledFileRecord,
} from '../../../src/ports/target-writer';

const record = (overrides: Partial<InstalledFileRecord>): InstalledFileRecord => ({
  itemId: 'reviewer',
  kind: 'skill',
  sourcePath: 'skills/reviewer/SKILL.md',
  destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'SKILL.md'),
  destinationRelativePath: 'skills/reviewer/SKILL.md',
  installedChecksum: 'sha256:abc',
  ...overrides
});

describe('installedChecksum', () => {
  it('produces a sha256-prefixed hex digest', () => {
    expect(installedChecksum(new TextEncoder().encode('hello'))).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('distinguishes different byte sequences', () => {
    const a = installedChecksum(new TextEncoder().encode('a'));
    const b = installedChecksum(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });
});

describe('skillRootDirectory', () => {
  it('finds the ancestor directory named after the item id', () => {
    expect(skillRootDirectory(record({}))).toBe(path.join('/home', '.copilot', 'skills', 'reviewer'));
  });

  it('finds the root through nested subdirectories', () => {
    const nested = record({
      destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'assets', 'deep', 'x.json')
    });
    expect(skillRootDirectory(nested)).toBe(path.join('/home', '.copilot', 'skills', 'reviewer'));
  });

  it('normalizes the item id the same way the planner names the destination', () => {
    // `createTargetWritePlan` joins `normalizePromptId(item.id)` into the skill
    // destination, which hyphenates unsafe characters and preserves case.
    const spaced = record({
      itemId: 'My Reviewer',
      destinationPath: path.join('/home', '.copilot', 'skills', 'My-Reviewer', 'SKILL.md')
    });
    expect(skillRootDirectory(spaced)).toBe(path.join('/home', '.copilot', 'skills', 'My-Reviewer'));
  });

  it('returns null when no ancestor matches the item id', () => {
    expect(skillRootDirectory(record({ itemId: 'other' }))).toBeNull();
  });

  it('is independent of the route name so layout overrides keep working', () => {
    // The route is renamed from `skills/` to `ai-skills/`: pruning must still fire.
    const renamed = record({
      destinationPath: path.join('/home', '.copilot', 'ai-skills', 'reviewer', 'SKILL.md'),
      destinationRelativePath: 'ai-skills/reviewer/SKILL.md'
    });
    expect(skillRootDirectory(renamed)).toBe(path.join('/home', '.copilot', 'ai-skills', 'reviewer'));
  });
});

describe('prunableSkillDirectories', () => {
  it('returns the skill root and its subdirectories, deepest first', () => {
    const result = prunableSkillDirectories([
      record({ destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'SKILL.md') }),
      record({ destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'assets', 'deep', 'x.json') })
    ]);

    expect(result).toEqual([
      path.join('/home', '.copilot', 'skills', 'reviewer', 'assets', 'deep'),
      path.join('/home', '.copilot', 'skills', 'reviewer', 'assets'),
      path.join('/home', '.copilot', 'skills', 'reviewer')
    ]);
  });

  it('never proposes a directory above the skill root', () => {
    const result = prunableSkillDirectories([record({})]);

    expect(result).not.toContain(path.join('/home', '.copilot', 'skills'));
    expect(result).not.toContain(path.join('/home', '.copilot'));
  });

  it('ignores non-skill records', () => {
    expect(prunableSkillDirectories([
      record({
        kind: 'prompt',
        itemId: 'hello',
        destinationPath: path.join('/home', '.copilot', 'prompts', 'hello.prompt.md')
      })
    ])).toEqual([]);
  });

  it('ignores skill records whose root cannot be located', () => {
    expect(prunableSkillDirectories([record({ itemId: 'unrelated' })])).toEqual([]);
  });

  it('deduplicates directories shared by several files', () => {
    const result = prunableSkillDirectories([
      record({ destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'a.md') }),
      record({ destinationPath: path.join('/home', '.copilot', 'skills', 'reviewer', 'b.md') })
    ]);

    expect(result).toEqual([path.join('/home', '.copilot', 'skills', 'reviewer')]);
  });
});
