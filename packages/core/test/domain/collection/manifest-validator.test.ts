import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  getInstallableBundleFiles,
  getManifestPlacementItems,
  getTargetInstallableBundleFiles,
  ManifestValidationError,
  validateManifest,
} from '../../../src/domain/collection/manifest-validator';
import type {
  ExtractedFiles,
} from '../../../src/ports/bundle-extractor';
import {
  createGovernedReleaseArchive,
  createLegacyReleaseArchive,
} from '../../fixtures/release-archives';

const filesWith = (yaml: string): ExtractedFiles => new Map([
  ['deployment-manifest.yml', new TextEncoder().encode(yaml)]
]);

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

describe('validateManifest', () => {
  it('returns the parsed manifest when id/version/name are present and nothing is expected', () => {
    const manifest = validateManifest(
      filesWith('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n'),
      {}
    );

    expect(manifest).toMatchObject({ id: 'my-bundle', version: '1.0.0', name: 'My Bundle' });
  });

  it('throws BUNDLE.MANIFEST_MISSING when deployment-manifest.yml is absent', () => {
    expect(() => validateManifest(new Map(), {})).toThrow(ManifestValidationError);
    try {
      validateManifest(new Map(), {});
      expect.unreachable();
    } catch (err) {
      expect((err as ManifestValidationError).code).toBe('BUNDLE.MANIFEST_MISSING');
    }
  });

  it('throws BUNDLE.MANIFEST_INVALID when the file is not valid YAML', () => {
    expect(() => validateManifest(filesWith(':\n  - not: [valid'), {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it('throws BUNDLE.MANIFEST_INVALID when the YAML is not a mapping', () => {
    expect(() => validateManifest(filesWith('- just\n- a\n- list\n'), {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it.each(['id', 'version', 'name'])('throws BUNDLE.MANIFEST_INVALID when "%s" is missing', (field) => {
    const fields = { id: 'my-bundle', version: '1.0.0', name: 'My Bundle' } as Record<string, string>;
    delete fields[field];
    const yaml = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');

    expect(() => validateManifest(filesWith(yaml), {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it('accepts an exact id match against expectedId', () => {
    const manifest = validateManifest(
      filesWith('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n'),
      { expectedId: 'my-bundle' }
    );

    expect(manifest.id).toBe('my-bundle');
  });

  it('accepts a suffix-tolerant id match for GitHub collection bundles', () => {
    const manifest = validateManifest(
      filesWith('id: test2\nversion: 1.0.2\nname: Test Collection\n'),
      { expectedId: 'owner-repo-test2-v1.0.2' }
    );

    expect(manifest.id).toBe('test2');
  });

  it('throws BUNDLE.ID_MISMATCH when the manifest id is unrelated to expectedId', () => {
    expect(() => validateManifest(
      filesWith('id: completely-different\nversion: 1.0.0\nname: My Bundle\n'),
      { expectedId: 'owner-repo-test2-v1.0.0' }
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.ID_MISMATCH' }));
  });

  it('throws BUNDLE.VERSION_MISMATCH when the version does not match expectedVersion', () => {
    expect(() => validateManifest(
      filesWith('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n'),
      { expectedVersion: '2.0.0' }
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.VERSION_MISMATCH' }));
  });

  it('accepts any version when expectedVersion is "latest"', () => {
    const manifest = validateManifest(
      filesWith('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n'),
      { expectedVersion: 'latest' }
    );

    expect(manifest.version).toBe('1.0.0');
  });

  it('keeps every legacy archive entry available to compatibility writers', () => {
    const files = createLegacyReleaseArchive({ id: 'legacy-bundle' });

    const manifest = validateManifest(files, {});

    expect(manifest.formatVersion).toBeUndefined();
    expect([...getInstallableBundleFiles(files, manifest).keys()]).toEqual([...files.keys()]);
  });

  it('normalizes canonical and legacy placement declarations without processing both copies', () => {
    const canonical = getManifestPlacementItems({
      formatVersion: 1,
      items: [{ id: 'canonical', path: 'specifications/guide.md', kind: 'knowledge' }],
      prompts: [{ id: 'legacy', file: 'specifications/legacy-only.md', type: 'knowledge' }]
    });
    expect(canonical).toEqual([{ id: 'canonical', file: 'specifications/guide.md', type: 'knowledge' }]);

    const legacyPrompts = getManifestPlacementItems({
      items: [{ id: 'canonical', path: 'prompts/guide.prompt.md', kind: 'prompt' }],
      prompts: [{ id: 'legacy', file: 'prompts/guide.prompt.md', type: 'prompt' }]
    });
    expect(legacyPrompts).toEqual([{ id: 'legacy', file: 'prompts/guide.prompt.md', type: 'prompt' }]);

    expect(getManifestPlacementItems({
      items: [{ id: 'items-only', path: 'prompts/items-only.prompt.md', kind: 'prompt' }]
    })).toEqual([{ id: 'items-only', file: 'prompts/items-only.prompt.md', type: 'prompt' }]);
  });

  it('validates a fully governed release and exposes only installable files', () => {
    const files = createGovernedReleaseArchive({ id: 'governed-bundle' });

    const manifest = validateManifest(files, {});

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.items).toEqual([{
      id: 'hello',
      path: 'prompts/hello.prompt.md',
      kind: 'prompt'
    }]);
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', role: 'metadata' }),
      expect.objectContaining({ path: 'LICENSE', role: 'metadata' }),
      expect.objectContaining({ path: 'ignored/build/cache.pyc', role: 'ignored' })
    ]));
    expect([...getInstallableBundleFiles(files, manifest).keys()]).toEqual([
      'deployment-manifest.yml',
      'prompts/hello.prompt.md'
    ]);
  });

  it('projects declared governed knowledge files to canonical virtual paths', () => {
    const files = createGovernedReleaseArchive({ includeKnowledge: true });
    const manifest = validateManifest(files, {});

    const targetFiles = getTargetInstallableBundleFiles(files, manifest);

    expect([...targetFiles.keys()]).toEqual([
      'deployment-manifest.yml',
      'prompts/hello.prompt.md',
      'knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md'
    ]);
    expect(targetFiles.get('knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md'))
      .toEqual(files.get('specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md'));
  });

  it('retains embedded knowledge sources as skill assets while projecting standalone knowledge', () => {
    const files = createGovernedReleaseArchive({ includeSkillKnowledge: true });
    const manifest = validateManifest(files, {});

    const targetFiles = getTargetInstallableBundleFiles(files, manifest);

    expect(targetFiles.get('skills/knowledge-skill/SKILL.md')).toEqual(files.get('skills/knowledge-skill/SKILL.md'));
    expect(targetFiles.get('skills/knowledge-skill/knowledge/guide.md'))
      .toEqual(files.get('skills/knowledge-skill/knowledge/guide.md'));
    expect(targetFiles.get('knowledge/skills/knowledge-skill/knowledge/guide.md'))
      .toEqual(files.get('skills/knowledge-skill/knowledge/guide.md'));
  });

  it('rejects legacy knowledge declarations without a string source path', () => {
    const malformedFiles = filesWith(`id: malformed-legacy
version: 1.0.0
name: Legacy
prompts:
  - id: guide
    type: knowledge
`);

    expect(() => {
      const manifest = validateManifest(malformedFiles, {});
      getTargetInstallableBundleFiles(malformedFiles, manifest);
    }).toThrow(ManifestValidationError);
  });

  it('selects legacy prompts first, adds distinct items, and deduplicates by canonical kind', () => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes(`id: legacy-dual
version: 1.0.0
name: Legacy Dual
prompts:
  - id: prompt-shared
    file: prompts/shared.md
    type: prompt
  - id: prompt-agent-wins
    file: agents/review.md
    type: chat-mode
  - id: prompt-guide
    file: specifications/prompts-guide.md
    type: knowledge
  - id: prompt-wins
    file: specifications/duplicate-guide.md
    type: knowledge
items:
  - id: item-guide
    path: specifications/items-guide.md
    kind: knowledge
  - path: specifications/idless-guide.md
    kind: knowledge
  - id: item-shared
    path: prompts/shared.md
    kind: prompt
  - id: item-agent-duplicate
    path: agents/review.md
    kind: chatmode
  - id: item-loses
    path: specifications/duplicate-guide.md
    kind: knowledge
`)],
      ['prompts/shared.md', bytes('# Shared prompt')],
      ['agents/review.md', bytes('# Review agent')],
      ['specifications/prompts-guide.md', bytes('# Prompt knowledge')],
      ['specifications/duplicate-guide.md', bytes('# Duplicate source')],
      ['specifications/items-guide.md', bytes('# Item knowledge')],
      ['specifications/idless-guide.md', bytes('# ID-less knowledge')]
    ]);
    const manifest = validateManifest(files, {});

    const placements = getManifestPlacementItems(manifest as Record<string, unknown>);
    expect(placements).toEqual([
      { id: 'prompt-shared', file: 'prompts/shared.md', type: 'prompt' },
      { id: 'prompt-agent-wins', file: 'agents/review.md', type: 'chat-mode' },
      { id: 'prompt-guide', file: 'specifications/prompts-guide.md', type: 'knowledge' },
      { id: 'prompt-wins', file: 'specifications/duplicate-guide.md', type: 'knowledge' },
      { id: 'item-guide', file: 'specifications/items-guide.md', type: 'knowledge' }
    ]);

    const targetFiles = getTargetInstallableBundleFiles(files, manifest);
    expect(targetFiles.get('knowledge/specifications/prompts-guide.md')).toEqual(bytes('# Prompt knowledge'));
    expect(targetFiles.get('knowledge/specifications/duplicate-guide.md')).toEqual(bytes('# Duplicate source'));
    expect(targetFiles.get('knowledge/specifications/items-guide.md')).toEqual(bytes('# Item knowledge'));
    expect(targetFiles.get('knowledge/specifications/idless-guide.md')).toEqual(bytes('# ID-less knowledge'));
  });

  it('uses canonical items only for versioned manifests even when legacy prompts differ', () => {
    expect(getManifestPlacementItems({
      formatVersion: 1,
      items: [{ id: 'canonical', path: 'prompts/canonical.md', kind: 'prompt' }],
      prompts: [{ id: 'legacy', file: 'specifications/legacy-only.md', type: 'knowledge' }]
    })).toEqual([{ id: 'canonical', file: 'prompts/canonical.md', type: 'prompt' }]);

    const files = createGovernedReleaseArchive({ includeKnowledge: true });
    const manifest = validateManifest(files, {});
    const manifestWithDifferentLegacyProjection = {
      ...manifest,
      prompts: [{ id: 'legacy-only', file: 'specifications/legacy-only.md', type: 'knowledge' }]
    } as typeof manifest;
    const targetFiles = getTargetInstallableBundleFiles(files, manifestWithDifferentLegacyProjection);

    expect(targetFiles.has('knowledge/specifications/legacy-only.md')).toBe(false);
    expect(targetFiles.has('knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md')).toBe(true);
  });

  it('projects legacy items-only knowledge declarations', () => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes('id: legacy\nversion: 1.0.0\nname: Legacy\nitems:\n  - id: guide\n    path: documentation/guide.md\n    kind: knowledge\n')],
      ['documentation/guide.md', bytes('# Guide')]
    ]);
    const manifest = validateManifest(files, {});

    expect(getTargetInstallableBundleFiles(files, manifest).get('knowledge/documentation/guide.md'))
      .toEqual(bytes('# Guide'));
  });

  it.each([
    ['knowledge/guide.md', 'knowledge/guide.md'],
    ['.github/knowledge/guide.md', 'knowledge/guide.md'],
    ['specifications/guide.md', 'knowledge/specifications/guide.md']
  ])('projects the knowledge source form %s to %s', (sourcePath, targetPath) => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes(`id: legacy\nversion: 1.0.0\nname: Legacy\nprompts:\n  - id: guide\n    file: ${sourcePath}\n    type: knowledge\n`)],
      [sourcePath, bytes('# Guide')]
    ]);
    const manifest = validateManifest(files, {});

    expect(getTargetInstallableBundleFiles(files, manifest).get(targetPath)).toEqual(bytes('# Guide'));
  });

  it('does not route legacy knowledge files that are not declared in the manifest', () => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes('id: legacy\nversion: 1.0.0\nname: Legacy\nprompts:\n  - id: prompt\n    file: prompts/hello.md\n    type: prompt\n')],
      ['prompts/hello.md', bytes('# Prompt')],
      ['knowledge/unlisted.md', bytes('# Unlisted')],
      ['specifications/unlisted.md', bytes('# Source')]
    ]);
    const manifest = validateManifest(files, {});

    const targetFiles = getTargetInstallableBundleFiles(files, manifest);

    expect(targetFiles.has('knowledge/unlisted.md')).toBe(false);
    expect(targetFiles.has('specifications/unlisted.md')).toBe(true);
  });

  it('projects legacy knowledge declarations without copying undeclared source files', () => {
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes('id: legacy\nversion: 1.0.0\nname: Legacy\nprompts:\n  - id: guide\n    file: specifications/guide.md\n    type: knowledge\n')],
      ['specifications/guide.md', bytes('# Guide')],
      ['specifications/unlisted.md', bytes('# Unlisted')]
    ]);
    const manifest = validateManifest(files, {});

    const targetFiles = getTargetInstallableBundleFiles(files, manifest);

    expect(targetFiles.get('knowledge/specifications/guide.md')).toEqual(bytes('# Guide'));
    expect(targetFiles.get('specifications/unlisted.md')).toEqual(bytes('# Unlisted'));
  });

  it.each(['../outside.md', '/outside.md', 'C:/outside.md', 'C:\\\\outside.md']) (
    'rejects an unsafe declared knowledge path %s', (filePath) => {
      const files = new Map<string, Uint8Array>([
        ['deployment-manifest.yml', bytes(`id: legacy\nversion: 1.0.0\nname: Legacy\nprompts:\n  - id: guide\n    file: ${filePath}\n    type: knowledge\n`)],
        [filePath, bytes('# Guide')]
      ]);
      const manifest = validateManifest(files, {});

      expect(() => getTargetInstallableBundleFiles(files, manifest)).toThrow();
    }
  );

  it('rejects missing declared knowledge files and aliases from distinct source paths', () => {
    const missingFiles = filesWith('id: legacy\nversion: 1.0.0\nname: Legacy\nprompts:\n  - id: guide\n    file: specifications/guide.md\n    type: knowledge\n');
    const missingManifest = validateManifest(missingFiles, {});
    expect(() => getTargetInstallableBundleFiles(missingFiles, missingManifest)).toThrow();

    const aliasedFiles = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', bytes(`id: legacy
version: 1.0.0
name: Legacy
prompts:
  - id: first
    file: knowledge/guide.md
    type: knowledge
  - id: second
    file: .github/knowledge/guide.md
    type: knowledge
`)],
      ['knowledge/guide.md', bytes('# First')],
      ['.github/knowledge/guide.md', bytes('# Second')]
    ]);
    const aliasedManifest = validateManifest(aliasedFiles, {});
    expect(() => getTargetInstallableBundleFiles(aliasedFiles, aliasedManifest)).toThrow();
  });

  it('rejects a versioned manifest when archive content is not declared in its inventory', () => {
    const malformed = new Map(createGovernedReleaseArchive());
    malformed.set('unexpected.txt', bytes('not declared'));

    expect(() => validateManifest(malformed, {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it('rejects a versioned manifest when an inventoried file is tampered with', () => {
    const malformed = new Map(createGovernedReleaseArchive());
    malformed.set('prompts/hello.prompt.md', bytes('# Tampered\n'));

    expect(() => validateManifest(malformed, {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });
});
