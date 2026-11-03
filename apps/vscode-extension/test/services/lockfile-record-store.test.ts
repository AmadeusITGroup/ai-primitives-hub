/**
 * LockfileManagerRecordStore tests: the shared install use cases' record
 * store over the extension's two repository lockfiles.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  LockfileManagerRecordStore,
} from '../../src/services/lockfile-record-store';
import {
  Lockfile,
  LockfileBundleEntry,
} from '../../src/types/lockfile';
import {
  LockfileBuilder,
} from '../helpers/lockfile-test-helpers';

suite('LockfileManagerRecordStore', () => {
  let sandbox: sinon.SinonSandbox;
  let workspace: string;
  let manager: LockfileManager;
  let store: LockfileManagerRecordStore;

  const commitPath = () => path.join(workspace, 'prompt-registry.lock.json');
  const localPath = () => path.join(workspace, 'prompt-registry.local.lock.json');
  const readFile = (file: string): Lockfile | null =>
    (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const entryOf = (version: string, sourceId = 'src'): LockfileBundleEntry => ({
    version,
    sourceId,
    sourceType: 'github',
    installedAt: '2024-01-01T00:00:00.000Z',
    targetType: 'vscode',
    files: [{ path: `prompts/${sourceId}-${version}.prompt.md`, checksum: 'abc' }]
  });
  const seed = (file: string, bundles: Record<string, LockfileBundleEntry>): void => {
    const builder = LockfileBuilder.create();
    for (const entry of Object.values(bundles)) {
      builder.withSource(entry.sourceId, 'github', `https://github.com/owner/${entry.sourceId}`);
    }
    fs.writeFileSync(file, JSON.stringify({ ...builder.build(), bundles }, null, 2));
  };
  const source = (id = 'src') => ({ id, descriptor: { type: 'github', url: `https://github.com/owner/${id}` } });

  setup(() => {
    sandbox = sinon.createSandbox();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'record-store-'));
    LockfileManager.resetInstance();
    manager = LockfileManager.getInstance(workspace);
    store = new LockfileManagerRecordStore(manager);
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('get reads the commit lockfile first, with the commit mode of the file', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0') });
    seed(localPath(), { demo: entryOf('2.0.0'), other: entryOf('3.0.0', 'other') });

    assert.deepStrictEqual(await store.get('demo'), { entry: entryOf('1.0.0'), commitMode: 'commit' });
    assert.deepStrictEqual(await store.get('other'), { entry: entryOf('3.0.0', 'other'), commitMode: 'local-only' });
    assert.strictEqual(await store.get('absent'), undefined);
  });

  test('others returns every record of both lockfiles except the key, in either file', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0'), a: entryOf('1.0.0', 'a') });
    seed(localPath(), { demo: entryOf('2.0.0'), b: entryOf('1.0.0', 'b') });

    const others = await store.others('demo');

    assert.deepStrictEqual(others, [
      { entry: entryOf('1.0.0', 'a'), commitMode: 'commit' },
      { entry: entryOf('1.0.0', 'b'), commitMode: 'local-only' }
    ]);
  });

  test('put moves the key from the other lockfile into the target one', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0'), keep: entryOf('1.0.0', 'keep') });

    await store.put('demo', entryOf('2.0.0'), source(), 'local-only');

    assert.deepStrictEqual(readFile(localPath())?.bundles, { demo: entryOf('2.0.0') });
    assert.deepStrictEqual(Object.keys(readFile(commitPath())?.bundles ?? {}), ['keep']);
  });

  test('put defaults to the commit lockfile', async () => {
    await store.put('demo', entryOf('1.0.0'), source());

    assert.deepStrictEqual(readFile(commitPath())?.bundles, { demo: entryOf('1.0.0') });
    assert.strictEqual(readFile(localPath()), null);
  });

  test('a failing removal from the other lockfile makes put reject and keeps the key only where it was', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0') });
    sandbox.stub(manager, 'removeFromMode').rejects(new Error('EBUSY: commit lockfile locked'));

    await assert.rejects(store.put('demo', entryOf('2.0.0'), source(), 'local-only'), /commit lockfile locked/);

    assert.deepStrictEqual(readFile(commitPath())?.bundles, { demo: entryOf('1.0.0') });
    assert.strictEqual(readFile(localPath()), null, 'the local lockfile the put created is gone');
  });

  test('a failing removal restores the previous entry of the target lockfile', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0') });
    seed(localPath(), { demo: entryOf('0.9.0'), keep: entryOf('1.0.0', 'keep') });
    sandbox.stub(manager, 'removeFromMode').rejects(new Error('EBUSY: commit lockfile locked'));

    await assert.rejects(store.put('demo', entryOf('2.0.0'), source(), 'local-only'), /commit lockfile locked/);

    assert.deepStrictEqual(readFile(localPath())?.bundles, { demo: entryOf('0.9.0'), keep: entryOf('1.0.0', 'keep') });
    assert.deepStrictEqual(readFile(commitPath())?.bundles, { demo: entryOf('1.0.0') });
  });

  test('a failing removal drops the key it added to an existing target lockfile', async () => {
    seed(commitPath(), { demo: entryOf('1.0.0') });
    seed(localPath(), { keep: entryOf('1.0.0', 'keep') });
    sandbox.stub(manager, 'removeFromMode').rejects(new Error('EBUSY: commit lockfile locked'));

    await assert.rejects(store.put('demo', entryOf('2.0.0'), source(), 'local-only'), /commit lockfile locked/);

    assert.deepStrictEqual(readFile(localPath())?.bundles, { keep: entryOf('1.0.0', 'keep') });
    assert.deepStrictEqual(readFile(commitPath())?.bundles, { demo: entryOf('1.0.0') });
  });

  test('remove of the last entry deletes the lockfile', async () => {
    seed(localPath(), { demo: entryOf('1.0.0') });

    await store.remove('demo');

    assert.strictEqual(fs.existsSync(localPath()), false);
  });
});
