import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  readTargetFileTree,
} from '../helpers/target-golden';

suite('VS Code user-scope golden output', () => {
  let originalHome: string | undefined;
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-user-golden-'));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(tempRoot, 'home');
  });

  teardown(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('syncBundle preserves current user-scope prompts, instructions, agents, and skills layout', async () => {
    const bundlePath = await createGoldenBundle(tempRoot);
    const service = new UserScopeService(createMockContext(tempRoot));

    await service.syncBundle('golden-vscode-bundle', bundlePath);

    assert.deepStrictEqual(
      await readCurrentUserScopeTree(tempRoot),
      await readGoldenOutputTree()
    );
  });
});

function createMockContext(root: string): vscode.ExtensionContext {
  const userDir = path.join(root, 'Code', 'User');

  return {
    globalStorageUri: { fsPath: path.join(userDir, 'globalStorage', 'publisher.extension') },
    storageUri: { fsPath: path.join(root, 'workspace') },
    extensionPath: __dirname,
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

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
  await fs.writeFile(path.join(bundlePath, 'skills', 'analyzer', 'templates', 'checklist.md'), '# Checklist\n\n- Confirm the target scope.\n- Compare expected and actual files.\n- Record validation evidence.');
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

async function readCurrentUserScopeTree(root: string) {
  const promptsTree = await readTargetFileTree(path.join(root, 'Code', 'User', 'prompts'));
  const skillsTree = await readTargetFileTree(path.join(root, 'home', '.copilot', 'skills'));

  return {
    files: [
      ...promptsTree.files.map((file) => ({ ...file, path: path.posix.join('prompts', file.path) })),
      ...skillsTree.files.map((file) => ({ ...file, path: path.posix.join('skills', file.path) }))
    ].toSorted((left, right) => left.path.localeCompare(right.path))
  };
}

async function readGoldenOutputTree() {
  const tree = await readTargetFileTree(path.join(__dirname, '..', 'fixtures', 'golden', 'vscode-user'));

  return {
    files: tree.files.filter((file) => file.path !== 'README.md')
  };
}