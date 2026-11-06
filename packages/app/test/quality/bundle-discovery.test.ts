import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  discoverBundles,
} from '../../src/quality';

const COLLECTION = `id: py-dev
name: Python
description: d
version: 2.1.0
author: Team
tags: [python, testing]
items:
  - path: prompts/a.prompt.md
    kind: prompt
  - path: skills/lint/SKILL.md
    kind: skill
  - path: ../outside.md
    kind: prompt
  - path: prompts/missing.prompt.md
    kind: prompt
readme:
  path: docs/py/readme.md
mcp:
  items:
    srv: { command: node }
`;

const write = (root: string, relative: string, text = 'x'): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};

describe('discoverBundles', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-bundles-'));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
    write(root, 'collections/py-dev.collection.yml', COLLECTION);
    write(root, 'collections/broken.collection.yml', 'id: [unclosed');
    write(root, 'collections/no-id.collection.yml', 'name: x\nitems: []\n');
    for (const file of ['prompts/a.prompt.md', 'skills/lint/SKILL.md', 'skills/lint/ref/notes.md', 'docs/py/readme.md', 'prompts/unlisted.prompt.md', 'src/vendored.js']) {
      write(root, file);
    }
    write(base, 'outside.md', 'secret');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('turns a collection into a bundle holding only the files it lists', () => {
    const result = discoverBundles(root, { repository: 'o/r' });
    expect(result.mode).toBe('collections');
    expect(result.bundles.map((bundle) => bundle.id)).toEqual(['py-dev']);
    expect(result.bundles[0].files.toSorted()).toEqual([
      'collections/py-dev.collection.yml',
      'docs/py/readme.md',
      'prompts/a.prompt.md',
      'skills/lint/SKILL.md',
      'skills/lint/ref/notes.md'
    ]);
  });

  it('describes the bundle from its collection', () => {
    const [bundle] = discoverBundles(root, { repository: 'o/r' }).bundles;
    expect(bundle.version).toBe('2.1.0');
    expect(bundle.metadata).toEqual({ author: 'Team', kind: { 'mcp-server': 1, prompt: 1, skill: 1 }, labels: ['python', 'testing'] });
  });

  it('warns about paths outside the repository or missing instead of scanning them', () => {
    const result = discoverBundles(root, { repository: 'o/r' });
    expect(result.warnings.toSorted()).toEqual([
      'collections/py-dev.collection.yml: item not found or outside the repository: ../outside.md',
      'collections/py-dev.collection.yml: item not found or outside the repository: prompts/missing.prompt.md'
    ]);
    expect(result.bundles[0].files).not.toContain('../outside.md');
  });

  it('does not let a collections path escape the repository', () => {
    // The escaping path is ignored, so discovery falls through to the skill folders.
    expect(discoverBundles(root, { repository: 'o/r', collectionsPath: '..' }).mode).toBe('skills');
    expect(discoverBundles(root, { repository: 'o/r', collectionsPath: '../..' }).bundles.map((bundle) => bundle.id))
      .toEqual(['skills-o-r-lint']);
  });

  it('uses skills only when there are no collections, with the extension-style id', () => {
    for (const name of fs.readdirSync(path.join(root, 'collections'))) {
      fs.rmSync(path.join(root, 'collections', name));
    }
    const result = discoverBundles(root, { repository: 'o/r' });
    expect(result.mode).toBe('skills');
    expect(result.bundles.map((bundle) => bundle.id)).toEqual(['skills-o-r-lint']);
    expect(result.bundles[0].version).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(result.bundles[0].metadata).toEqual({ author: 'o', kind: { skill: 1 }, labels: [] });
  });

  it('falls back to the repository when nothing is found', () => {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    expect(discoverBundles(empty, { repository: 'o/r' })).toEqual({ mode: 'repository', bundles: [], warnings: [] });
  });

  it('does not pull the whole repository in for a root-level skill', () => {
    write(root, 'SKILL.md');
    write(root, 'collections/root.collection.yml', 'id: root\nname: Root\nitems:\n  - path: SKILL.md\n    kind: skill\n');
    const bundle = discoverBundles(root, { repository: 'o/r' }).bundles.find((item) => item.id === 'root');
    expect(bundle?.files.toSorted()).toEqual(['SKILL.md', 'collections/root.collection.yml']);
  });
});

describe('discoverBundles path checks', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-bundles-paths-'));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('warns when the collections path leaves the checkout', () => {
    const result = discoverBundles(root, { repository: 'o/r', collectionsPath: '../elsewhere' });
    expect(result.warnings.join('\n')).toContain('collections path is outside the repository');
  });

  it('brings the whole folder of a plugin item', () => {
    write(root, 'collections/p.collection.yml', 'id: p\nversion: 1.0.0\nitems:\n  - path: plugins/p/plugin.json\n    kind: plugin\n');
    write(root, 'plugins/p/plugin.json');
    write(root, 'plugins/p/lib/helper.md');
    const [bundle] = discoverBundles(root, { repository: 'o/r' }).bundles;
    expect(bundle.files).toEqual(['collections/p.collection.yml', 'plugins/p/lib/helper.md', 'plugins/p/plugin.json']);
  });

  it('ignores a reference that goes through a symlinked folder to the outside', () => {
    write(base, 'outside/SKILL.md', 'secret');
    write(root, 'skills/.keep');
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'skills', 'link'), 'junction');
    write(root, 'collections/s.collection.yml', 'id: s\nversion: 1.0.0\nitems:\n  - path: skills/link/SKILL.md\n    kind: skill\n');
    const result = discoverBundles(root, { repository: 'o/r' });
    expect(result.bundles[0].files).toEqual(['collections/s.collection.yml']);
    expect(result.warnings.join('\n')).toContain('skills/link/SKILL.md');
  });
});
