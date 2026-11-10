/**
 * External (CLI) changes to the shared target files notify the extension.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  watchedTargetFiles,
  watchTargetFiles,
} from '../../src/commands/runtime-target-watch';

suite('runtime target external-change watcher', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('watches the user lockfile, selection file and workspace lockfiles', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-watch-'));
    try {
      const files = watchedTargetFiles({ HOME: root, XDG_DATA_HOME: path.join(root, 'd'), XDG_STATE_HOME: path.join(root, 's') });
      assert.ok(files.includes(path.join(root, 'd', 'ai-primitives-hub', 'ai-primitives-hub.lock.json')));
      assert.ok(files.includes(path.join(root, 's', 'ai-primitives-hub', 'target-selection.json')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a lockfile written by another process triggers a debounced refresh', async function () {
    this.timeout(8000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-watch-'));
    const env = { HOME: root, XDG_DATA_HOME: path.join(root, 'd'), XDG_STATE_HOME: path.join(root, 's') };
    let changes = 0;
    const watcher = watchTargetFiles(env, () => {
      changes += 1;
    });
    try {
      const lock = path.join(root, 'd', 'ai-primitives-hub', 'ai-primitives-hub.lock.json');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      await sleep(400);
      fs.writeFileSync(lock, '{}');
      const deadline = Date.now() + 5000;
      while (changes === 0 && Date.now() < deadline) {
        await sleep(100);
      }
      assert.ok(changes >= 1, 'change observed');
      fs.writeFileSync(lock, '{"a":1}');
      fs.writeFileSync(lock, '{"a":2}');
      await sleep(1200);
      assert.ok(changes <= 3, `bursts are debounced (saw ${changes})`);
    } finally {
      watcher.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
