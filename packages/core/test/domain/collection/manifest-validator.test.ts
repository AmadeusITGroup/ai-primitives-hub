import {
  createHash,
} from 'node:crypto';
import {
  dump as dumpYaml,
} from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  getInstallableBundleFiles,
  isReleaseDeploymentManifest,
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

  it('accepts a versionless hub id when the source repo slug is given', () => {
    const manifest = validateManifest(
      filesWith('id: sample-skills\nversion: 1.8.1\nname: Sample Skills\n'),
      {
        expectedId: 'acme-org-sample-skills-sample-skills',
        sourceRepoSlug: 'acme-org/sample-skills'
      }
    );
    expect(manifest.id).toBe('sample-skills');
  });

  it('rejects another bundle name with BUNDLE.ID_MISMATCH even when the source repo slug is given', () => {
    expect(() => validateManifest(
      filesWith('id: other-bundle\nversion: 1.8.1\nname: Other\n'),
      {
        expectedId: 'acme-org-sample-skills-sample-skills',
        sourceRepoSlug: 'acme-org/sample-skills'
      }
    )).toThrowError(expect.objectContaining({
      code: 'BUNDLE.ID_MISMATCH',
      message: expect.stringContaining('"acme-org-sample-skills-sample-skills"')
    }));
  });

  it('keeps rejecting a versionless hub id when no source repo slug is given', () => {
    expect(() => validateManifest(
      filesWith('id: sample-skills\nversion: 1.8.1\nname: Sample Skills\n'),
      { expectedId: 'acme-org-sample-skills-sample-skills' }
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

  it('accepts a companion APM manifest as root metadata, not target content', () => {
    const files = filesWith('id: example\nversion: 1.0.0\nname: Example\n');
    files.set('apm.yml', bytes('name: example\nversion: 1.0.0\n'));
    files.set('.apm/instructions/rules.instructions.md', bytes('# Rules'));
    files.set('nested/apm.yml', bytes('not companion metadata'));

    const manifest = validateManifest(files, {});

    expect([...getInstallableBundleFiles(files, manifest).keys()]).toEqual([
      'deployment-manifest.yml',
      '.apm/instructions/rules.instructions.md',
      'nested/apm.yml'
    ]);
  });

  it('uses the root copy of a primitive when its APM mirror is also present', () => {
    const files = filesWith('id: example\nversion: 1.0.0\nname: Example\n');
    files.set('agents/shared.agent.md', bytes('root copy'));
    files.set('.apm/agents/shared.agent.md', bytes('APM mirror'));
    files.set('.apm/agents/apm-only.agent.md', bytes('APM-only file'));

    const manifest = validateManifest(files, {});

    expect([...getInstallableBundleFiles(files, manifest).keys()]).toEqual([
      'deployment-manifest.yml',
      'agents/shared.agent.md',
      '.apm/agents/apm-only.agent.md'
    ]);
  });

  it('does not silently drop a legacy primitive that claims the companion metadata path', () => {
    const files = filesWith([
      'id: example',
      'version: 1.0.0',
      'name: Example',
      'prompts:',
      '  - id: invalid',
      '    file: apm.yml',
      '    type: instructions'
    ].join('\n'));
    files.set('apm.yml', bytes('name: example\nversion: 1.0.0\n'));

    expect(() => validateManifest(files, {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it.each([
    '[]',
    'name: [invalid\n',
    'name: example\n',
    'name: other\nversion: 1.0.0\n',
    'name: example\nversion: 2.0.0\n'
  ])('rejects invalid or inconsistent companion APM metadata: %s', (apmYaml) => {
    const files = filesWith('id: example\nversion: 1.0.0\nname: Example\n');
    files.set('apm.yml', bytes(apmYaml));

    expect(() => validateManifest(files, {})).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
    );
  });

  it.each(['metadata', 'installable', 'ignored'] as const)('requires the governed companion to have metadata role, not %s', (role) => {
    const files = createGovernedReleaseArchive();
    const manifest = validateManifest(files, {});
    if (!isReleaseDeploymentManifest(manifest)) {
      throw new Error('Expected governed fixture');
    }
    const content = bytes('name: governed-bundle\nversion: 1.0.0\n');
    files.set('apm.yml', content);
    files.set('deployment-manifest.yml', bytes(dumpYaml({
      ...manifest,
      files: [...manifest.files, {
        path: 'apm.yml',
        role,
        size: content.byteLength,
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`
      }]
    })));

    if (role === 'metadata') {
      const validated = validateManifest(files, {});
      expect(getInstallableBundleFiles(files, validated).has('apm.yml')).toBe(false);
    } else {
      expect(() => validateManifest(files, {})).toThrowError(
        expect.objectContaining({ code: 'BUNDLE.MANIFEST_INVALID' })
      );
    }
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
