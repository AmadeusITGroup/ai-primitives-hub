import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveMcpServerKey,
} from '../../../src/domain/mcp/server-key';

describe('resolveMcpServerKey', () => {
  const bundleId = 'acme-org-sample-collections-sample-mcp-1.2.0';
  const repository = 'https://github.com/acme-org/sample-collections';
  const request = { bundleId, manifestId: 'sample-mcp', serverName: 'gateway' };

  it('names the server after its repository, collection id and server name, without the version', () => {
    expect(resolveMcpServerKey({ ...request, manifestRepository: repository }))
      .toBe('ai-primitives-hub:acme-org:sample-collections:sample-mcp:gateway');
  });

  it('keeps the same key across bundle versions', () => {
    const next = resolveMcpServerKey({
      ...request,
      bundleId: 'acme-org-sample-collections-sample-mcp-1.3.0',
      manifestRepository: repository
    });
    expect(next).toBe(resolveMcpServerKey({ ...request, manifestRepository: repository }));
  });

  it('gives the same key whichever source the release is installed from', () => {
    const fromHub = resolveMcpServerKey({ ...request, manifestRepository: repository, sourceRepository: repository });
    const fromMirror = resolveMcpServerKey({
      ...request,
      bundleId: 'sample-mcp',
      manifestRepository: repository,
      sourceRepository: 'https://github.com/mirror-org/mirrored-collections'
    });
    expect(fromMirror).toBe(fromHub);
  });

  it('gives different keys to the same collection id from different repositories', () => {
    const other = resolveMcpServerKey({ ...request, manifestRepository: 'https://github.com/other-org/sample-hub' });
    expect(other).toBe('ai-primitives-hub:other-org:sample-hub:sample-mcp:gateway');
    expect(other).not.toBe(resolveMcpServerKey({ ...request, manifestRepository: repository }));
  });

  it('normalises URL forms and case of the repository', () => {
    const expected = 'ai-primitives-hub:acme-org:sample-collections:sample-mcp:gateway';
    for (const form of [
      'https://github.com/Acme-Org/Sample-Collections.git',
      'git@github.com:acme-org/sample-collections.git',
      'github.com/acme-org/sample-collections/tree/main/collections',
      'acme-org/sample-collections'
    ]) {
      expect(resolveMcpServerKey({ ...request, manifestRepository: form }), form).toBe(expected);
    }
  });

  it('falls back to the source repository when the manifest has no usable repository', () => {
    for (const manifestRepository of [undefined, '', '/home/dev/sample-collections']) {
      expect(resolveMcpServerKey({ ...request, manifestRepository, sourceRepository: repository }))
        .toBe('ai-primitives-hub:acme-org:sample-collections:sample-mcp:gateway');
    }
  });

  it('uses the collection id alone when no repository is known', () => {
    expect(resolveMcpServerKey({ ...request, sourceRepository: 'file:///home/dev/sample-collections' }))
      .toBe('ai-primitives-hub:sample-mcp:gateway');
    expect(resolveMcpServerKey(request)).toBe('ai-primitives-hub:sample-mcp:gateway');
  });

  it('falls back to the bundle id when the manifest id is missing or empty', () => {
    expect(resolveMcpServerKey({ bundleId: 'local-bundle', serverName: 'gateway' }))
      .toBe('ai-primitives-hub:local-bundle:gateway');
    expect(resolveMcpServerKey({ bundleId: 'local-bundle', manifestId: '', serverName: 'gateway' }))
      .toBe('ai-primitives-hub:local-bundle:gateway');
  });
});
