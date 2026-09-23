import * as assert from 'node:assert';
import {
  spawnSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLegacyReleaseManifestPlan,
  createReleaseManifestPlan,
} from '../src/release-manifest';

const createTempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const writeFile = (root: string, relativePath: string, content: string): void => {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

const runGit = (root: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const commitFixture = (root: string): string => {
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Release Manifest Test']);
  runGit(root, ['remote', 'add', 'origin', 'https://github.com/example/example.git']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'Fixture']);
  return runGit(root, ['rev-parse', 'HEAD']);
};

describe('createReleaseManifestPlan()', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('release-manifest-test-');
    writeFile(tempDir, 'LICENSE', 'Example license\n');
    writeFile(tempDir, 'README.md', '# Collection overview\n');
    writeFile(tempDir, 'prompts/hello.prompt.md', '# Hello\n');
    writeFile(tempDir, 'skills/example/SKILL.md', '# Example skill\n');
    writeFile(tempDir, 'skills/example/references/reference.md', '# Reference\n');
    writeFile(tempDir, 'skills/example/__pycache__/ignored.pyc', 'cache');
    writeFile(tempDir, 'collections/example.collection.yml', `id: example
name: Example
readme:
  path: README.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/example/SKILL.md
    kind: skill
`);
    commitFixture(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a canonical manifest with an integrity inventory over archive bytes', () => {
    const revision = runGit(tempDir, ['rev-parse', 'HEAD']);
    const plan = createReleaseManifestPlan({
      repoRoot: tempDir,
      collectionFile: 'collections/example.collection.yml',
      version: '1.2.3',
      source: 'https://github.com/example/example.git',
      revision,
      packageMetadata: { license: 'Example-License' }
    });

    const manifest = plan.manifest as {
      formatVersion: number;
      items: { path: string; kind: string }[];
      files: { path: string; role: string; size: number; sha256: string }[];
      provenance: { source: string; revision: string; sourceSnapshotPath: string; licensePath: string };
    };

    assert.strictEqual(manifest.formatVersion, 1);
    assert.deepStrictEqual(manifest.items.map((item) => item.kind), ['prompt', 'skill']);
    assert.deepStrictEqual(plan.entries.map((entry) => entry.path), [
      'LICENSE',
      'README.md',
      'metadata/source/collections/example.collection.yml',
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md',
      'skills/example/references/reference.md'
    ]);
    assert.ok(!plan.entries.some((entry) => entry.path.includes('__pycache__')));
    assert.strictEqual(manifest.provenance.source, 'https://github.com/example/example');
    assert.strictEqual(manifest.provenance.revision, revision);
    assert.strictEqual(manifest.provenance.sourceSnapshotPath, 'metadata/source/collections/example.collection.yml');
    assert.strictEqual(manifest.provenance.licensePath, 'LICENSE');
    assert.ok(manifest.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256)));
    assert.ok(manifest.files.some((file) => file.path === 'README.md' && file.role === 'metadata'));
    assert.ok(manifest.files.some((file) => file.path === 'skills/example/references/reference.md' && file.role === 'installable'));
  });

  it('keeps collection tags at the root and does not clone them onto items', () => {
    writeFile(tempDir, 'collections/example.collection.yml', `id: example
name: Example
tags: [argos, splunk]
readme:
  path: README.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/example/SKILL.md
    kind: skill
    tags: [orchestration]
`);
    runGit(tempDir, ['add', 'collections/example.collection.yml']);
    runGit(tempDir, ['commit', '-m', 'Add collection tags']);

    const revision = runGit(tempDir, ['rev-parse', 'HEAD']);
    const plan = createReleaseManifestPlan({
      repoRoot: tempDir,
      collectionFile: 'collections/example.collection.yml',
      version: '1.2.3',
      source: 'https://github.com/example/example.git',
      revision,
      packageMetadata: { license: 'Example-License' }
    });
    const manifest = plan.manifest as {
      tags?: string[];
      items: { path: string; tags?: string[] }[];
    };

    assert.deepStrictEqual(manifest.tags, ['argos', 'splunk']);
    const prompt = manifest.items.find((item) => item.path === 'prompts/hello.prompt.md');
    const skill = manifest.items.find((item) => item.path === 'skills/example/SKILL.md');
    assert.strictEqual(prompt?.tags, undefined);
    assert.deepStrictEqual(skill?.tags, ['orchestration']);

    const legacy = createLegacyReleaseManifestPlan({
      repoRoot: tempDir,
      collectionFile: 'collections/example.collection.yml',
      version: '1.2.3'
    }).manifest as {
      tags?: string[];
      prompts: { file: string; tags?: string[] }[];
    };
    assert.deepStrictEqual(legacy.tags, ['argos', 'splunk']);
    assert.strictEqual(legacy.prompts.find((item) => item.file === 'prompts/hello.prompt.md')?.tags, undefined);
    assert.deepStrictEqual(legacy.prompts.find((item) => item.file === 'skills/example/SKILL.md')?.tags, ['orchestration']);
  });

  it('uses exact committed source bytes instead of later working-tree changes', () => {
    const revision = runGit(tempDir, ['rev-parse', 'HEAD']);
    writeFile(tempDir, 'prompts/hello.prompt.md', '# Changed only in the worktree\n');
    writeFile(tempDir, 'collections/example.collection.yml', 'id: changed\nname: Changed\nitems: []\n');

    const plan = createReleaseManifestPlan({
      repoRoot: tempDir,
      collectionFile: 'collections/example.collection.yml',
      version: '1.2.3',
      source: 'https://github.com/example/example.git',
      revision,
      packageMetadata: { license: 'Example-License' }
    });
    const manifest = plan.manifest as {
      id: string;
      provenance: { revision: string };
    };
    const prompt = plan.entries.find((entry) => entry.path === 'prompts/hello.prompt.md');
    const snapshot = plan.entries.find((entry) => entry.path === 'metadata/source/collections/example.collection.yml');

    assert.strictEqual(manifest.id, 'example');
    assert.strictEqual(manifest.provenance.revision, revision);
    assert.strictEqual(prompt?.bytes.toString('utf8'), '# Hello\n');
    assert.ok(snapshot?.bytes.toString('utf8').includes('id: example'));
  });

  it('plans a legacy archive without fabricating governed license evidence', () => {
    fs.rmSync(path.join(tempDir, 'LICENSE'));

    const plan = createLegacyReleaseManifestPlan({
      repoRoot: tempDir,
      collectionFile: 'collections/example.collection.yml',
      version: '1.2.3'
    });
    const manifest = plan.manifest as Record<string, unknown> & {
      prompts: { file: string }[];
    };

    assert.strictEqual(manifest.formatVersion, undefined);
    assert.strictEqual(manifest.files, undefined);
    assert.strictEqual(manifest.provenance, undefined);
    assert.strictEqual(manifest.license, 'MIT');
    assert.deepStrictEqual(plan.entries.map((entry) => entry.path), [
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md',
      'skills/example/references/reference.md'
    ]);
    assert.deepStrictEqual(manifest.prompts.map((item) => item.file), [
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md'
    ]);
  });
});
