/**
 * Legacy IDE storage: insistent prompt, copy-only migration into XDG.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LegacyStorageMigration,
} from '../../src/commands/legacy-storage-migration';
import {
  createExtensionStorage,
} from '../../src/storage/extension-storage';

suite('LegacyStorageMigration', () => {
  let sandbox: sinon.SinonSandbox;
  let legacy: string;
  let migrated: number;
  const build = () => new LegacyStorageMigration({ legacyRoot: legacy, onMigrated: () => {
    migrated += 1;
  } });

  setup(() => {
    sandbox = sinon.createSandbox();
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ide-'));
    migrated = 0;
  });
  teardown(() => {
    sandbox.restore();
    fs.rmSync(legacy, { recursive: true, force: true });
  });

  const seedLegacy = () => fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ sources: [{ id: 'old', name: 'Old Source' }] }));

  test('no legacy artifacts: no prompt', async () => {
    const warn = sandbox.stub(vscode.window, 'showWarningMessage');
    await build().check();
    assert.strictEqual(warn.callCount, 0);
  });

  test('Later leaves everything alone and the prompt returns on the next check', async () => {
    seedLegacy();
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Later' as never);
    const m = build();
    await m.check();
    await m.check();
    assert.strictEqual(warn.callCount, 2);
    assert.deepStrictEqual(warn.firstCall.args.slice(1), ['Migrate Now', 'Later']);
    assert.match(String(warn.firstCall.args[0]), /legacy storage|legacy location/i);
    assert.ok(!fs.existsSync(createExtensionStorage(process.env).getPaths().config));
  });

  test('Migrate Now copies into XDG, keeps the legacy file, reloads and stops prompting', async () => {
    seedLegacy();
    const before = fs.readFileSync(path.join(legacy, 'config.json'), 'utf8');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Migrate Now' as never);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const m = build();
    await m.check();
    assert.strictEqual(migrated, 1);
    const config = JSON.parse(fs.readFileSync(createExtensionStorage(process.env).getPaths().config, 'utf8'));
    assert.deepStrictEqual(config.sources, [{ id: 'old', name: 'Old Source' }]);
    assert.strictEqual(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'), before);
    await m.check();
    assert.strictEqual(warn.callCount, 1, 'completed migration is not offered again');
  });

  test('active hub conflicts identify both selections and say which one was kept', async () => {
    seedLegacy();
    fs.writeFileSync(path.join(legacy, 'activeHubId.json'), JSON.stringify({ hubId: 'legacy-hub' }));
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'ai-primitives-hub');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'active-hub.json'), JSON.stringify({ hubId: 'shared-hub' }));
    sandbox.stub(vscode.window, 'showWarningMessage').resolves('Migrate Now' as never);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    await build().migrate();

    const message = String(info.lastCall?.args[0]);
    assert.match(message, /legacy-hub.*shared-hub.*kept shared XDG selection/i);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'active-hub.json'), 'utf8')), { hubId: 'shared-hub' });
  });

  test('a previous migration conflict is surfaced once on the next startup', async () => {
    seedLegacy();
    fs.writeFileSync(path.join(legacy, 'activeHubId.json'), JSON.stringify({ hubId: 'legacy-hub' }));
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'ai-primitives-hub');
    const stateDir = createExtensionStorage(process.env).getPaths().state;
    assert.ok(stateDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'active-hub.json'), JSON.stringify({ hubId: 'shared-hub' }));
    fs.writeFileSync(path.join(stateDir, 'migrations.json'), JSON.stringify({
      migrations: [{
        kind: 'legacy-storage',
        legacyRoot: legacy,
        conflicts: [{
          path: path.join(configDir, 'active-hub.json'),
          reason: 'active hub already shared-hub; kept'
        }]
      }]
    }));
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const warning = sandbox.stub(vscode.window, 'showWarningMessage');
    const migration = build();

    await migration.check();
    assert.match(String(info.firstCall?.args[0]), /legacy-hub.*shared-hub/i);
    assert.strictEqual(warning.callCount, 0, 'completed migration is explained, not rerun');
    await migration.check();
    assert.strictEqual(info.callCount, 1, 'the conflict notice is acknowledged once');
  });
});
