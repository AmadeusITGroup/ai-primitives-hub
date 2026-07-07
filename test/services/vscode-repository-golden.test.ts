import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  readTargetFileTree,
} from '../helpers/target-golden';

suite('VS Code repository-scope golden output', () => {
  let tempRoot: string;
  let workspaceRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-repository-golden-'));
    workspaceRoot = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  teardown(async () => {
    LockfileManager.resetInstance(workspaceRoot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('syncBundle preserves current repository-scope files and lockfile layout', async () => {
    const bundlePath = await createGoldenBundle(tempRoot);
    const service = new RepositoryScopeService(workspaceRoot, {} as RegistryStorage);

    await service.syncBundle('golden-vscode-bundle', bundlePath, { commitMode: 'commit' });
    await LockfileManager.getInstance(workspaceRoot).createOrUpdate({
      bundleId: 'golden-vscode-bundle',
      version: '1.0.0',
      sourceId: 'golden-source',
      sourceType: 'local',
      commitMode: 'commit',
      source: {
        type: 'local',
        url: 'file:///fixtures/golden-source'
      },
      files: [
        { path: '.github/prompts/review.prompt.md', checksum: stableChecksum(1) },
        { path: '.github/instructions/coding.instructions.md', checksum: stableChecksum(2) },
        { path: '.github/agents/planner.agent.md', checksum: stableChecksum(3) },
        { path: '.github/skills/analyzer/SKILL.md', checksum: stableChecksum(4) },
        { path: '.github/skills/analyzer/templates/checklist.md', checksum: stableChecksum(5) }
      ]
    });

    assert.deepStrictEqual(
      await readRepositoryTreeWithStableLockfile(workspaceRoot),
      await readGoldenOutputTree()
    );
  });
});

async function createGoldenBundle(root: string): Promise<string> {
  const bundlePath = path.join(root, 'bundle');
  await fs.mkdir(path.join(bundlePath, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(bundlePath, 'instructions'), { recursive: true });
  await fs.mkdir(path.join(bundlePath, 'agents'), { recursive: true });
  await fs.mkdir(path.join(bundlePath, 'skills', 'analyzer', 'templates'), { recursive: true });

  await fs.writeFile(path.join(bundlePath, 'prompts', 'review.prompt.md'), '# Review\n\nReview the selected change for correctness, maintainability, and tests.');
  await fs.writeFile(path.join(bundlePath, 'instructions', 'coding.instructions.md'), '# Coding Instructions\n\nUse focused changes, preserve public behavior, and validate before completion.');
  await fs.writeFile(
    path.join(bundlePath, 'agents', 'planner.agent.md'),
    '# Planner Agent\n\nCreate an implementation plan with dependencies, validation, and rollback notes.'
  );
  await fs.writeFile(path.join(bundlePath, 'skills', 'analyzer', 'SKILL.md'), '# Analyzer\n\nAnalyze repository context and return evidence-backed findings.');
  await fs.writeFile(
    path.join(bundlePath, 'skills', 'analyzer', 'templates', 'checklist.md'),
    '# Checklist\n\n- Confirm the target scope.\n- Compare expected and actual files.\n- Record validation evidence.'
  );
  await fs.writeFile(path.join(bundlePath, 'deployment-manifest.yml'), [
    'id: golden-vscode-bundle',
    'version: "1.0.0"',
    'name: Golden VS Code Bundle',
    'prompts:',
    '  - id: review',
    '    name: Review',
    '    file: prompts/review.prompt.md',
    '    type: prompt',
    '  - id: coding',
    '    name: Coding Instructions',
    '    file: instructions/coding.instructions.md',
    '    type: instruction',
    '  - id: planner',
    '    name: Planner Agent',
    '    file: agents/planner.agent.md',
    '    type: agent',
    '  - id: analyzer',
    '    name: Analyzer',
    '    file: skills/analyzer/SKILL.md',
    '    type: skill',
    ''
  ].join('\n'));

  return bundlePath;
}

async function readRepositoryTreeWithStableLockfile(root: string) {
  const tree = await readTargetFileTree(root);

  return {
    files: tree.files.map((file) => file.path === 'prompt-registry.lock.json'
      ? { ...file, content: stableLockfileContent(file.content) }
      : file)
  };
}

function stableLockfileContent(content: string): string {
  const lockfile = JSON.parse(content);
  lockfile.version = '1.0.0';
  lockfile.generatedAt = '2025-01-01T00:00:00.000Z';
  lockfile.generatedBy = 'prompt-registry@1.0.0';
  lockfile.bundles['golden-vscode-bundle'].installedAt = '2025-01-01T00:00:00.000Z';

  return JSON.stringify(lockfile, null, 2);
}

async function readGoldenOutputTree() {
  const tree = await readTargetFileTree(path.join(__dirname, '..', 'fixtures', 'golden', 'vscode-repository'));

  return {
    files: tree.files.filter((file) => file.path !== 'README.md')
  };
}

function stableChecksum(index: number): string {
  return String(index).padStart(64, '0');
}
