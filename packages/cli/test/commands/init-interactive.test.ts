import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  InitCommand,
} from '../../src/commands/init';
import {
  runCommand,
} from '../../src/framework';

const { inquirerPrompt } = vi.hoisted(() => ({
  inquirerPrompt: vi.fn()
}));

vi.mock('inquirer', () => ({
  default: { prompt: inquirerPrompt }
}));

describe('interactive init command', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-init-interactive-test-'));
    inquirerPrompt.mockReset();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('uses prompt types supported by the installed Inquirer version', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    inquirerPrompt.mockResolvedValue({
      ide: 'copilot-cli',
      scope: 'user',
      connectHub: false
    });

    try {
      const result = await runCommand(['init'], {
        commandClasses: [InitCommand],
        context: {
          cwd: workspace,
          fs: new NodeFileSystem(),
          env: {
            HOME: workspace,
            USERPROFILE: workspace,
            XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
            XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
          }
        }
      });

      expect(result.exitCode).toBe(0);
      expect(inquirerPrompt).toHaveBeenCalledOnce();
      const questions = inquirerPrompt.mock.calls[0]?.[0] as { type: string }[];
      expect(questions.map((question) => question.type)).toEqual([
        'select', 'select', 'confirm', 'select', 'input'
      ]);
    } finally {
      if (originalIsTTY === undefined) {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      } else {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
      }
    }
  });
});
