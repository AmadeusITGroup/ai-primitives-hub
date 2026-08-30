import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SecurityScanService,
} from '../../src/services/security-scan-service';

suite('SecurityScanService', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-scan-service-'));
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('delegates a current file scan to the shared app security use case', async () => {
    const file = path.join(tempDir, 'SKILL.md');
    await fs.writeFile(file, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n');
    const result = await new SecurityScanService().scanFile(file);

    assert.strictEqual(result.coverage.scanned.length, 1);
    assert.ok(result.findings.some((finding) => finding.ruleId === 'SEC-001'));
    assert.strictEqual(result.findings.find((finding) => finding.ruleId === 'SEC-001')?.vulnerableContent, '[REDACTED]');
  });
});
