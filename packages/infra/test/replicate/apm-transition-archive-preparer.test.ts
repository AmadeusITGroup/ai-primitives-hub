import {
  createHash,
} from 'node:crypto';
import type {
  ReplicationCandidate,
} from '@ai-primitives-hub/core';
import {
  serializeReleaseManifest,
  validateManifest,
} from '@ai-primitives-hub/core';
import AdmZip = require('adm-zip');
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ApmTransitionArchivePreparer,
} from '../../src/replicate/apm-transition-archive-preparer';
import {
  buildZip,
} from '../../src/writers/zip-writer';

const manifest = {
  id: 'sample-collection',
  version: '1.2.3',
  name: 'Sample collection',
  description: 'A sample bundle',
  author: 'Amadeus',
  license: 'Apache-2.0',
  repository: 'https://github.com/acme/sample-repo',
  tags: ['sample'],
  items: [{
    id: 'sample-instructions',
    kind: 'instruction',
    path: 'instructions/sample.instructions.md'
  }]
};
const manifestBytes = new TextEncoder().encode(serializeReleaseManifest(manifest));
const candidate: ReplicationCandidate = {
  sourceId: 'sample-source',
  repo: 'acme/sample-repo',
  tag: 'v1.2.3',
  publishedAt: '',
  releaseName: 'sample-collection-v1.2.3',
  manifest,
  manifestBytes,
  manifestName: 'deployment-manifest.yml',
  archiveUrl: 'https://github.com/acme/sample-repo/releases/download/v1.2.3/sample.zip',
  archiveSize: 1,
  version: '1.2.3',
  bundleId: 'acme-sample-repo-sample-collection'
};
const rootFiles = [
  { path: 'deployment-manifest.yml', bytes: manifestBytes },
  { path: 'instructions/sample.instructions.md', bytes: new TextEncoder().encode('Follow the sample rules.') },
  { path: 'README.md', bytes: new TextEncoder().encode('# Sample') }
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function manifestFilePaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error('Expected a manifest with a files inventory.');
  }
  return value.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw new Error('Expected a manifest file record with a path.');
    }
    return file.path;
  });
}

describe('ApmTransitionArchivePreparer', () => {
  const preparer = new ApmTransitionArchivePreparer();

  it('passes through an APM-ready archive byte-for-byte', async () => {
    const apmManifest = new TextEncoder().encode([
      'name: sample-collection',
      'version: 1.2.3',
      'description: A sample bundle',
      'dependencies:',
      '  apm: []',
      '  mcp: []',
      'includes: auto',
      ''
    ].join('\n'));
    const archive = buildZip([
      ...rootFiles,
      { path: 'apm.yml', bytes: apmManifest },
      { path: '.apm/instructions/sample.instructions.md', bytes: new TextEncoder().encode('Follow the sample rules.') }
    ]);

    const result = await preparer.prepare(candidate, archive);

    expect(result.translated).toBe(false);
    expect(result.packageName).toBe('sample-collection');
    expect(result.bytes).toEqual(archive);
  });

  it('rejects an APM-ready archive when its candidate manifest version differs from the release', async () => {
    const apmManifest = new TextEncoder().encode([
      'name: sample-collection',
      'version: 1.2.3',
      'dependencies:',
      '  apm: []',
      '  mcp: []',
      ''
    ].join('\n'));
    const archive = buildZip([
      ...rootFiles,
      { path: 'apm.yml', bytes: apmManifest },
      { path: '.apm/instructions/sample.instructions.md', bytes: new TextEncoder().encode('Follow the sample rules.') }
    ]);

    await expect(preparer.prepare({
      ...candidate,
      manifest: { ...manifest, version: '9.9.9' }
    }, archive)).rejects.toThrow(/mismatched release version/i);
  });

  it('adds an APM manifest and .apm copies without removing APH files', async () => {
    const sourceArchive = buildZip(rootFiles);
    const result = await preparer.prepare(candidate, sourceArchive);
    const zip = new AdmZip(Buffer.from(result.bytes));
    const files = new Map(zip.getEntries().map((entry) => [entry.entryName, entry.getData()]));
    const apmManifest = new TextDecoder().decode(files.get('apm.yml'));

    expect(result.translated).toBe(true);
    expect(result.packageName).toBe('sample-collection');
    expect(files.get('instructions/sample.instructions.md')).toEqual(Buffer.from(rootFiles[1].bytes));
    expect(files.get('.apm/instructions/sample.instructions.md')).toEqual(Buffer.from(rootFiles[1].bytes));
    expect(files.get('.apm/README.md')).toEqual(Buffer.from(rootFiles[2].bytes));
    expect(files.get('deployment-manifest.yml')).toEqual(Buffer.from(manifestBytes));
    expect(validateManifest(files, {}).id).toBe('sample-collection');
    expect(files.has('.apm/deployment-manifest.yml')).toBe(false);
    expect(apmManifest).toContain('name: sample-collection');
    expect(apmManifest).toContain('version: 1.2.3');
    expect(apmManifest).toContain('x-aph:');
  });

  it.each([
    ['prompt', 'prompts/team/review.prompt.md'],
    ['instruction', 'instructions/team/rules.instructions.md'],
    ['skill', 'skills/team/example/SKILL.md']
  ])('warns when translating a nested %s outside native APM discovery paths', async (kind, path) => {
    const nestedManifest = {
      ...manifest,
      items: [{ id: 'nested-primitive', kind, path }]
    };
    const nestedManifestBytes = new TextEncoder().encode(serializeReleaseManifest(nestedManifest));
    const nestedCandidate = {
      ...candidate,
      manifest: nestedManifest,
      manifestBytes: nestedManifestBytes
    };
    const archive = buildZip([
      ...rootFiles.filter((file) => file.path !== 'deployment-manifest.yml'),
      { path: 'deployment-manifest.yml', bytes: nestedManifestBytes },
      { path, bytes: new TextEncoder().encode('Nested primitive content.') }
    ]);

    const result = await preparer.prepare(nestedCandidate, archive);

    expect(result.warnings).toEqual([
      expect.stringContaining(`.apm/${path}`)
    ]);
  });

  it.each(['unchanged', 'modified', 'missing'])('validates %s governed payload before regenerating inventories', async (scenario) => {
    const payload = [
      { ...rootFiles[1], role: 'installable' },
      { ...rootFiles[2], role: 'metadata' },
      { path: 'LICENSE', bytes: new TextEncoder().encode('Example license.'), role: 'metadata' },
      {
        path: 'metadata/source/collections/example.collection.yml',
        bytes: new TextEncoder().encode('id: sample-collection\n'),
        role: 'metadata'
      }
    ];
    const governedManifest = {
      ...manifest,
      formatVersion: 1,
      readme: 'README.md',
      files: payload.map(({ path, bytes, role }) => ({
        path,
        role,
        size: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      })),
      provenance: {
        source: 'https://github.com/acme/sample-repo.git',
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
        collectionPath: 'collections/example.collection.yml',
        sourceSnapshotPath: 'metadata/source/collections/example.collection.yml',
        license: 'Apache-2.0',
        licensePath: 'LICENSE'
      }
    };
    const governedManifestBytes = new TextEncoder().encode(serializeReleaseManifest(governedManifest));
    const archivePayload = payload
      .filter((file) => scenario !== 'missing' || file.path !== 'LICENSE')
      .map(({ path, bytes }) => ({
        path,
        bytes: scenario === 'modified' && path === rootFiles[1].path
          ? new TextEncoder().encode('X'.repeat(bytes.byteLength))
          : bytes
      }));
    const archive = buildZip([
      { path: 'deployment-manifest.yml', bytes: governedManifestBytes },
      ...archivePayload
    ]);

    if (scenario !== 'unchanged') {
      await expect(preparer.prepare({
        ...candidate,
        manifest: governedManifest,
        manifestBytes: governedManifestBytes
      }, archive)).rejects.toThrow(scenario === 'modified' ? /sha256/i : /missing from the archive/i);
      return;
    }

    const result = await preparer.prepare({
      ...candidate,
      manifest: governedManifest,
      manifestBytes: governedManifestBytes
    }, archive);
    const zip = new AdmZip(Buffer.from(result.bytes));
    const files = new Map(zip.getEntries().map((entry) => [entry.entryName, entry.getData()]));
    const rootManifest = yaml.load(new TextDecoder().decode(files.get('deployment-manifest.yml')));
    const apmManifest = yaml.load(new TextDecoder().decode(files.get('apm.yml')));
    const embeddedManifest = isRecord(apmManifest) ? apmManifest['x-aph'] : undefined;

    expect(validateManifest(files, {}).id).toBe('sample-collection');
    expect(manifestFilePaths(rootManifest)).toContain('apm.yml');
    expect(manifestFilePaths(embeddedManifest))
      .toContain('.apm/instructions/sample.instructions.md');
    expect(manifestFilePaths(embeddedManifest)).not.toContain('apm.yml');
  });

  it('rejects APM-ready archives without a root deployment manifest', async () => {
    const archive = buildZip([
      { path: 'apm.yml', bytes: new TextEncoder().encode(serializeReleaseManifest({
        name: manifest.id,
        version: manifest.version,
        dependencies: { apm: [], mcp: [] },
        includes: 'auto'
      })) },
      { path: '.apm/instructions/sample.instructions.md', bytes: rootFiles[1].bytes }
    ]);

    await expect(preparer.prepare(candidate, archive)).rejects.toThrow(/deployment-manifest\.yml/);
  });

  it.each(['invalid', ['.apm/instructions/sample.instructions.md', 123]].map((includes) => ({ includes })))('rejects APM-ready archives with invalid includes $includes', async ({ includes }) => {
    const archive = buildZip([
      ...rootFiles,
      { path: 'apm.yml', bytes: new TextEncoder().encode(serializeReleaseManifest({
        name: manifest.id,
        version: manifest.version,
        dependencies: { apm: [], mcp: [] },
        includes
      })) },
      { path: '.apm/instructions/sample.instructions.md', bytes: rootFiles[1].bytes }
    ]);

    await expect(preparer.prepare(candidate, archive)).rejects.toThrow(/apm\.yml includes/);
  });

  it('embeds a valid standalone deployment manifest when translating a legacy archive', async () => {
    const archive = buildZip(rootFiles.filter((file) => file.path !== 'deployment-manifest.yml'));

    const result = await preparer.prepare(candidate, archive);
    const zip = new AdmZip(Buffer.from(result.bytes));
    const files = new Map(zip.getEntries().map((entry) => [entry.entryName, entry.getData()]));

    expect(result.translated).toBe(true);
    expect(validateManifest(files, {}).id).toBe(manifest.id);
    expect(files.get('deployment-manifest.yml')).toEqual(Buffer.from(manifestBytes));
  });

  it('rejects source manifests that cannot produce an APM package', async () => {
    const unsupportedManifest = { ...manifest, items: [{ id: 'hook', kind: 'hook', path: 'hooks/pre-commit.sh' }] };
    const unsupportedManifestBytes = new TextEncoder().encode(serializeReleaseManifest(unsupportedManifest));
    const unsupportedCandidate = {
      ...candidate,
      manifest: unsupportedManifest,
      manifestBytes: unsupportedManifestBytes
    };

    await expect(preparer.prepare(unsupportedCandidate, buildZip([
      ...rootFiles.filter((file) => file.path !== 'deployment-manifest.yml'),
      { path: 'deployment-manifest.yml', bytes: unsupportedManifestBytes }
    ])))
      .rejects.toThrow(/does not support|requires at least one supported primitive/i);
  });

  it('rejects invalid archives instead of publishing them unchanged', async () => {
    await expect(preparer.prepare(candidate, new Uint8Array([1, 2, 3])))
      .rejects.toThrow(/valid ZIP/i);
  });

  it('classifies duplicate ZIP paths as unsupported APM content', async () => {
    const archive = buildZip([
      ...rootFiles,
      { path: 'instructions/sample.instructions.md', bytes: new TextEncoder().encode('duplicate') }
    ]);

    await expect(preparer.prepare(candidate, archive)).rejects.toMatchObject({
      code: 'BUNDLE.APM_UNSUPPORTED_CONTENT'
    });
  });
});
