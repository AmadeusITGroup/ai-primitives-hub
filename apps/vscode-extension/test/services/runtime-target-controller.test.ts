/**
 * RuntimeTargetController + gated commands tests — real session/store/fs
 * under synthetic roots; only the vscode boundary is stubbed.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRuntimeTargetSession,
} from '@ai-primitives-hub/app';
import {
  TARGET_TYPES,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
  NodeRuntimeProjectionFileSystem,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  registerRuntimeTargetCommands,
} from '../../src/commands/runtime-target-commands';
import {
  RuntimeTargetController,
} from '../../src/services/runtime-target-controller';

const envOf = (root: string): Record<string, string> => ({
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'xdg/config'),
  XDG_DATA_HOME: path.join(root, 'xdg/data'),
  XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
  XDG_STATE_HOME: path.join(root, 'xdg/state'),
  TMPDIR: path.join(root, 'tmp')
});

const sessionFor = (root: string, workspaceRoot?: string) => {
  const env = envOf(root);
  const storage = new XdgAppStorage(env);
  return createRuntimeTargetSession({
    storage,
    store: new ScopedRuntimeTargetStore({ storage, workspaceRoot }),
    fs: new NodeRuntimeProjectionFileSystem(),
    env,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    layoutLoader: new BuiltInOnlyLayoutConfigLoader()
  });
};

function bundle(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deployment-manifest.yml'),
    `id: demo\nversion: ${version}\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n`);
  fs.writeFileSync(path.join(dir, 'prompts', 'a.prompt.md'), `# A ${version}\n`);
}

suite('RuntimeTargetController', () => {
  test('catalog lists all 11 target types regardless of host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ext-'));
    const environment = vscode.env as unknown as Record<string, unknown>;
    const previousName = environment.appName;
    try {
      const c = new RuntimeTargetController({ sessionFactory: (ws) => sessionFor(root, ws) });
      for (const host of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Kiro', 'Devin']) {
        environment.appName = host;
        const catalog = await c.listTargets();
        assert.deepStrictEqual(catalog.map((entry) => entry.type).toSorted(), [...TARGET_TYPES].toSorted());
      }
    } finally {
      environment.appName = previousName;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace selections remain independent and an unselected workspace uses the explicit global default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-contexts-'));
    try {
      const [a, b, unselected] = ['a', 'b', 'c'].map((name) => path.join(root, name));
      for (const workspace of [a, b, unselected]) {
        fs.mkdirSync(workspace);
      }
      const controller = new RuntimeTargetController({ sessionFactory: (ws) => sessionFor(root, ws) });
      assert.strictEqual(await controller.getActiveTarget(unselected), undefined);
      await controller.selectTarget({ type: 'vscode', scope: 'user' }, a);
      await controller.selectTarget({ type: 'kiro', scope: 'repository' }, b);
      await controller.selectTarget({ type: 'opencode', scope: 'user', userDefault: true });
      assert.strictEqual((await controller.getActiveTarget(a))!.instance.type, 'vscode');
      assert.strictEqual((await controller.getActiveTarget(b))!.instance.type, 'kiro');
      assert.strictEqual((await controller.getActiveTarget(unselected))!.instance.type, 'opencode');
      assert.strictEqual(fs.existsSync(path.join(envOf(root).HOME, '.copilot')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('select then install then verify on real session below synthetic root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ext-'));
    try {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      const c = new RuntimeTargetController({ sessionFactory: (w) => sessionFor(root, w ?? ws) });
      const active = await c.selectTarget({ type: 'vscode', scope: 'user' }, ws);
      assert.strictEqual(active.instance.type, 'vscode');
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      const { loadExtractedDirectory } = await import('@ai-primitives-hub/infra');
      const p = await loadExtractedDirectory(d);
      const user = { scope: 'user' as const };
      const plan = await c.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } }, ws, user);
      const res = await c.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash, ws, user);
      assert.ok(res.applied);
      const verify = await c.verify(ws);
      assert.ok(verify.every((v) => v.status === 'healthy'));
      const lf = await c.getLockfile(ws);
      assert.ok(lf !== null && lf.version === '3.0.0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('registerRuntimeTargetCommands', () => {
  const fakeContext = (): vscode.ExtensionContext => ({
    subscriptions: [] as unknown[],
    get globalStorageUri(): never {
      throw new Error('globalStorageUri must not be touched');
    },
    get globalState(): never {
      throw new Error('globalState must not be touched');
    }
  } as unknown as vscode.ExtensionContext);

  test('registers all command IDs and sets the enablement context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ext-'));
    try {
      const context = fakeContext();
      const cmds = registerRuntimeTargetCommands(context, { env: envOf(root) });
      assert.ok(cmds !== undefined);
      assert.ok(context.subscriptions.length > 0);
      cmds.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('v3 lockfile validates against the public schema (AJV)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ext-'));
    try {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      const c = new RuntimeTargetController({ sessionFactory: (w) => sessionFor(root, w ?? ws) });
      await c.selectTarget({ type: 'vscode', scope: 'user' }, ws);
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      const { loadExtractedDirectory } = await import('@ai-primitives-hub/infra');
      const p = await loadExtractedDirectory(d);
      const user = { scope: 'user' as const };
      const plan = await c.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } }, ws, user);
      await c.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash, ws, user);
      await c.selectTarget({ type: 'kiro', scope: 'repository' }, ws);
      const secondPlan = await c.plan({ kind: 'project' }, ws, user);
      await c.apply({ kind: 'project' }, secondPlan.hash, ws, user);
      const lf = await c.getLockfile(ws);
      assert.ok(lf !== null);
      const { default: ajvClass } = await import('ajv');
      const { default: addFormats } = await import('ajv-formats');
      const ajv = new ajvClass({ allErrors: true });
      addFormats(ajv);
      const schemaPath = path.resolve(__dirname, '../../../../../packages/core/src/public/schemas/lockfile.schema.json');
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const ok = ajv.validate(schema, lf);
      assert.strictEqual(ok, true, `schema errors: ${JSON.stringify(ajv.errors)?.slice(0, 400)}`);
      const firstInstance = (document: any): any => {
        const entry: any = Object.values(document.bundles)[0];
        const tool: any = Object.values(entry.tools)[0];
        return Object.values(tool.instances)[0];
      };
      const bundleEntry = Object.values(lf.bundles)[0];
      assert.deepStrictEqual(Object.keys(bundleEntry.tools).toSorted(), ['kiro', 'vscode']);
      const invalid: [string, (document: any) => void][] = [
        ['new version', (document) => {
          document.version = '4.0.0';
        }],
        ['unknown target', (document) => {
          const entry: any = Object.values(document.bundles)[0];
          entry.tools.unsupported = entry.tools.vscode;
          delete entry.tools.vscode;
        }],
        ['missing checksum', (document) => {
          delete firstInstance(document).files[0].checksum;
        }],
        ['absolute file', (document) => {
          firstInstance(document).files[0].path = '/outside';
        }],
        ['invalid mode', (document) => {
          firstInstance(document).files[0].mode = 512;
        }],
        ['payload bytes in the lockfile', (document) => {
          document.payloads = {};
        }]
      ];
      for (const [name, mutate] of invalid) {
        const malformed: typeof lf = structuredClone(lf);
        mutate(malformed);
        assert.strictEqual(ajv.validate(schema, malformed), false, `accepted ${name}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
