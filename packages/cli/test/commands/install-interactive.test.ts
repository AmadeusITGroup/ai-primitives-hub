/**
 * `install --source <hub-id> --interactive`: the outcome reported when some
 * or all of the selected bundles fail to install (#705). The prompts are
 * the terminal boundary, so `inquirer` is mocked; the hub, its source, and
 * the bundle downloads go through the real install path.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  buildZip,
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
  HubAddCommand,
  HubUseCommand,
} from '../../src/commands/hub';
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
import {
  createLegacyReleaseArchive,
} from '../fixtures/release-archives';

const { inquirerPrompt } = vi.hoisted(() => ({
  inquirerPrompt: vi.fn()
}));

vi.mock('inquirer', () => ({
  default: { prompt: inquirerPrompt }
}));

const INSTALLABLE = 'acme-org-sample-skills-sample-skills';
// From a source whose repository has no releases, so the install fails.
const FAILING = 'acme-org-missing-missing';

interface Envelope {
  status: string;
  data: {
    installed: number;
    total: number;
    bundles: { bundleId: string; version: string }[];
    failures: { bundleId: string; reason: string }[];
  } | null;
  errors: { code: string; message: string }[];
}

describe('install --source <hub-id> --interactive outcome (#705)', () => {
  let workspace: string;
  let targetDir: string;

  const bundleZip = buildZip([...createLegacyReleaseArchive({ id: 'sample-skills', version: '1.8.1' })]
    .map(([filePath, bytes]) => ({ path: filePath, bytes })));
  const http: HttpClient = {
    fetch: (request: HttpRequest): Promise<HttpResponse> => {
      if (request.url === 'https://api.github.com/repos/acme-org/sample-skills/releases') {
        return Promise.resolve({
          statusCode: 200,
          body: new TextEncoder().encode(JSON.stringify([{
            tag_name: 'sample-skills-v1.8.1',
            assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/sample' }]
          }])),
          finalUrl: request.url,
          headers: {}
        });
      }
      if (request.url === 'https://api.github.com/assets/sample') {
        return Promise.resolve({ statusCode: 200, body: bundleZip, finalUrl: request.url, headers: {} });
      }
      if (request.url === 'https://api.github.com/repos/acme-org/missing/releases') {
        return Promise.resolve({ statusCode: 404, body: new TextEncoder().encode('{"message":"Not Found"}'), finalUrl: request.url, headers: {} });
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    }
  };

  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: () => Promise.resolve(undefined) },
      commandClasses: [TargetAddCommand, HubAddCommand, HubUseCommand, InstallCommand],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  const selectAndConfirm = (bundleIds: string[]): void => {
    inquirerPrompt.mockImplementation((questions: { name: string }[]) => Promise.resolve(
      questions[0]?.name === 'selectedBundles' ? { selectedBundles: bundleIds } : { proceed: true }
    ));
  };

  beforeEach(async () => {
    inquirerPrompt.mockReset();
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-install-interactive-test-'));
    targetDir = path.join(workspace, 'target');
    await mkdir(targetDir, { recursive: true });
    const hubConfigFile = path.join(workspace, 'hub-config.yml');
    await writeFile(hubConfigFile, `version: 1.0.0
metadata:
  name: Sample Hub
  description: Hub with a GitHub source
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: sample-collections
    name: Sample Collections
    type: github
    url: https://github.com/acme-org/sample-skills
    enabled: true
    priority: 0
    hubId: sample-hub
  - id: missing-collections
    name: Missing Collections
    type: github
    url: https://github.com/acme-org/missing
    enabled: true
    priority: 1
    hubId: sample-hub
profiles:
  - id: developer
    name: Developer
    description: One installable bundle and one whose source has no releases
    bundles:
      - id: ${INSTALLABLE}
        version: latest
        source: sample-collections
        required: false
      - id: ${FAILING}
        version: latest
        source: missing-collections
        required: false
`);
    expect((await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('reports the failed bundle in one JSON envelope and exits 1 when only some bundles install', async () => {
    selectAndConfirm([INSTALLABLE, FAILING]);

    const result = await run(['install', '--source', 'sample-hub', '--interactive', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(1);
    const envelope = JSON.parse(result.stdout) as Envelope;
    expect(envelope.status).toBe('warning');
    expect(envelope.data).toMatchObject({ installed: 1, total: 2 });
    expect(envelope.data?.bundles).toEqual([{ bundleId: INSTALLABLE, version: '1.8.1' }]);
    expect(envelope.data?.failures.map((f) => f.bundleId)).toEqual([FAILING]);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
  });

  it('fails when none of the selected bundles installs', async () => {
    selectAndConfirm([FAILING]);

    const result = await run(['install', '--source', 'sample-hub', '--interactive', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(1);
    const envelope = JSON.parse(result.stdout) as Envelope;
    expect(envelope.status).toBe('error');
    expect(envelope.errors[0].code).toBe('HUB.INSTALL_FAILED');
    expect(envelope.errors[0].message).toContain(FAILING);
  });

  it('still reports success with a single envelope when every selected bundle installs', async () => {
    selectAndConfirm([INSTALLABLE]);

    const result = await run(['install', '--source', 'sample-hub', '--interactive', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout) as Envelope;
    expect(envelope.status).toBe('ok');
    expect(envelope.data).toMatchObject({ installed: 1, total: 1 });
    expect(envelope.data?.bundles).toEqual([{ bundleId: INSTALLABLE, version: '1.8.1' }]);
    expect(envelope.data?.failures).toEqual([]);
  });
});
