/**
 * Tests for lockfileTestHelpers
 *
 * Verifies that the LockfileBuilder, factory functions, and generators
 * work correctly for creating test lockfile data.
 */
import * as assert from 'node:assert';
import * as fc from 'fast-check';
import {
  createMockBundleEntry,
  createMockFileEntry,
  createMockHubEntry,
  createMockLockfile,
  createMockProfileEntry,
  createMockSourceEntry,
  generateMockChecksum,
  LOCKFILE_DEFAULTS,
  LockfileBuilder,
  LockfileGenerators,
} from './lockfile-test-helpers';

suite('lockfileTestHelpers', () => {
  suite('LockfileBuilder', () => {
    test('should create empty lockfile with defaults', () => {
      const lockfile = LockfileBuilder.create().build();

      assert.strictEqual(lockfile.$schema, LOCKFILE_DEFAULTS.SCHEMA_URL);
      assert.strictEqual(lockfile.version, LOCKFILE_DEFAULTS.VERSION);
      assert.strictEqual(lockfile.generatedBy, LOCKFILE_DEFAULTS.GENERATED_BY);
      assert.deepStrictEqual(lockfile.bundles, {});
      assert.deepStrictEqual(lockfile.sources, {});
      assert.ok(lockfile.generatedAt);
    });

    test('should add bundle with default values', () => {
      const lockfile = LockfileBuilder.create()
        .withBundle('test-bundle', '1.0.0', 'test-source')
        .build();

      assert.ok(lockfile.bundles['test-bundle']);
      assert.strictEqual(lockfile.bundles['test-bundle'].version, '1.0.0');
      assert.strictEqual(lockfile.bundles['test-bundle'].sourceId, 'test-source');
      assert.strictEqual(lockfile.bundles['test-bundle'].sourceType, 'github');
      assert.strictEqual(lockfile.bundles['test-bundle'].commitMode, 'commit');
      assert.deepStrictEqual(lockfile.bundles['test-bundle'].files, []);
    });

    test('should add bundle with custom options', () => {
      const lockfile = LockfileBuilder.create()
        .withBundle('test-bundle', '2.0.0', 'local-source', {
          sourceType: 'local',
          commitMode: 'local-only',
          checksum: 'abc123'
        })
        .build();

      const bundle = lockfile.bundles['test-bundle'];
      assert.strictEqual(bundle.sourceType, 'local');
      assert.strictEqual(bundle.commitMode, 'local-only');
      assert.strictEqual(bundle.checksum, 'abc123');
    });

    test('should add bundle with files', () => {
      const files = [
        { path: '.github/prompts/test.prompt.md', checksum: 'abc123' }
      ];
      const lockfile = LockfileBuilder.create()
        .withBundleAndFiles('test-bundle', '1.0.0', 'test-source', files)
        .build();

      assert.deepStrictEqual(lockfile.bundles['test-bundle'].files, files);
    });

    test('should add source entry', () => {
      const lockfile = LockfileBuilder.create()
        .withSource('github-source', 'github', 'https://github.com/owner/repo', 'main')
        .build();

      assert.ok(lockfile.sources['github-source']);
      assert.strictEqual(lockfile.sources['github-source'].type, 'github');
      assert.strictEqual(lockfile.sources['github-source'].url, 'https://github.com/owner/repo');
      assert.strictEqual(lockfile.sources['github-source'].branch, 'main');
    });

    test('should add source entry without branch', () => {
      const lockfile = LockfileBuilder.create()
        .withSource('http-source', 'http', 'https://example.com/bundles')
        .build();

      assert.ok(lockfile.sources['http-source']);
      assert.strictEqual(lockfile.sources['http-source'].branch, undefined);
    });

    test('should add hub entry', () => {
      const lockfile = LockfileBuilder.create()
        .withHub('my-hub', 'My Hub', 'https://hub.example.com')
        .build();

      assert.ok(lockfile.hubs);
      assert.ok(lockfile.hubs['my-hub']);
      assert.strictEqual(lockfile.hubs['my-hub'].name, 'My Hub');
      assert.strictEqual(lockfile.hubs['my-hub'].url, 'https://hub.example.com');
    });

    test('should add profile entry', () => {
      const lockfile = LockfileBuilder.create()
        .withProfile('my-profile', 'My Profile', ['bundle-1', 'bundle-2'])
        .build();

      assert.ok(lockfile.profiles);
      assert.ok(lockfile.profiles['my-profile']);
      assert.strictEqual(lockfile.profiles['my-profile'].name, 'My Profile');
      assert.deepStrictEqual(lockfile.profiles['my-profile'].bundleIds, ['bundle-1', 'bundle-2']);
    });

    test('should support fluent chaining', () => {
      const lockfile = LockfileBuilder.create()
        .withVersion('2.0.0')
        .withGeneratedBy('test-extension@1.0.0')
        .withSource('src-1', 'github', 'https://github.com/test/repo')
        .withBundle('bundle-1', '1.0.0', 'src-1')
        .withBundle('bundle-2', '2.0.0', 'src-1')
        .withHub('hub-1', 'Test Hub', 'https://hub.test.com')
        .withProfile('profile-1', 'Test Profile', ['bundle-1', 'bundle-2'])
        .build();

      assert.strictEqual(lockfile.version, '2.0.0');
      assert.strictEqual(lockfile.generatedBy, 'test-extension@1.0.0');
      assert.strictEqual(Object.keys(lockfile.bundles).length, 2);
      assert.strictEqual(Object.keys(lockfile.sources).length, 1);
      assert.ok(lockfile.hubs);
      assert.ok(lockfile.profiles);
    });
  });

  suite('createMockLockfile', () => {
    test('should create lockfile with specified bundle count', () => {
      const lockfile = createMockLockfile(3);

      assert.strictEqual(Object.keys(lockfile.bundles).length, 3);
      assert.ok(lockfile.bundles['bundle-0']);
      assert.ok(lockfile.bundles['bundle-1']);
      assert.ok(lockfile.bundles['bundle-2']);
    });

    test('should create empty lockfile with zero bundles', () => {
      const lockfile = createMockLockfile(0);

      assert.strictEqual(Object.keys(lockfile.bundles).length, 0);
      assert.strictEqual(Object.keys(lockfile.sources).length, 1); // Source still exists
    });

    test('should include files when requested', () => {
      const lockfile = createMockLockfile(1, { includeFiles: true });

      assert.ok(lockfile.bundles['bundle-0'].files.length > 0);
      assert.ok(lockfile.bundles['bundle-0'].files[0].path);
      assert.ok(lockfile.bundles['bundle-0'].files[0].checksum);
      assert.strictEqual(lockfile.bundles['bundle-0'].files[0].checksum.length, 64);
    });

    test('should include hubs when requested', () => {
      const lockfile = createMockLockfile(1, { includeHubs: true });

      assert.ok(lockfile.hubs);
      assert.ok(lockfile.hubs['mock-hub']);
      assert.strictEqual(lockfile.hubs['mock-hub'].name, 'Mock Hub');
    });

    test('should include profiles when requested', () => {
      const lockfile = createMockLockfile(2, { includeProfiles: true });

      assert.ok(lockfile.profiles);
      assert.ok(lockfile.profiles['mock-profile']);
      assert.deepStrictEqual(lockfile.profiles['mock-profile'].bundleIds, ['bundle-0', 'bundle-1']);
    });

    test('should use specified commit mode', () => {
      const lockfile = createMockLockfile(2, { commitMode: 'local-only' });

      assert.strictEqual(lockfile.bundles['bundle-0'].commitMode, 'local-only');
      assert.strictEqual(lockfile.bundles['bundle-1'].commitMode, 'local-only');
    });

    test('should use specified source type', () => {
      const lockfile = createMockLockfile(1, { sourceType: 'local' });

      assert.strictEqual(lockfile.bundles['bundle-0'].sourceType, 'local');
      assert.strictEqual(lockfile.sources['mock-source'].type, 'local');
    });
  });

  suite('Factory functions', () => {
    test('createMockBundleEntry should create valid entry', () => {
      const entry = createMockBundleEntry('test-bundle', '1.0.0');

      assert.strictEqual(entry.version, '1.0.0');
      assert.strictEqual(entry.sourceId, 'mock-source');
      assert.strictEqual(entry.sourceType, 'github');
      assert.strictEqual(entry.commitMode, 'commit');
      assert.ok(entry.installedAt);
      assert.deepStrictEqual(entry.files, []);
    });

    test('createMockBundleEntry should accept overrides', () => {
      const entry = createMockBundleEntry('test-bundle', '2.0.0', {
        sourceId: 'custom-source',
        sourceType: 'local',
        commitMode: 'local-only'
      });

      assert.strictEqual(entry.sourceId, 'custom-source');
      assert.strictEqual(entry.sourceType, 'local');
      assert.strictEqual(entry.commitMode, 'local-only');
    });

    test('createMockFileEntry should create valid entry', () => {
      const entry = createMockFileEntry('.github/prompts/test.prompt.md');

      assert.strictEqual(entry.path, '.github/prompts/test.prompt.md');
      assert.strictEqual(entry.checksum.length, 64);
      assert.ok(/^[0-9a-f]{64}$/.test(entry.checksum));
    });

    test('createMockFileEntry should accept custom checksum', () => {
      const checksum = 'a'.repeat(64);
      const entry = createMockFileEntry('.github/prompts/test.prompt.md', checksum);

      assert.strictEqual(entry.checksum, checksum);
    });

    test('createMockSourceEntry should create valid entry', () => {
      const entry = createMockSourceEntry('github', 'https://github.com/test/repo', 'main');

      assert.strictEqual(entry.type, 'github');
      assert.strictEqual(entry.url, 'https://github.com/test/repo');
      assert.strictEqual(entry.branch, 'main');
    });

    test('createMockSourceEntry should work without branch', () => {
      const entry = createMockSourceEntry('http', 'https://example.com');

      assert.strictEqual(entry.type, 'http');
      assert.strictEqual(entry.url, 'https://example.com');
      assert.strictEqual(entry.branch, undefined);
    });

    test('createMockHubEntry should create valid entry', () => {
      const entry = createMockHubEntry('Test Hub', 'https://hub.test.com');

      assert.strictEqual(entry.name, 'Test Hub');
      assert.strictEqual(entry.url, 'https://hub.test.com');
    });

    test('createMockProfileEntry should create valid entry', () => {
      const entry = createMockProfileEntry('Test Profile', ['bundle-1', 'bundle-2']);

      assert.strictEqual(entry.name, 'Test Profile');
      assert.deepStrictEqual(entry.bundleIds, ['bundle-1', 'bundle-2']);
    });

    test('generateMockChecksum should create valid SHA256 checksum', () => {
      const checksum = generateMockChecksum();

      assert.strictEqual(checksum.length, 64);
      assert.ok(/^[0-9a-f]{64}$/.test(checksum));
    });
  });

  suite('LockfileGenerators', () => {
    test('checksum generator should produce valid SHA256 checksums', () => {
      fc.assert(
        fc.property(LockfileGenerators.checksum(), (checksum) => {
          return checksum.length === 64 && /^[0-9a-f]{64}$/.test(checksum);
        }),
        { numRuns: 20 }
      );
    });

    test('version generator should produce valid semver strings', () => {
      fc.assert(
        fc.property(LockfileGenerators.version(), (version) => {
          return /^\d+\.\d+\.\d+$/.test(version);
        }),
        { numRuns: 20 }
      );
    });

    test('bundleId generator should produce valid IDs', () => {
      fc.assert(
        fc.property(LockfileGenerators.bundleId(), (id) => {
          return id.length > 0 && /^[a-z0-9-]+$/.test(id);
        }),
        { numRuns: 20 }
      );
    });

    test('sourceType generator should produce valid types', () => {
      const validTypes = [
        'github', 'local', 'awesome-copilot',
        'local-awesome-copilot', 'apm', 'local-apm'
      ];
      fc.assert(
        fc.property(LockfileGenerators.sourceType(), (type) => {
          return validTypes.includes(type);
        }),
        { numRuns: 20 }
      );
    });

    test('commitMode generator should produce valid modes', () => {
      fc.assert(
        fc.property(LockfileGenerators.commitMode(), (mode) => {
          return mode === 'commit' || mode === 'local-only';
        }),
        { numRuns: 20 }
      );
    });

    test('isoTimestamp generator should produce valid ISO timestamps', () => {
      fc.assert(
        fc.property(LockfileGenerators.isoTimestamp(), (timestamp) => {
          const date = new Date(timestamp);
          return !Number.isNaN(date.getTime()) && timestamp.includes('T');
        }),
        { numRuns: 20 }
      );
    });

    test('fileEntry generator should produce valid entries', () => {
      fc.assert(
        fc.property(LockfileGenerators.fileEntry(), (entry) => {
          return (
            entry.path.length > 0
            && entry.checksum.length === 64
            && /^[0-9a-f]{64}$/.test(entry.checksum)
          );
        }),
        { numRuns: 20 }
      );
    });

    test('sourceEntry generator should produce valid entries', () => {
      fc.assert(
        fc.property(LockfileGenerators.sourceEntry(), (entry) => {
          return (
            entry.type.length > 0
            && entry.url.length > 0
          );
        }),
        { numRuns: 20 }
      );
    });

    test('bundleEntry generator should produce valid entries', () => {
      fc.assert(
        fc.property(LockfileGenerators.bundleEntry(), (entry) => {
          return (
            /^\d+\.\d+\.\d+$/.test(entry.version)
            && entry.sourceId.length > 0
            && entry.sourceType.length > 0
            && (entry.commitMode === 'commit' || entry.commitMode === 'local-only')
            && Array.isArray(entry.files)
          );
        }),
        { numRuns: 20 }
      );
    });

    test('consistentLockfile generator should produce lockfiles with matching source references', () => {
      fc.assert(
        fc.property(LockfileGenerators.consistentLockfile(), (lockfile) => {
          // All bundles should reference sources that exist
          for (const bundleId of Object.keys(lockfile.bundles)) {
            const bundle = lockfile.bundles[bundleId];
            if (!lockfile.sources[bundle.sourceId]) {
              return false;
            }
          }
          return true;
        }),
        { numRuns: 20 }
      );
    });

    test('lockfile generator should produce valid lockfiles', () => {
      fc.assert(
        fc.property(LockfileGenerators.lockfile({ minBundles: 1, maxBundles: 3 }), (lockfile) => {
          return (
            lockfile.$schema === LOCKFILE_DEFAULTS.SCHEMA_URL
            && /^\d+\.\d+\.\d+$/.test(lockfile.version)
            && lockfile.generatedAt.length > 0
            && lockfile.generatedBy === LOCKFILE_DEFAULTS.GENERATED_BY
            && typeof lockfile.bundles === 'object'
            && typeof lockfile.sources === 'object'
          );
        }),
        { numRuns: 20 }
      );
    });
  });
});
