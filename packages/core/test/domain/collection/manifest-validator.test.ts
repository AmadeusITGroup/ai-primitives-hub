import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  getInstallableBundleFiles,
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
