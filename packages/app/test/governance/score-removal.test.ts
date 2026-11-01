import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  expect,
  it,
} from 'vitest';
import {
  runGovernance,
} from '../../src/governance/run-governance';

it('preserves source mode without governance scores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'score-removal-'));
  try {
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify({
      version: '1.0.0', metadata: { name: 'Test', description: 'Test hub', maintainer: 'test', updatedAt: '2026-01-01T00:00:00Z' }, sources: [], profiles: []
    }));
    await writeFile(path.join(root, 'hub-governance.yml'), 'rules: {}\n');
    const fs = new NodeFileSystem();
    const report = await runGovernance(fs, { subject: 'hub', repoRoot: root, checkSources: true,
      sourceAdapterDeps: { fs, clock: { now: () => 0 },
        processRunner: { exec: () => Promise.reject(new Error('Unexpected process')) },
        httpClient: { fetch: () => Promise.reject(new Error('Unexpected HTTP')) } } });
    expect(report).toMatchObject({ verdict: 'pass', mode: 'sources' });
    expect(report).not.toHaveProperty('score');
    expect(report).not.toHaveProperty('minScore');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
