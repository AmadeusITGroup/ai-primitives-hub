import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Bundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
  NodeRuntimeProjectionFileSystem,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  RuntimeRegistryFacade,
  type RuntimeRegistryFacadeOptions,
} from '../../src/runtime-target/registry-facade';
import {
  createRuntimeTargetSession,
} from '../../src/runtime-target/session';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(options: {
  sharedId?: boolean;
  allowMcpServers?: boolean;
  onMcpServersChanged?: RuntimeRegistryFacadeOptions['onMcpServersChanged'];
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-market-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const env = { HOME: path.join(root, 'home'), XDG_DATA_HOME: path.join(root, 'data') };
  await Promise.all([workspace, env.HOME].map((dir) => fs.mkdir(dir)));
  const storage = new XdgAppStorage(env);
  const sessionFactory = (workspaceRoot?: string) => createRuntimeTargetSession({
    storage, workspaceRoot, env,
    store: new ScopedRuntimeTargetStore({ storage, workspaceRoot }),
    fs: new NodeRuntimeProjectionFileSystem(),
    ...(options.allowMcpServers === true ? { allowMcpServers: true } : {}),
    layoutLoader: new BuiltInOnlyLayoutConfigLoader()
  });
  const source: RegistrySource = { id: 'github-test', name: 'Test', type: 'github', url: 'https://github.com/owner/repo', enabled: true, priority: 1 };
  const bundles = ['1.0.0', '2.0.0'].map((version): Bundle => ({
    id: options.sharedId === true ? 'owner-repo-demo' : `owner-repo-demo-v${version}`, sourceId: source.id, version, name: 'Demo',
    description: '', author: '', environments: [], tags: [], lastUpdated: '2026-01-01',
    size: '', dependencies: [], license: 'MIT', manifestUrl: '', downloadUrl: `https://example.invalid/${version}`
  }));
  let downloads = 0;
  const catalog = {
    listSources: async () => [source],
    getCachedSourceBundles: async () => bundles,
    getBundleDetails: async (id: string) => {
      const bundle = bundles.find((b) => b.id === id) ?? bundles[1];
      return bundle;
    },
    getBundleVersion: () => undefined,
    getAdapter: () => ({ downloadBundle: async (bundle: Bundle) => {
      downloads += 1;
      return Buffer.from(bundle.version);
    } })
  };
  const facade = new RuntimeRegistryFacade({
    sessionFactory, catalog,
    ...(options.onMcpServersChanged === undefined ? {} : { onMcpServersChanged: options.onMcpServersChanged }),
    extractor: {
      extract: async (bytes: Uint8Array) => {
        const version = Buffer.from(bytes).toString();
        const files = new Map([
          ['deployment-manifest.yml', Buffer.from(
            `id: demo\nversion: ${version}\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n`
            + (options.allowMcpServers
              ? 'mcpServers:\n  demo:\n    command: node\n    args:\n      - server.js\n'
              : '')
          )],
          ['prompts/a.prompt.md', Buffer.from(`# ${version}\n`)]
        ]);
        if (options.allowMcpServers) {
          files.set('mcp/server.js', Buffer.from('export default 1;\n'));
          files.set('mcp.json', Buffer.from('{}\n'));
        }
        return files;
      }
    }
  });
  const session = sessionFactory(workspace);
  await session.selectTarget({ type: 'devin' });
  const context = { workspaceRoot: workspace, confirm: async () => true };
  return { root, workspace, env, session, facade, context, bundles, catalog, downloads: () => downloads };
}

describe('RuntimeRegistryFacade public lifecycle', () => {
  it('allows MCP manifests only for an opted-in delivery and forwards lifecycle events', async () => {
    const actions: string[] = [];
    const t = await setup({
      allowMcpServers: true,
      onMcpServersChanged: async (action) => {
        actions.push(action);
      }
    });
    const target = (await t.session.listTargets()).find((entry) => entry.type === 'devin')!;
    expect(target.unsupported).not.toContain('mcp');
    expect(target.unsupported).toContain('plugin');
    const installed = (await t.facade.install(t.bundles[0].id, {
      scope: 'repository', version: '1.0.0'
    }, t.context))!;
    expect(installed.manifest).toHaveProperty('mcpServers');
    expect(actions).toEqual(['install']);
    await expect(fs.stat(path.join(t.workspace, 'mcp/server.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(t.workspace, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const payloadFile = path.join(
      t.env.XDG_DATA_HOME, 'ai-primitives-hub', 'payloads', installed.payloadId, 'files', 'mcp', 'server.js'
    );
    expect(await fs.readFile(payloadFile, 'utf8')).toBe('export default 1;\n');

    const updated = (await t.facade.update(installed.installationId, '2.0.0', t.context))!;
    expect(updated.version).toBe('2.0.0');
    await t.facade.uninstall(updated.installationId, t.context);
    expect(actions).toEqual(['install', 'update', 'uninstall']);
  });

  it('installs both scopes at different versions and updates/removes the exact instance', async () => {
    const t = await setup();
    const repo = (await t.facade.install(t.bundles[0].id, { scope: 'repository', version: '1.0.0' }, t.context))!;
    const user = (await t.facade.install(t.bundles[1].id, { scope: 'user', version: '2.0.0' }, t.context))!;
    expect(await t.facade.list(t.workspace)).toHaveLength(2);
    expect(repo.instance).toMatchObject({ type: 'devin', scope: 'repository', root: t.workspace });
    expect(user.version).toBe('2.0.0');
    const userFile = path.join(t.env.HOME, '.devin/rules/a.prompt.md');
    const userBefore = await fs.readFile(userFile);
    const updated = (await t.facade.update(repo.installationId, undefined, t.context))!;
    expect(updated.version).toBe('2.0.0');
    expect(await fs.readFile(userFile)).toEqual(userBefore);
    await expect(t.facade.resolveInstallation(t.bundles[1].id, t.workspace)).rejects.toThrow(/ambiguous/i);
    expect((await t.facade.resolveInstallation(t.bundles[1].id, t.workspace, 'repository')).installationId).toBe(repo.installationId);
    await t.facade.uninstall(user.installationId, t.context);
    expect((await t.facade.list(t.workspace)).map((r) => r.instance.scope)).toEqual(['repository']);
    expect(await fs.readFile(path.join(t.workspace, '.devin/rules/a.prompt.md'), 'utf8')).toBe('# 2.0.0\n');
    await expect(fs.stat(path.join(t.workspace, '.github'))).rejects.toMatchObject({ code: 'ENOENT' });
    await t.session.selectTarget({ type: 'kiro' });
    expect(await t.facade.list(t.workspace)).toEqual([]);
    await expect(t.facade.update(updated.installationId, undefined, t.context)).rejects.toThrow();
  });

  it('updates to the newest cached version when a source lists several versions under one id', async () => {
    const t = await setup({ sharedId: true });
    const row = (await t.facade.install(t.bundles[0].id, { scope: 'repository', version: '1.0.0' }, t.context))!;
    expect(row.version).toBe('1.0.0');
    const updated = (await t.facade.update(row.installationId, undefined, t.context))!;
    expect(updated.version).toBe('2.0.0');
    expect(await fs.readFile(path.join(t.workspace, '.devin/rules/a.prompt.md'), 'utf8')).toBe('# 2.0.0\n');
  });

  it('stores repository Local Only installs in the separate local lockfile', async () => {
    const t = await setup();
    const row = (await t.facade.install(t.bundles[0].id, {
      scope: 'repository', commitMode: 'local-only', version: '1.0.0'
    }, t.context))!;
    expect(row.commitMode).toBe('local-only');
    expect((await t.facade.list(t.workspace))[0].commitMode).toBe('local-only');
    const localLock = JSON.parse(await fs.readFile(path.join(t.workspace, 'prompt-registry.local.lock.json'), 'utf8'));
    expect(localLock.version).toBe('3.0.0');
    expect(Object.values(Object.values(localLock.bundles)[0].tools.devin.instances)[0]).not.toHaveProperty('commitMode');
    await expect(fs.stat(path.join(t.workspace, 'prompt-registry.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never substitutes latest for an unavailable explicitly requested version', async () => {
    const t = await setup();
    await expect(t.facade.install(t.bundles[0].id, { scope: 'repository', version: '9.0.0' }, t.context)).rejects.toThrow(/version/i);
    expect(t.downloads()).toBe(0);
    expect(await t.facade.list(t.workspace)).toEqual([]);
    await expect(fs.stat(path.join(t.workspace, 'prompt-registry.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not apply after a feature lifetime expires during confirmation', async () => {
    const t = await setup();
    let current = true;
    await expect(t.facade.install(t.bundles[0].id, { scope: 'repository', version: '1.0.0' }, {
      workspaceRoot: t.workspace,
      isCurrent: () => current,
      confirm: async () => {
        current = false;
        return true;
      }
    })).rejects.toThrow(/changed|disabled|stale/i);
    expect(await t.facade.list(t.workspace)).toEqual([]);
    await expect(fs.stat(path.join(t.workspace, '.devin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
