import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  resolveExistingPathInside,
} from '../../src/utils/path-safety';

suite('resolveExistingPathInside', () => {
  let baseDir: string;

  setup(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-path-safety-'));
  });

  teardown(() => {
    sinon.restore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('returns undefined when the base directory does not exist', async () => {
    assert.strictEqual(await resolveExistingPathInside(path.join(baseDir, 'missing'), 'prompt.md'), undefined);
  });

  test('returns undefined when the requested file does not exist', async () => {
    assert.strictEqual(await resolveExistingPathInside(baseDir, 'missing.md'), undefined);
  });

  test('resolves an existing file inside the base directory', async () => {
    fs.writeFileSync(path.join(baseDir, 'prompt.md'), 'prompt');
    assert.strictEqual(
      await resolveExistingPathInside(baseDir, 'prompt.md'),
      await fs.promises.realpath(path.join(baseDir, 'prompt.md'))
    );
  });

  test('does not swallow permission errors while resolving the base directory', async () => {
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    sinon.stub(fs.promises, 'realpath').withArgs(baseDir).rejects(error);
    await assert.rejects(resolveExistingPathInside(baseDir, 'prompt.md'), (actual) => actual === error);
  });

  test('does not swallow permission errors while resolving the requested file', async () => {
    const realBase = await fs.promises.realpath(baseDir);
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const realpath = sinon.stub(fs.promises, 'realpath');
    realpath.withArgs(baseDir).resolves(realBase);
    realpath.withArgs(path.join(realBase, 'prompt.md')).rejects(error);
    await assert.rejects(resolveExistingPathInside(baseDir, 'prompt.md'), (actual) => actual === error);
  });
});
