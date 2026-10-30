import type {
  ReplicationCandidate,
} from '@ai-primitives-hub/core';
import AdmZip = require('adm-zip');
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
const manifestBytes = new TextEncoder().encode('id: sample-collection\nversion: 1.2.3\n');
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
    expect(files.has('.apm/deployment-manifest.yml')).toBe(false);
    expect(apmManifest).toContain('name: sample-collection');
    expect(apmManifest).toContain('version: 1.2.3');
    expect(apmManifest).toContain('x-aph:');
  });

  it('rejects source manifests that cannot produce an APM package', async () => {
    const unsupportedCandidate = {
      ...candidate,
      manifest: { ...manifest, items: [{ id: 'hook', kind: 'hook', path: 'hooks/pre-commit.sh' }] }
    };

    await expect(preparer.prepare(unsupportedCandidate, buildZip(rootFiles)))
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
