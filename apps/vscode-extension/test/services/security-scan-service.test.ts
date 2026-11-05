import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  SecurityScanService,
} from '../../src/services/security-scan-service';

suite('SecurityScanService', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), '.security-scan-service-'));
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('delegates a current file scan to the shared app security use case', async () => {
    const file = path.join(tempDir, 'SKILL.md');
    await fs.writeFile(file, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n');
    const result = await new SecurityScanService().scanFile(file);

    assert.strictEqual(result.coverage.scanned.length, 1);
    assert.strictEqual(result.coverage.scanned[0]?.rootId, tempDir);
    assert.strictEqual(result.coverage.scanned[0]?.path, 'SKILL.md');
    assert.ok(result.findings.some((finding) => finding.ruleId === 'SEC-001'));
    assert.strictEqual(result.findings.find((finding) => finding.ruleId === 'SEC-001')?.vulnerableContent, '[REDACTED]');
  });

  test('cancels in-flight scans on disposal and rejects new work', async () => {
    const file = path.join(tempDir, 'SKILL.md');
    await fs.writeFile(file, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n');
    const service = new SecurityScanService();
    const pending = service.scanFile(file);
    service.dispose();

    await assert.rejects(pending, /cancelled/i);
    await assert.rejects(service.scanFile(file), /disposed/i);
    assert.strictEqual(service.getLastResult(), undefined);
  });

  test('keeps one report for all workspace roots', async () => {
    const first = path.join(tempDir, 'first');
    const second = path.join(tempDir, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'SKILL.md'), 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n');
    await fs.writeFile(path.join(second, 'SKILL.md'), 'Safe markdown');
    const service = new SecurityScanService();
    const result = await service.scanWorkspaces([first, second]);

    assert.deepStrictEqual(new Set(result.coverage.scanned.map((file) => file.rootId)), new Set([first, second]));
    assert.strictEqual(service.getLastResult(), result);
    service.dispose();
  });

  test('a newer scan of the same file supersedes old work without replacing the latest report', async () => {
    const file = path.join(tempDir, 'SKILL.md');
    await fs.writeFile(file, 'Safe markdown');
    const service = new SecurityScanService();
    const previous = service.scanFile(file);
    const current = service.scanFile(file);

    await assert.rejects(previous, /cancelled/i);
    const result = await current;
    assert.strictEqual(service.getLastResult(), result);
    service.dispose();
  });
});
