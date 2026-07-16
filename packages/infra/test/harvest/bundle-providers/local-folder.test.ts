/**
 * Direct unit tests for LocalFolderBundleProvider's own BundleProvider
 * surface (listBundles/readManifest/readFile). Deliberately does not
 * route through `harvest()` (see `harvester.ts`, ported separately) —
 * keeps this test scoped to the provider itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalFolderBundleProvider,
} from '../../../src/harvest/bundle-providers/local-folder';
import {
  createTempDir,
} from '../../helpers/temp-dir';

function writeBundle(root: string, id: string): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'deployment-manifest.yml'),
    `id: ${id}
version: 1.0.0
name: ${id}
description: test
tags: [test]
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`,
    'utf8'
  );
  fs.mkdirSync(path.join(dir, 'prompts'));
  fs.writeFileSync(
    path.join(dir, 'prompts', 'hello.prompt.md'),
    '---\ntitle: Hello\ndescription: says hello\ntags: [greeting]\n---\n\n# Hello\n',
    'utf8'
  );
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

describe('LocalFolderBundleProvider', () => {
  let tmp: string;
  let cleanup: () => void;
  beforeEach(() => {
    [tmp, cleanup] = createTempDir('pi-local-');
  });
  afterEach(() => {
    cleanup();
  });

  it('lists one bundle ref per subfolder containing a manifest', async () => {
    writeBundle(tmp, 'b1');
    writeBundle(tmp, 'b2');
    const provider = new LocalFolderBundleProvider({ root: tmp, sourceId: 'local' });
    const refs = await collect(provider.listBundles());
    expect(refs.map((r) => r.bundleId).toSorted()).toStrictEqual(['b1', 'b2']);
    expect(refs.every((r) => r.sourceId === 'local')).toBe(true);
    expect(refs.every((r) => r.sourceType === 'local')).toBe(true);
    expect(refs.every((r) => r.installed)).toBe(true);
    expect(refs.every((r) => r.bundleVersion === '1.0.0')).toBe(true);
  });

  it('skips subfolders without a recognised manifest', async () => {
    writeBundle(tmp, 'b1');
    fs.mkdirSync(path.join(tmp, 'not-a-bundle'));
    const provider = new LocalFolderBundleProvider({ root: tmp });
    const refs = await collect(provider.listBundles());
    expect(refs.map((r) => r.bundleId)).toStrictEqual(['b1']);
  });

  it('returns no bundles when the root does not exist', async () => {
    const provider = new LocalFolderBundleProvider({ root: path.join(tmp, 'missing') });
    const refs = await collect(provider.listBundles());
    expect(refs).toStrictEqual([]);
  });

  it('defaults sourceId to the root folder basename and sourceType to "local"', async () => {
    writeBundle(tmp, 'b1');
    const provider = new LocalFolderBundleProvider({ root: tmp });
    const [ref] = await collect(provider.listBundles());
    expect(ref.sourceId).toBe(path.basename(tmp));
    expect(ref.sourceType).toBe('local');
  });

  it('readManifest parses the YAML manifest for a given bundle ref', async () => {
    writeBundle(tmp, 'b1');
    const provider = new LocalFolderBundleProvider({ root: tmp, sourceId: 'local' });
    const ref = { sourceId: 'local', sourceType: 'local', bundleId: 'b1', bundleVersion: '1.0.0', installed: true };
    const manifest = await provider.readManifest(ref);
    expect(manifest.id).toBe('b1');
    expect(manifest.name).toBe('b1');
    expect(manifest.tags).toStrictEqual(['test']);
  });

  it('readManifest throws when no manifest exists for the bundle', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'));
    const provider = new LocalFolderBundleProvider({ root: tmp });
    const ref = { sourceId: 'x', sourceType: 'local', bundleId: 'empty', bundleVersion: 'latest', installed: true };
    await expect(provider.readManifest(ref)).rejects.toThrow(/no manifest found/i);
  });

  it('readFile returns the raw file content relative to the bundle root', async () => {
    writeBundle(tmp, 'b1');
    const provider = new LocalFolderBundleProvider({ root: tmp });
    const ref = { sourceId: 'x', sourceType: 'local', bundleId: 'b1', bundleVersion: '1.0.0', installed: true };
    const content = await provider.readFile(ref, 'prompts/hello.prompt.md');
    expect(content).toContain('title: Hello');
  });

  it('rejects path traversal on readFile', async () => {
    writeBundle(tmp, 'b1');
    const provider = new LocalFolderBundleProvider({ root: tmp });
    await expect(
      provider.readFile(
        { sourceId: 'x', sourceType: 'local', bundleId: 'b1', bundleVersion: '1.0.0', installed: true },
        '../secret.txt'
      )
    ).rejects.toThrow();
  });
});
