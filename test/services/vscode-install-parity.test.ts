import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplicationUseCases,
} from '../../src/services/application-use-cases';
import type {
  ApplicationBundle,
} from '../../src/services/application-use-cases';
import {
  assertTargetFileSystem,
  readTargetFileTree,
} from '../helpers/target-golden';

suite('VS Code install parity', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-install-parity-'));
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('installs current VS Code user-scope resources into the golden layout', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'user' },
      bundle: createParityBundle('1.0.0')
    });

    await assertTargetFileSystem(
      path.join(tempRoot, 'user'),
      await readGoldenOutputTree('vscode-user')
    );
  });

  test('installs current VS Code repository-scope resources and lockfile into the golden layout', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createParityBundle('1.0.0'),
      source: {
        id: 'golden-source',
        type: 'local',
        url: 'file:///fixtures/golden-source'
      },
      commitMode: 'commit'
    });

    await assertTargetFileSystem(
      path.join(tempRoot, 'repository'),
      await readGoldenOutputTree('vscode-repository')
    );
  });

  test('updates current VS Code repository-scope resources without changing target paths', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createParityBundle('1.0.0')
    });
    await useCases.update({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createParityBundle('1.0.1')
    });

    const tree = await readTargetFileTree(path.join(tempRoot, 'repository'));
    const paths = tree.files.map((file) => file.path);

    assert.ok(paths.includes('.github/prompts/review.prompt.md'));
    assert.ok(paths.includes('.github/instructions/coding.instructions.md'));
    assert.ok(paths.includes('.github/agents/planner.agent.md'));
    assert.ok(paths.includes('.github/skills/analyzer/SKILL.md'));
    assert.ok(paths.includes('prompt-registry.lock.json'));
  });

  test('uninstalls current VS Code repository-scope resources and lockfile entries', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'repository' },
      bundle: createParityBundle('1.0.0')
    });
    await useCases.uninstall({
      target: { type: 'vscode', scope: 'repository' },
      bundleId: 'golden-vscode-bundle'
    });

    const tree = await readTargetFileTree(path.join(tempRoot, 'repository'));

    assert.deepStrictEqual(tree.files, []);
  });

  test('moves current VS Code user-scope resources to repository scope without changing resource names', async () => {
    const useCases = createApplicationUseCases({
      root: tempRoot,
      now: () => '2025-01-01T00:00:00.000Z'
    });

    await useCases.install({
      target: { type: 'vscode', scope: 'user' },
      bundle: createParityBundle('1.0.0')
    });
    await useCases.moveScope({
      bundleId: 'golden-vscode-bundle',
      from: { type: 'vscode', scope: 'user' },
      to: { type: 'vscode', scope: 'repository' },
      commitMode: 'commit'
    });

    await assertTargetFileSystem(
      path.join(tempRoot, 'repository'),
      await readGoldenOutputTree('vscode-repository')
    );
    await assertTargetFileSystem(path.join(tempRoot, 'user'), { files: [] });
  });
});

function goldenFixture(name: 'vscode-user' | 'vscode-repository'): string {
  return path.join(__dirname, '..', 'fixtures', 'golden', name);
}

async function readGoldenOutputTree(name: 'vscode-user' | 'vscode-repository') {
  const tree = await readTargetFileTree(goldenFixture(name));

  return {
    files: tree.files.filter((file) => file.path !== 'README.md')
  };
}

function createParityBundle(version: string): ApplicationBundle {
  return {
    id: 'golden-vscode-bundle',
    version,
    resources: [
      {
        kind: 'prompt',
        id: 'review',
        sourcePath: 'prompts/review.prompt.md',
        content: '# Review\n\nReview the selected change for correctness, maintainability, and tests.'
      },
      {
        kind: 'instruction',
        id: 'coding',
        sourcePath: 'instructions/coding.instructions.md',
        content: '# Coding Instructions\n\nUse focused changes, preserve public behavior, and validate before completion.'
      },
      {
        kind: 'agent',
        id: 'planner',
        sourcePath: 'agents/planner.agent.md',
        content: '# Planner Agent\n\nCreate an implementation plan with dependencies, validation, and rollback notes.'
      },
      {
        kind: 'skill',
        id: 'analyzer',
        sourcePath: 'skills/analyzer/SKILL.md',
        content: '# Analyzer\n\nAnalyze repository context and return evidence-backed findings.',
        files: [
          {
            path: 'SKILL.md',
            content: '# Analyzer\n\nAnalyze repository context and return evidence-backed findings.'
          },
          {
            path: 'templates/checklist.md',
            content: '# Checklist\n\n- Confirm the target scope.\n- Compare expected and actual files.\n- Record validation evidence.'
          }
        ]
      }
    ]
  };
}
