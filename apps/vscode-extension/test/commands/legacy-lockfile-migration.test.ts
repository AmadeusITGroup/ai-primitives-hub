/**
 * Legacy lockfile migration UI: insistent prompt, one question per ambiguous
 * candidate set, confirmation naming skipped entries, commit guidance.
 */
import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LegacyLockfileMigration,
} from '../../src/commands/legacy-lockfile-migration';

suite('LegacyLockfileMigration', () => {
  let sandbox: sinon.SinonSandbox;
  let legacy: boolean;
  let applied: { choices: Record<string, string> }[];
  const plan = {
    workspaceRoot: '/ws',
    lockfiles: [{ kind: 'commit', path: '/ws/prompt-registry.lock.json', version: '2.0.0' }],
    entries: [
      { bundleId: 'alpha', version: '1.0.0', outcome: 'ambiguous', candidates: ['vscode', 'copilot-cli'] },
      { bundleId: 'beta', version: '1.0.0', outcome: 'skipped', reason: 'modified: .github/prompts/beta.prompt.md', candidates: [] }
    ],
    ambiguousSets: [['vscode', 'copilot-cli']]
  };
  const session = () => ({
    hasLegacyLockfile: async () => legacy,
    planLegacyMigration: async () => plan,
    applyLegacyMigration: async (_plan: unknown, choices: Record<string, string>) => {
      applied.push({ choices });
      legacy = false;
      return {
        backup: '/state/backup.json', backups: ['/state/backup.json'],
        migrated: [{ bundleId: 'alpha', harness: 'vscode', lockfile: 'commit' }],
        skipped: [{ bundleId: 'beta', reason: 'modified' }],
        commitGuidance: 'Commit prompt-registry.lock.json: git add prompt-registry.lock.json'
      };
    }
  });
  let changed = 0;
  const migration = () => new LegacyLockfileMigration({ getRoot: () => '/ws', sessionFactory: session as never, onChanged: () => {
    changed += 1;
  } });

  setup(() => {
    sandbox = sinon.createSandbox();
    legacy = true;
    applied = [];
    changed = 0;
  });
  teardown(() => sandbox.restore());

  test('offers Migrate Now, Preview, Later in that order and re-prompts after a deferral', async () => {
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Later' as never);
    const m = migration();
    await m.check();
    assert.deepStrictEqual(warn.firstCall.args.slice(1), ['Migrate Now', 'Preview', 'Later']);
    assert.match(String(warn.firstCall.args[0]), /legacy lockfile/i);
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(await m.blocked(), true, 'still blocked after Later');
    assert.strictEqual(warn.callCount, 2, 'the prompt comes back');
  });

  test('Preview shows the plan and asks again', async () => {
    const warn = sandbox.stub(vscode.window, 'showWarningMessage');
    warn.onFirstCall().resolves('Preview' as never);
    warn.onSecondCall().resolves('Later' as never);
    const open = sandbox.stub(vscode.workspace, 'openTextDocument').resolves({} as never);
    sandbox.stub(vscode.window, 'showTextDocument').resolves({} as never);
    await migration().check();
    assert.strictEqual(warn.callCount, 2);
    assert.match(String((open.firstCall.args[0] as { content: string }).content), /"ambiguousSets"/);
  });

  test('Migrate asks once per ambiguous set, names skipped entries, applies and explains what to commit', async () => {
    const pick = sandbox.stub(vscode.window, 'showQuickPick').callsFake(async (items: any) => (await items).find((i: any) => i.label === 'vscode'));
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Migrate' as never);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    await migration().migrate();
    assert.strictEqual(pick.callCount, 1);
    assert.match(String((pick.firstCall.args[1] as { placeHolder: string }).placeHolder), /harness/i);
    const modal = String(warn.firstCall.args[0]);
    assert.match(modal, /beta: modified/);
    assert.deepStrictEqual(applied, [{ choices: { 'vscode,copilot-cli': 'vscode' } }]);
    assert.ok(info.getCalls().some((c) => /git add prompt-registry\.lock\.json/.test(String(c.args[0]))));
    assert.ok(info.getCalls().some((c) => /beta/.test(String(c.args[0]))));
    assert.strictEqual(changed, 1);
  });

  test('declining the confirmation or the harness question applies nothing', async () => {
    const pick = sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);
    await migration().migrate();
    assert.deepStrictEqual(applied, []);
    pick.callsFake(async (items: any) => (await items)[0]);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    await migration().migrate();
    assert.deepStrictEqual(applied, []);
  });

  test('no legacy lockfile: no prompt and nothing blocked', async () => {
    legacy = false;
    const warn = sandbox.stub(vscode.window, 'showWarningMessage');
    const m = migration();
    await m.check();
    assert.strictEqual(await m.blocked(), false);
    assert.strictEqual(warn.callCount, 0);
  });
});
