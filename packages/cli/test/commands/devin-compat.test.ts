/**
 * Devin compatibility: a Copilot-layout bundle installed onto a `devin-cli`
 * target lands where Devin reads customizations (`.devin/skills`,
 * `.devin/rules`, `.devin/agents` in the repository; `~/.config/devin/skills`,
 * `~/.devin/rules` for the user), with Copilot `applyTo` rewritten to Devin
 * rule frontmatter. The built-in MCP layout (used by MCP installs) points at
 * the `mcp_config.json` files Devin loads.
 *
 * When the `devin` binary is on PATH, the result is also checked against the
 * real CLI (`devin skills|rules|mcp list`, `devin doctor`).
 * @see https://docs.devin.ai/cli/extensibility
 */
import {
  execFile,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  resolveMcpLayoutConfig,
} from '@ai-primitives-hub/app';
import {
  resolveMcpConfigPath,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

const exec = promisify(execFile);

const BUNDLE_FILES: Record<string, string> = {
  'deployment-manifest.yml': `id: devin-sample
version: 1.0.0
name: Devin Sample
prompts:
  - id: code-review
    name: Code Review
    file: skills/code-review/SKILL.md
    type: skill
  - id: typescript
    name: TypeScript Rules
    file: instructions/typescript.instructions.md
    type: instructions
  - id: reviewer
    name: Reviewer
    file: agents/reviewer.agent.md
    type: agent
`,
  'skills/code-review/SKILL.md': '---\nname: code-review\ndescription: Review a diff for bugs\n---\n# Code Review\n',
  'instructions/typescript.instructions.md': '---\napplyTo: "**/*.ts"\n---\nUse strict TypeScript.\n',
  'agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews code changes\n---\nYou review code.\n'
};

/**
 * Locate the Devin CLI, if installed.
 * @returns Absolute path to `devin`, or undefined.
 */
const findDevin = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'where.exe' : 'which', ['devin']);
    return stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  } catch {
    return undefined;
  }
};

const devinBin = await findDevin();

describe('Devin compatibility of a devin-cli repository install', () => {
  let home: string;
  let workspace: string;
  let bundleDir: string;

  const env = (): Record<string, string> => ({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    XDG_CACHE_HOME: path.join(home, 'xdg-cache')
  });

  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env: env() });
    const exitCode = await runCli(argv, {
      ctx,
      tokens: { getToken: async () => undefined },
      commandClasses: [TargetAddCommand, InstallCommand],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  const install = async (scope: 'user' | 'repository' = 'repository'): Promise<void> => {
    const added = await run(['target', 'add', 'devin', '--type', 'devin-cli', '--scope', scope, '--workspace-root', workspace, '-o', 'json']);
    expect(added.exitCode, added.stdout).toBe(0);
    const installed = await run(['install', '--from', bundleDir, '--target', 'devin', '-o', 'json']);
    expect(installed.exitCode, installed.stdout).toBe(0);
  };

  /**
   * Write the bundle's MCP servers where the built-in devin-cli layout says, as an MCP install does.
   * @param scope - MCP config scope.
   * @returns Absolute path of the written config file.
   */
  const writeMcpConfig = async (scope: 'user' | 'repository'): Promise<string> => {
    const config = resolveMcpLayoutConfig('devin-cli', scope, [defaultLayouts]);
    expect(config, `devin-cli ${scope} mcpConfig`).toBeDefined();
    const configPath = resolveMcpConfigPath(config!, { HOME: home, workspaceRoot: workspace });
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      [config!.serversKey]: {
        [`sample-${scope}`]: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } }
      }
    }, null, 2));
    return configPath;
  };

  /**
   * Run the real Devin CLI in the installed workspace, isolated from the host's config
   * (HOME, XDG_CONFIG_HOME, APPDATA).
   * @param args - Arguments to `devin`.
   * @returns Combined stdout and stderr.
   */
  const devin = async (args: string[]): Promise<string> => {
    const { stdout, stderr } = await exec(devinBin!, args, {
      cwd: workspace,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, '.config') },
      timeout: 60_000
    });
    return `${stdout}${stderr}`;
  };

  beforeEach(async () => {
    // Canonical paths: on macOS the temp dir lives under the `/var` -> `/private/var` symlink
    // and the Devin CLI reports the resolved path.
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cli-devin-home-')));
    workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cli-devin-ws-')));
    bundleDir = path.join(home, 'bundle');
    for (const [filePath, content] of Object.entries(BUNDLE_FILES)) {
      await mkdir(path.dirname(path.join(bundleDir, filePath)), { recursive: true });
      await writeFile(path.join(bundleDir, filePath), content);
    }
    await exec('git', ['init', '-q'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('writes skills, rules and agents to Devin repository paths', async () => {
    await install();

    await expect(readFile(path.join(workspace, '.devin', 'skills', 'code-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: code-review');
    await expect(readFile(path.join(workspace, '.devin', 'agents', 'reviewer.agent.md'), 'utf8'))
      .resolves.toContain('You review code.');
    const rule = await readFile(path.join(workspace, '.devin', 'rules', 'typescript.instructions.md'), 'utf8');
    expect(rule).toMatch(/^trigger: "?glob"?$/m);
    expect(rule).toContain('**/*.ts');
  });

  it('writes user skills and agents to ~/.config/devin and rules to ~/.devin/rules', async () => {
    await install('user');

    await expect(readFile(path.join(home, '.config', 'devin', 'skills', 'code-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: code-review');
    await expect(readFile(path.join(home, '.config', 'devin', 'agents', 'reviewer.agent.md'), 'utf8'))
      .resolves.toContain('You review code.');
    await expect(readFile(path.join(home, '.devin', 'rules', 'typescript.instructions.md'), 'utf8'))
      .resolves.toMatch(/^trigger: "?glob"?$/m);
  });

  it('resolves MCP config to the mcp_config.json files Devin reads', async () => {
    expect(await writeMcpConfig('repository')).toBe(path.join(workspace, '.devin', 'mcp_config.json'));
    expect(await writeMcpConfig('user')).toBe(path.join(home, '.config', 'devin', 'mcp_config.json'));
  });

  describe.skipIf(devinBin === undefined)('with the real Devin CLI', () => {
    it('discovers a repository install', async () => {
      await install();
      const mcpPath = await writeMcpConfig('repository');

      expect(await devin(['skills', 'list'])).toMatch(/\/code-review\b.*\.devin\/skills\/code-review.*Review a diff for bugs/);
      expect(await devin(['rules', 'list'])).toMatch(/typescript\.instructions.*globs: \*\*\/\*\.ts/);
      const mcpList = await devin(['mcp', 'list']);
      expect(mcpList).toContain('sample-repository');
      expect(mcpList).toContain(`Source: ${mcpPath}`);
      expect(await devin(['doctor'])).toMatch(/custom subagent profiles.*reviewer/);
    });

    it('discovers a user install', async () => {
      await install('user');
      await writeMcpConfig('user');

      expect(await devin(['skills', 'list'])).toMatch(/\/code-review\b.*~\/\.config\/devin\/skills\/code-review/);
      expect(await devin(['rules', 'list'])).toMatch(/typescript\.instructions.*globs: \*\*\/\*\.ts/);
      expect(await devin(['mcp', 'list'])).toContain('sample-user');
      expect(await devin(['doctor'])).toMatch(/custom subagent profiles.*reviewer/);
    });
  });
});
