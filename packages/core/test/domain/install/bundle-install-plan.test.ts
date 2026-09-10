import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateManifest,
} from '../../../src/domain/collection/manifest-validator';
import type {
  ValidatedManifest,
} from '../../../src/domain/collection/manifest-validator';
import {
  createBundleInstallPlan,
} from '../../../src/domain/install/bundle-install-plan';
import {
  createFoursightBundle,
  foursightArchiveEntries,
} from '../../fixtures/foursight-bundle';
import {
  createGovernedReleaseArchive,
} from '../../fixtures/release-archives';

describe('createBundleInstallPlan', () => {
  it('classifies arbitrary legacy item paths from manifest types', () => {
    const files = createFoursightBundle();
    const manifest = validateManifest(files, {});

    const plan = createBundleInstallPlan(files, manifest);

    expect(plan.items).toHaveLength(6);
    expect(plan.items.map((item) => [item.id, item.kind])).toEqual([
      ['code-review', 'agent'],
      ['security-review', 'agent'],
      ['test-review', 'agent'],
      ['docs-review', 'agent'],
      ['architecture-review', 'agent'],
      ['foursight-code-review', 'skill']
    ]);
    expect(plan.legacyInferredPaths).toEqual([]);
  });

  it('assigns every nested skill file relative to the skill root', () => {
    const files = createFoursightBundle();
    const plan = createBundleInstallPlan(files, validateManifest(files, {}));
    const skill = plan.items.find((item) => item.id === 'foursight-code-review');

    expect(skill?.entryPath).toBe(
      'foursight-pr-review/skills/foursight-code-review/SKILL.md'
    );
    expect(skill?.files.map((file) => ({
      sourcePath: file.sourcePath,
      relativePath: file.relativePath
    }))).toEqual([
      {
        sourcePath: 'foursight-pr-review/skills/foursight-code-review/SKILL.md',
        relativePath: 'SKILL.md'
      },
      {
        sourcePath: 'foursight-pr-review/skills/foursight-code-review/assets/rubric.json',
        relativePath: 'assets/rubric.json'
      },
      {
        sourcePath: 'foursight-pr-review/skills/foursight-code-review/references/checklist.md',
        relativePath: 'references/checklist.md'
      },
      {
        sourcePath: 'foursight-pr-review/skills/foursight-code-review/scripts/check.sh',
        relativePath: 'scripts/check.sh'
      }
    ]);
    expect(skill?.files.every((file) => file.bytes instanceof Uint8Array)).toBe(true);
    expect(skill?.files.map((file) => file.sourceChecksum)).toEqual(expect.arrayContaining(
      Object.values(foursightArchiveEntries)
        .slice(-4)
        .map(() => expect.any(String))
    ));
  });

  it.each([
    ['missing entry files', 'missing', 'agent', 'BUNDLE.MANIFEST_ENTRY_MISSING'],
    ['invalid kinds', 'valid.agent.md', 'not-a-kind', 'BUNDLE.MANIFEST_INVALID_KIND'],
    ['unsafe paths', '../outside.agent.md', 'agent', 'BUNDLE.MANIFEST_PATH_INVALID']
  ])('rejects %s with a structured manifest error', (_label, path, type, code) => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['valid.agent.md', new TextEncoder().encode('# Valid\n')]
    ]);
    const manifest = {
      id: 'test',
      version: '1',
      name: 'Test',
      prompts: [{ id: 'item', file: path, type }]
    } as unknown as ValidatedManifest;

    expect(() => createBundleInstallPlan(files, manifest)).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it('rejects duplicate item ids and duplicate file ownership', () => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['one.agent.md', new TextEncoder().encode('# One\n')],
      ['two.agent.md', new TextEncoder().encode('# Two\n')]
    ]);
    const duplicateId = {
      id: 'test',
      version: '1',
      name: 'Test',
      prompts: [
        { id: 'same', file: 'one.agent.md', type: 'agent' },
        { id: 'same', file: 'two.agent.md', type: 'agent' }
      ]
    } as unknown as ValidatedManifest;
    const duplicateOwnership = {
      ...duplicateId,
      prompts: [
        { id: 'one', file: 'one.agent.md', type: 'agent' },
        { id: 'two', file: 'one.agent.md', type: 'agent' }
      ]
    } as unknown as ValidatedManifest;

    expect(() => createBundleInstallPlan(files, duplicateId)).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_DUPLICATE_ITEM_ID' })
    );
    expect(() => createBundleInstallPlan(files, duplicateOwnership)).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_DUPLICATE_OWNERSHIP' })
    );
  });

  it('rejects governed installable files that no item owns', () => {
    const files = createGovernedReleaseArchive();
    const validated = validateManifest(files, {});
    const manifest = {
      ...validated,
      items: []
    } as ValidatedManifest;

    expect(() => createBundleInstallPlan(files, manifest)).toThrowError(
      expect.objectContaining({
        code: 'BUNDLE.MANIFEST_UNCLAIMED_FILE',
        message: expect.stringContaining('prompts/hello.prompt.md')
      })
    );
  });

  it('rejects overlapping explicit skill roots', () => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['skills/reviewer/SKILL.md', new TextEncoder().encode('# Skill\n')],
      ['skills/reviewer/checklist.md', new TextEncoder().encode('# Checklist\n')]
    ]);
    const manifest = {
      id: 'test',
      version: '1',
      name: 'Test',
      prompts: [
        { id: 'reviewer', file: 'skills/reviewer/SKILL.md', type: 'skill' },
        { id: 'checklist', file: 'skills/reviewer/checklist.md', type: 'skill' }
      ]
    } as unknown as ValidatedManifest;

    expect(() => createBundleInstallPlan(files, manifest)).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_DUPLICATE_OWNERSHIP' })
    );
  });

  it('reports the deprecated paths used by identity-only legacy manifests', () => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['agents/reviewer.agent.md', new TextEncoder().encode('# Agent\n')]
    ]);
    const manifest = { id: 'test', version: '1', name: 'Test' } as ValidatedManifest;

    const plan = createBundleInstallPlan(files, manifest);

    expect(plan.legacyInferredPaths).toEqual(['agents/reviewer.agent.md']);
    expect(plan.items[0]).toMatchObject({ id: 'reviewer', kind: 'agent' });
  });

  it('ignores unknown root metadata in identity-only legacy manifests', () => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['README.md', new TextEncoder().encode('# Bundle documentation\n')],
      ['prompts/reviewer.prompt.md', new TextEncoder().encode('# Prompt\n')]
    ]);
    const manifest = { id: 'test', version: '1', name: 'Test' } as ValidatedManifest;

    const plan = createBundleInstallPlan(files, manifest);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: 'reviewer', kind: 'prompt' });
    expect(plan.legacyInferredPaths).toEqual(['prompts/reviewer.prompt.md']);
  });

  it('owns the complete skill tree inferred from an identity-only legacy manifest', () => {
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode('id: test\nversion: 1\nname: Test\n')],
      ['skills/reviewer/SKILL.md', new TextEncoder().encode('# Skill\n')],
      ['skills/reviewer/assets/rubric.json', new TextEncoder().encode('{"severity":"high"}\n')],
      ['skills/reviewer/scripts/check.sh', new TextEncoder().encode('#!/bin/sh\n')]
    ]);
    const manifest = { id: 'test', version: '1', name: 'Test' } as ValidatedManifest;

    const plan = createBundleInstallPlan(files, manifest);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      id: 'reviewer',
      kind: 'skill',
      entryPath: 'skills/reviewer/SKILL.md'
    });
    expect(plan.items[0].files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'assets/rubric.json',
      'scripts/check.sh'
    ]);
  });

  it('installs the identity-only manifest shape synthesized by the awesome-copilot resolver', () => {
    // Pins the constraint behind `createPlanFromLegacyPaths`: the in-repo
    // AwesomeCopilotBundleResolver (infra/src/resolvers/awesome-copilot-resolver.ts,
    // wired from cli/src/commands/install.ts) emits `id`/`version`/`name` only and
    // relies on source prefixes to classify collection items. Deleting the
    // identity-only fallback would silently install nothing for those sources.
    const files = new Map([
      [
        'deployment-manifest.yml',
        new TextEncoder().encode('id: my-collection\nversion: 0.0.0\nname: "My Collection"\n')
      ],
      ['prompts/refactor.prompt.md', new TextEncoder().encode('# Refactor\n')],
      ['instructions/style.instructions.md', new TextEncoder().encode('# Style\n')],
      ['skills/reviewer/SKILL.md', new TextEncoder().encode('# Skill\n')],
      ['collections/my-collection.collection.yml', new TextEncoder().encode('items: []\n')]
    ]);
    const manifest = { id: 'my-collection', version: '0.0.0', name: 'My Collection' } as ValidatedManifest;

    const plan = createBundleInstallPlan(files, manifest);

    expect(plan.items.map((item) => ({ id: item.id, kind: item.kind }))).toEqual([
      { id: 'refactor', kind: 'prompt' },
      { id: 'style', kind: 'instruction' },
      { id: 'reviewer', kind: 'skill' }
    ]);
    // The collection descriptor has no primitive prefix, so it is not installed.
    expect(plan.legacyInferredPaths).not.toContain('collections/my-collection.collection.yml');
  });
});
