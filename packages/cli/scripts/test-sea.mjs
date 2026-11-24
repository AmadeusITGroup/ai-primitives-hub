import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'dist', `ai-primitives-hub-${process.platform}-${process.arch}${suffix}`);

test('standalone scanner works after relocation without worker sidecars', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-sea-security-'));
  try {
    const executable = path.join(directory, `gh-ai-primitives-hub${suffix}`);
    await copyFile(binary, executable);
    await writeFile(path.join(directory, 'clean.md'), '# Clean document\n');
    await writeFile(path.join(directory, 'secret.md'), 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n');

    for (const [file, expectedStatus, expectedScanned] of [
      ['clean.md', 0, 1],
      ['secret.md', 1, 1],
      ['.', 1, 2]
    ]) {
      const result = spawnSync(executable, [
        'security', 'scan', file, '--ci', '--ignore-trust', 'none', '-o', 'json'
      ], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, `${result.stderr}\n${result.stdout}`);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.command, 'security.scan');
      assert.equal(envelope.data.complete, true);
      assert.equal(envelope.data.coverage.scanned.length, expectedScanned);
      assert.deepEqual(envelope.data.errors, []);
      if (expectedStatus === 1) {
        assert.ok(envelope.data.findings.some((finding) =>
          finding.ruleId === 'SEC-001' && finding.vulnerableContent === '[REDACTED]'));
        assert.ok(!result.stdout.includes('sk-proj-abcdefghijklmnopqrstuvwxyz'));
      } else {
        assert.deepEqual(envelope.data.findings, []);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
