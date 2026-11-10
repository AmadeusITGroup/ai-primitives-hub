import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  decodeLockfileV3,
  encodeLockfileV3,
  LOCKFILE_V3_SCHEMA_ID,
  LOCKFILE_V3_VERSION,
  type RuntimeProjectionReceipt,
  runtimeReceiptId,
} from '../../../src/domain';

const SHA = `sha256:${'a'.repeat(64)}`;
const WS = '/work/repo';
const HOME = '/home/user';

function receipt(over: Partial<RuntimeProjectionReceipt> & { scope: 'user' | 'repository' }): RuntimeProjectionReceipt {
  const root = over.scope === 'repository' ? `${WS}/.kiro` : `${HOME}/.kiro/steering`;
  const outDir = over.scope === 'repository' ? `${WS}/.kiro/steering` : root;
  const collection = { sourceId: 'src', manifestId: 'alpha' };
  const instance = { type: 'kiro' as const, scope: over.scope, root };
  return {
    receiptId: runtimeReceiptId('kiro', over.scope, root, collection.sourceId, collection.manifestId, over.scope === 'repository' ? WS : undefined),
    instance,
    collection,
    payloadId: 'payload-aaaa',
    version: '1.0.0',
    outputs: { [`${outDir}/alpha.prompt.md`]: { sha256: SHA, mode: 0o644 } },
    installedAt: '2026-01-01T00:00:00.000Z',
    ...(over.scope === 'repository' ? { contextRoot: WS, commitMode: 'commit' as const } : {}),
    ...over
  };
}

const stateOf = (...receipts: RuntimeProjectionReceipt[]) => ({
  receipts: Object.fromEntries(receipts.map((r) => [r.receiptId, r]))
});

describe('lockfile v3 (records only)', () => {
  it('writes only the contract keys, version 3.0.0 and the published schema URL', () => {
    const doc = encodeLockfileV3(stateOf(receipt({ scope: 'user' })), 'ai-primitives-hub@9.9.9');
    expect(LOCKFILE_V3_VERSION).toBe('3.0.0');
    expect(Object.keys(doc).toSorted()).toEqual(['$schema', 'bundles', 'generatedAt', 'generatedBy', 'sources', 'version']);
    expect(doc.version).toBe('3.0.0');
    expect(doc.$schema).toBe(LOCKFILE_V3_SCHEMA_ID);
    expect(doc.generatedBy).toBe('ai-primitives-hub@9.9.9');
    expect(Object.keys(doc).toSorted()).toEqual(['$schema', 'bundles', 'generatedAt', 'generatedBy', 'sources', 'version']);
  });

  it('records source, bundleId, installationId and checksums; repository paths are workspace-relative', () => {
    const repo = receipt({
      scope: 'repository',
      source: { type: 'github', url: 'https://github.com/o/r' },
      registryRef: { bundleId: 'o-r-alpha', sourceType: 'github' }
    });
    const user = receipt({ scope: 'user', collection: { sourceId: 'src', manifestId: 'beta' } });
    const doc = encodeLockfileV3(stateOf(repo, user), 'g');
    expect(doc.sources.src).toEqual({ type: 'github', url: 'https://github.com/o/r' });
    const bundles = Object.values(doc.bundles);
    const alpha = bundles.find((b) => b.manifestId === 'alpha')!;
    expect(alpha.bundleId).toBe('o-r-alpha');
    const inst = Object.values(alpha.tools.kiro!.instances)[0];
    expect(inst.installationId).toBe(repo.receiptId);
    expect(inst.files).toEqual([{ path: '.kiro/steering/alpha.prompt.md', checksum: SHA, mode: 0o644 }]);
    const beta = bundles.find((b) => b.manifestId === 'beta')!;
    expect(beta.bundleId).toBe('beta');
    expect(Object.values(beta.tools.kiro!.instances)[0].files[0].path).toBe('alpha.prompt.md');
  });

  it('round-trips receipts, source and registry reference', () => {
    const repo = receipt({
      scope: 'repository',
      source: { type: 'local', url: '/abs/dir' },
      registryRef: { bundleId: 'alpha', sourceType: 'local' }
    });
    const doc = encodeLockfileV3(stateOf(repo), 'g');
    const decoded = decodeLockfileV3(structuredClone(doc), { repositoryRoot: WS });
    expect(decoded.sources.src).toEqual({ type: 'local', url: '/abs/dir' });
    expect(decoded.receipts[repo.receiptId]).toMatchObject({
      receiptId: repo.receiptId,
      instance: repo.instance,
      collection: repo.collection,
      payloadId: 'payload-aaaa',
      version: '1.0.0',
      outputs: repo.outputs,
      contextRoot: WS,
      registryRef: { bundleId: 'alpha', sourceType: 'local' }
    });
  });

  it('records no machine-specific paths for repository rows and keeps the identity when the repository moves', () => {
    const repo = receipt({ scope: 'repository' });
    const doc = structuredClone(encodeLockfileV3(stateOf(repo), 'g'));
    const bundle = Object.values(doc.bundles)[0] as { tools: { kiro: { instances: Record<string, Record<string, unknown>> } } };
    const inst = Object.values(bundle.tools.kiro.instances)[0];
    expect(inst.root).toBe('.kiro');
    expect(inst).not.toHaveProperty('contextRoot');
    expect(inst).not.toHaveProperty('commitMode');
    expect(JSON.stringify(doc)).not.toContain(WS);
    const moved = decodeLockfileV3(doc, { repositoryRoot: '/other/place/repo' });
    const [row] = Object.values(moved.receipts);
    expect(row.receiptId).toBe(repo.receiptId);
    expect(row.instance.root).toBe('/other/place/repo/.kiro');
    expect(Object.keys(row.outputs)).toEqual(['/other/place/repo/.kiro/steering/alpha.prompt.md']);
    expect(() => decodeLockfileV3(doc)).toThrow(/repository context/);
  });

  it('rejects earlier prerelease versions, extra top-level sections and forged installation ids', () => {
    const doc = structuredClone(encodeLockfileV3(stateOf(receipt({ scope: 'user' })), 'g'));
    expect(() => decodeLockfileV3({ ...doc, version: '4.0.0' })).toThrow(/unsupported version/);
    expect(() => decodeLockfileV3({ ...doc, 'x-state': {} })).toThrow(/unexpected top-level/);
    const forged = structuredClone(doc);
    const bundle = Object.values(forged.bundles)[0] as { tools: { kiro: { instances: Record<string, { installationId: string }> } } };
    Object.values(bundle.tools.kiro.instances)[0].installationId = 'rcpt-forged';
    expect(() => decodeLockfileV3(forged)).toThrow(/installationId/);
  });

  it('rejects recorded paths that escape the instance base', () => {
    const doc = structuredClone(encodeLockfileV3(stateOf(receipt({ scope: 'user' })), 'g'));
    const bundle = Object.values(doc.bundles)[0] as { tools: { kiro: { instances: Record<string, { files: { path: string }[] }> } } };
    Object.values(bundle.tools.kiro.instances)[0].files[0].path = '../escape.md';
    expect(() => decodeLockfileV3(doc)).toThrow(/unsafe file/);
  });
});
