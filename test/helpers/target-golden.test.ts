import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertTargetFileSystem,
  readTargetFileTree,
} from './target-golden';

suite('targetGoldenHelpers', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'target-golden-'));
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('reads files with deterministic POSIX-relative paths', async () => {
    await fs.mkdir(path.join(tempRoot, '.github', 'agents'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, '.github', 'prompts'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, '.github', 'prompts', 'review.prompt.md'), '# Review\n');
    await fs.writeFile(path.join(tempRoot, '.github', 'agents', 'planner.agent.md'), '# Planner\n');

    const tree = await readTargetFileTree(tempRoot);

    assert.deepStrictEqual(tree.files, [
      {
        path: '.github/agents/planner.agent.md',
        content: '# Planner\n'
      },
      {
        path: '.github/prompts/review.prompt.md',
        content: '# Review\n'
      }
    ]);
  });

  test('asserts a complete target filesystem against expected golden entries', async () => {
    await fs.mkdir(path.join(tempRoot, '.github', 'instructions'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, '.github', 'instructions', 'coding.instructions.md'), '# Coding\n');

    await assert.doesNotReject(() => assertTargetFileSystem(tempRoot, {
      files: [
        {
          path: '.github/instructions/coding.instructions.md',
          content: '# Coding\n'
        }
      ]
    }));
  });
});