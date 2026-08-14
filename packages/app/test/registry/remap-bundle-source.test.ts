/**
 * Tests for registry/remap-bundle-source.ts — the shared bundle-source
 * remap use case.
 *
 * Cycle A covers the resolve-first-or-throw guarantee: when the
 * replacement source id is absent from stored sources the call rejects
 * naming that id, and nothing — neither the repository-scope lockfile nor
 * a single installation record — has been written. That ordering is what
 * lets the caller keep an orphan alive instead of deleting a source whose
 * repository-scope bundles were never migrated.
 *
 * Cycle B covers the happy path across the three stores: the
 * Replacement_Descriptor is built from the resolved replacement's `type`,
 * `url`, `config?.branch` and `config?.collectionsPath` and handed to the
 * repository-scope lockfile port exactly once, then user scope and
 * workspace scope are rewritten — and only for the records that actually
 * referenced the old source id, leaving every other record and every
 * other field byte-identical.
 *
 * Cycle C covers the absent repository-scope port: no workspace root means
 * no lockfile port is wired, and that is a valid skip rather than a
 * failure. Repository-scope bundles only exist inside an open workspace, so
 * there is nothing to migrate and rejecting here would block an otherwise
 * valid user-scope and workspace-scope remap.
 *
 * Cycle D is a regression guard rather than a red test: retry idempotence
 * already follows from Cycle B's `sourceId === oldSourceId` filter, since a
 * record carrying the new id no longer matches. The guard locks that
 * property in — a run over a partially completed record set finishes the
 * remainder and leaves finished records byte-identical, and a further run
 * changes nothing at all.
 */
import type {
  BundleSourceRemap,
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  remapBundleSource,
} from '../../src/registry/remap-bundle-source';

function makeRegistrySource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'source-old',
    name: 'Old Source',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

function makeInstalled(overrides: Partial<InstalledBundle> = {}): InstalledBundle {
  return {
    bundleId: 'bundle-1',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    installPath: '/mock/path',
    sourceId: 'source-old',
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: {
        include_common_in_environment_bundles: false,
        create_common_bundle: false,
        compression: 'none',
        naming: { environment_bundle: 'bundle-1' }
      },
      metadata: { manifest_version: '1.0.0', description: 'Test' }
    },
    ...overrides
  };
}

/**
 * In-memory `BundleSourceRemap` recording every call, with the
 * repository-scope lockfile port wired by default so its absence can be
 * asserted separately from its non-invocation.
 * @param sources
 * @param installed
 */
function makePorts(
  sources: RegistrySource[] = [],
  installed: InstalledBundle[] = []
): BundleSourceRemap & {
  listSources: ReturnType<typeof vi.fn>;
  remapLockfileSourceId: ReturnType<typeof vi.fn>;
  getInstalledBundles: ReturnType<typeof vi.fn>;
  recordInstallation: ReturnType<typeof vi.fn>;
  records: InstalledBundle[];
} {
  const records = [...installed];
  return {
    records,
    listSources: vi.fn(async () => [...sources]),
    remapLockfileSourceId: vi.fn(async () => {}),
    getInstalledBundles: vi.fn(async (scope) => records.filter((r) => r.scope === scope)),
    recordInstallation: vi.fn(async (bundle: InstalledBundle) => {
      const index = records.findIndex((r) => r.bundleId === bundle.bundleId && r.scope === bundle.scope);
      if (index === -1) {
        records.push(bundle);
      } else {
        records[index] = bundle;
      }
    })
  };
}

describe('remapBundleSource', () => {
  it('rejects naming the replacement source id when it is absent from stored sources', async () => {
    const ports = makePorts([makeRegistrySource({ id: 'source-old' })], [makeInstalled()]);

    await expect(remapBundleSource('source-old', 'source-new', ports)).rejects.toThrow(/source-new/);
  });

  it('writes no installation record when the replacement source id cannot be resolved', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: 'source-old' })],
      [makeInstalled(), makeInstalled({ bundleId: 'bundle-2', scope: 'workspace' })]
    );

    await expect(remapBundleSource('source-old', 'source-new', ports)).rejects.toThrow();

    expect(ports.recordInstallation).not.toHaveBeenCalled();
    expect(ports.records.every((r) => r.sourceId === 'source-old')).toBe(true);
  });

  it('does not touch the repository-scope lockfile when the replacement source id cannot be resolved', async () => {
    const ports = makePorts([makeRegistrySource({ id: 'source-old' })], [makeInstalled()]);

    await expect(remapBundleSource('source-old', 'source-new', ports)).rejects.toThrow();

    expect(ports.remapLockfileSourceId).not.toHaveBeenCalled();
  });
});

const OLD_ID = 'source-old';
const NEW_ID = 'source-new';

/**
 * The replacement source the happy path resolves, carrying distinct
 * `type`/`url`/`config` values so the descriptor cannot accidentally match
 * by reusing the orphan's own fields.
 * @param overrides
 */
function makeReplacement(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return makeRegistrySource({
    id: NEW_ID,
    name: 'Renamed Source',
    type: 'github',
    url: 'https://github.com/org/renamed',
    config: { branch: 'release', collectionsPath: 'curated' },
    ...overrides
  });
}

/**
 * A record set spanning every scope and both referencing states: two
 * records point at the old source id in user and workspace scope, two do
 * not, and one repository-scope record belongs to the lockfile port rather
 * than to `recordInstallation`.
 */
function makeMixedRecords(): InstalledBundle[] {
  return [
    makeInstalled({ bundleId: 'user-migrating', scope: 'user', sourceId: OLD_ID }),
    makeInstalled({ bundleId: 'user-unrelated', scope: 'user', sourceId: 'source-other' }),
    makeInstalled({ bundleId: 'workspace-migrating', scope: 'workspace', sourceId: OLD_ID }),
    makeInstalled({ bundleId: 'workspace-unrelated', scope: 'workspace', sourceId: undefined }),
    makeInstalled({ bundleId: 'repository-migrating', scope: 'repository', sourceId: OLD_ID })
  ];
}

describe('remapBundleSource — happy path across the three stores', () => {
  it('builds the replacement descriptor from the resolved source type, url, branch and collectionsPath', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.remapLockfileSourceId).toHaveBeenCalledWith(OLD_ID, NEW_ID, {
      type: 'github',
      url: 'https://github.com/org/renamed',
      branch: 'release',
      collectionsPath: 'curated'
    });
  });

  it('calls the repository-scope lockfile port exactly once', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.remapLockfileSourceId).toHaveBeenCalledTimes(1);
  });

  it('omits branch and collectionsPath from the descriptor when the replacement carries no config', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement({ config: undefined })],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.remapLockfileSourceId).toHaveBeenCalledWith(OLD_ID, NEW_ID, {
      type: 'github',
      url: 'https://github.com/org/renamed',
      branch: undefined,
      collectionsPath: undefined
    });
  });

  it('rewrites only the user-scope and workspace-scope records referencing the old source id', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const rewritten = ports.recordInstallation.mock.calls.map(([bundle]) => bundle as InstalledBundle);

    expect(rewritten.map((b) => b.bundleId).toSorted()).toEqual(['user-migrating', 'workspace-migrating']);
    expect(rewritten.every((b) => b.sourceId === NEW_ID)).toBe(true);
  });

  it('reads installation records for the user and workspace scopes only', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const scopes = ports.getInstalledBundles.mock.calls.map(([scope]) => scope as string);

    expect(scopes.toSorted()).toEqual(['user', 'workspace']);
  });

  it('changes only the sourceId of a rewritten record, leaving every other field untouched', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );
    const before = makeInstalled({ bundleId: 'user-migrating', scope: 'user', sourceId: OLD_ID });

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.records.find((r) => r.bundleId === 'user-migrating' && r.scope === 'user'))
      .toEqual({ ...before, sourceId: NEW_ID });
  });

  it('leaves every non-referencing record and every repository-scope record byte-identical', async () => {
    const ports = makePorts(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );
    const before = makeMixedRecords();

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    for (const bundleId of ['user-unrelated', 'workspace-unrelated', 'repository-migrating']) {
      expect(ports.records.find((r) => r.bundleId === bundleId))
        .toEqual(before.find((r) => r.bundleId === bundleId));
    }
  });
});
/**
 * The same in-memory ports without the repository-scope lockfile port,
 * modelling a host with no workspace root: `remapLockfileSourceId` is
 * optional on `BundleSourceRemap`, and its absence must read as "no
 * repository in scope", not as an error condition.
 * @param sources
 * @param installed
 */
function makePortsWithoutLockfile(
  sources: RegistrySource[] = [],
  installed: InstalledBundle[] = []
): Omit<ReturnType<typeof makePorts>, 'remapLockfileSourceId'> {
  const ports = makePorts(sources, installed);
  delete (ports as Partial<ReturnType<typeof makePorts>>).remapLockfileSourceId;

  return ports;
}

describe('remapBundleSource — no workspace root', () => {
  it('resolves rather than rejecting when the repository-scope lockfile port is absent', async () => {
    const ports = makePortsWithoutLockfile(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await expect(remapBundleSource(OLD_ID, NEW_ID, ports)).resolves.toBeUndefined();
  });

  it('still completes the user-scope and workspace-scope remap when the lockfile port is absent', async () => {
    const ports = makePortsWithoutLockfile(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const rewritten = ports.recordInstallation.mock.calls.map(([bundle]) => bundle as InstalledBundle);

    expect(rewritten.map((b) => b.bundleId).toSorted()).toEqual(['user-migrating', 'workspace-migrating']);
    expect(rewritten.every((b) => b.sourceId === NEW_ID)).toBe(true);
  });

  it('leaves non-referencing and repository-scope records untouched when the lockfile port is absent', async () => {
    const ports = makePortsWithoutLockfile(
      [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
      makeMixedRecords()
    );
    const before = makeMixedRecords();

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    for (const bundleId of ['user-unrelated', 'workspace-unrelated', 'repository-migrating']) {
      expect(ports.records.find((r) => r.bundleId === bundleId))
        .toEqual(before.find((r) => r.bundleId === bundleId));
    }
  });
});

/**
 * The record set a crashed first run leaves behind: `user-done` and
 * `workspace-done` already carry the new source id, `user-pending` and
 * `workspace-pending` still carry the old one, and the unrelated and
 * repository-scope records are there to catch collateral writes.
 */
function makePartiallyRemappedRecords(): InstalledBundle[] {
  return [
    makeInstalled({ bundleId: 'user-done', scope: 'user', sourceId: NEW_ID }),
    makeInstalled({ bundleId: 'user-pending', scope: 'user', sourceId: OLD_ID }),
    makeInstalled({ bundleId: 'workspace-done', scope: 'workspace', sourceId: NEW_ID }),
    makeInstalled({ bundleId: 'workspace-pending', scope: 'workspace', sourceId: OLD_ID }),
    makeInstalled({ bundleId: 'user-unrelated', scope: 'user', sourceId: 'source-other' }),
    makeInstalled({ bundleId: 'repository-pending', scope: 'repository', sourceId: OLD_ID })
  ];
}

/**
 * Ports seeded with that partially completed state, so the invocation under
 * test is the retry rather than the first attempt.
 */
function makeRetryPorts(): ReturnType<typeof makePorts> {
  return makePorts(
    [makeRegistrySource({ id: OLD_ID }), makeReplacement()],
    makePartiallyRemappedRecords()
  );
}

describe('remapBundleSource — retry after a partially completed run', () => {
  it('rewrites only the records that still carry the old source id', async () => {
    const ports = makeRetryPorts();

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    const rewritten = ports.recordInstallation.mock.calls.map(([bundle]) => bundle as InstalledBundle);

    expect(rewritten.map((b) => b.bundleId).toSorted()).toEqual(['user-pending', 'workspace-pending']);
    expect(rewritten.every((b) => b.sourceId === NEW_ID)).toBe(true);
  });

  it('leaves already-remapped records byte-identical', async () => {
    const ports = makeRetryPorts();
    const before = makePartiallyRemappedRecords();

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    for (const bundleId of ['user-done', 'workspace-done']) {
      expect(ports.records.find((r) => r.bundleId === bundleId))
        .toEqual(before.find((r) => r.bundleId === bundleId));
    }
  });

  it('leaves the whole record set fully remapped and otherwise untouched after the retry', async () => {
    const ports = makeRetryPorts();
    const expected = makePartiallyRemappedRecords().map((r) =>
      r.sourceId === OLD_ID && r.scope !== 'repository' ? { ...r, sourceId: NEW_ID } : r);

    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.records.toSorted((a, b) => a.bundleId.localeCompare(b.bundleId)))
      .toEqual(expected.toSorted((a, b) => a.bundleId.localeCompare(b.bundleId)));
  });

  it('writes no installation record on a third invocation', async () => {
    const ports = makeRetryPorts();

    await remapBundleSource(OLD_ID, NEW_ID, ports);
    ports.recordInstallation.mockClear();
    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.recordInstallation).not.toHaveBeenCalled();
  });

  it('leaves every record identical across a third invocation', async () => {
    const ports = makeRetryPorts();

    await remapBundleSource(OLD_ID, NEW_ID, ports);
    const afterSecond = structuredClone(ports.records);
    await remapBundleSource(OLD_ID, NEW_ID, ports);

    expect(ports.records).toEqual(afterSecond);
  });
});
