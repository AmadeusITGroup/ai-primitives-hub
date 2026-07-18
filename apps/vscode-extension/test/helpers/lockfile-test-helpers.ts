/**
 * Shared test helpers for creating Lockfile test data
 *
 * This module provides utilities for creating test lockfiles with consistent
 * structure across all test files. Follows patterns from bundleTestHelpers.ts.
 */
import * as fc from 'fast-check';
import {
  Lockfile,
  LockfileBundleEntry,
  LockfileFileEntry,
  LockfileHubEntry,
  LockfileProfileEntry,
  LockfileSourceEntry,
} from '../../src/types/lockfile';
import {
  RepositoryCommitMode,
} from '../../src/types/registry';

/**
 * Constants for lockfile test data
 */
export const LOCKFILE_DEFAULTS = {
  SCHEMA_URL: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
  VERSION: '1.0.0',
  GENERATED_BY: 'prompt-registry@1.0.0',
  SOURCE_TYPES: ['github', 'local', 'awesome-copilot', 'apm'] as const,
  COMMIT_MODES: ['commit', 'local-only'] as const
} as const;

/**
 * Valid source types for lockfile entries
 */
export type LockfileSourceType = typeof LOCKFILE_DEFAULTS.SOURCE_TYPES[number];

/**
 * Builder pattern for creating test lockfiles with fluent API
 * @example
 * const lockfile = LockfileBuilder.create()
 *     .withBundle('my-bundle', '1.0.0', 'github-source')
 *     .withSource('github-source', 'github', 'https://github.com/owner/repo')
 *     .build();
 */
export class LockfileBuilder {
  private readonly lockfile: Lockfile;

  private constructor() {
    this.lockfile = {
      $schema: LOCKFILE_DEFAULTS.SCHEMA_URL,
      version: LOCKFILE_DEFAULTS.VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: LOCKFILE_DEFAULTS.GENERATED_BY,
      bundles: {},
      sources: {}
    };
  }

  /**
   * Create a new LockfileBuilder instance
   */
  public static create(): LockfileBuilder {
    return new LockfileBuilder();
  }

  /**
   * Set the schema URL
   * @param schemaUrl
   */
  public withSchema(schemaUrl: string): LockfileBuilder {
    this.lockfile.$schema = schemaUrl;
    return this;
  }

  /**
   * Set the lockfile version
   * @param version
   */
  public withVersion(version: string): LockfileBuilder {
    this.lockfile.version = version;
    return this;
  }

  /**
   * Set the generatedAt timestamp
   * @param timestamp
   */
  public withGeneratedAt(timestamp: string): LockfileBuilder {
    this.lockfile.generatedAt = timestamp;
    return this;
  }

  /**
   * Set the generatedBy field
   * @param generatedBy
   */
  public withGeneratedBy(generatedBy: string): LockfileBuilder {
    this.lockfile.generatedBy = generatedBy;
    return this;
  }

  /**
   * Add a bundle entry to the lockfile
   * @param bundleId
   * @param version
   * @param sourceId
   * @param options
   */
  public withBundle(
    bundleId: string,
    version: string,
    sourceId: string,
    options?: Partial<Omit<LockfileBundleEntry, 'version' | 'sourceId'>>
  ): LockfileBuilder {
    this.lockfile.bundles[bundleId] = {
      version,
      sourceId,
      sourceType: options?.sourceType ?? 'github',
      installedAt: options?.installedAt ?? new Date().toISOString(),
      commitMode: options?.commitMode ?? 'commit',
      checksum: options?.checksum,
      files: options?.files ?? []
    };
    return this;
  }

  /**
   * Add a bundle entry with files
   * @param bundleId
   * @param version
   * @param sourceId
   * @param files
   * @param options
   */
  public withBundleAndFiles(
    bundleId: string,
    version: string,
    sourceId: string,
    files: LockfileFileEntry[],
    options?: Partial<Omit<LockfileBundleEntry, 'version' | 'sourceId' | 'files'>>
  ): LockfileBuilder {
    return this.withBundle(bundleId, version, sourceId, { ...options, files });
  }

  /**
   * Add a source entry to the lockfile
   * @param sourceId
   * @param type
   * @param url
   * @param branch
   */
  public withSource(
    sourceId: string,
    type: string,
    url: string,
    branch?: string
  ): LockfileBuilder {
    this.lockfile.sources[sourceId] = {
      type,
      url,
      ...(branch && { branch })
    };
    return this;
  }

  /**
   * Add a hub entry to the lockfile
   * @param hubId
   * @param name
   * @param url
   */
  public withHub(hubId: string, name: string, url: string): LockfileBuilder {
    if (!this.lockfile.hubs) {
      this.lockfile.hubs = {};
    }
    this.lockfile.hubs[hubId] = { name, url };
    return this;
  }

  /**
   * Add a profile entry to the lockfile
   * @param profileId
   * @param name
   * @param bundleIds
   */
  public withProfile(profileId: string, name: string, bundleIds: string[]): LockfileBuilder {
    if (!this.lockfile.profiles) {
      this.lockfile.profiles = {};
    }
    this.lockfile.profiles[profileId] = { name, bundleIds };
    return this;
  }

  /**
   * Build the lockfile object
   */
  public build(): Lockfile {
    return { ...this.lockfile };
  }
}

/**
 * Create a mock lockfile with the specified number of bundles
 * @param bundleCount - Number of bundles to include
 * @param options - Optional configuration for the mock lockfile
 * @param options.commitMode
 * @param options.sourceType
 * @param options.includeHubs
 * @param options.includeProfiles
 * @param options.includeFiles
 * @returns Complete Lockfile object
 * @example
 * const lockfile = createMockLockfile(3);
 * // Creates lockfile with bundle-0, bundle-1, bundle-2
 */
export function createMockLockfile(
    bundleCount: number,
    options?: {
      commitMode?: RepositoryCommitMode;
      sourceType?: string;
      includeHubs?: boolean;
      includeProfiles?: boolean;
      includeFiles?: boolean;
    }
): Lockfile {
  const builder = LockfileBuilder.create();
  const sourceId = 'mock-source';
  const sourceType = options?.sourceType ?? 'github';
  const commitMode = options?.commitMode ?? 'commit';

  // Add the source
  builder.withSource(sourceId, sourceType, 'https://github.com/mock/repo');

  // Add bundles
  for (let i = 0; i < bundleCount; i++) {
    const bundleId = `bundle-${i}`;
    const files: LockfileFileEntry[] = options?.includeFiles
      ? [createMockFileEntry(`.github/prompts/${bundleId}.prompt.md`)]
      : [];

    builder.withBundle(bundleId, `${i + 1}.0.0`, sourceId, {
      sourceType,
      commitMode,
      files
    });
  }

  // Optionally add hubs
  if (options?.includeHubs) {
    builder.withHub('mock-hub', 'Mock Hub', 'https://hub.example.com/config.yml');
  }

  // Optionally add profiles
  if (options?.includeProfiles && bundleCount > 0) {
    const bundleIds = Array.from({ length: bundleCount }, (_, i) => `bundle-${i}`);
    builder.withProfile('mock-profile', 'Mock Profile', bundleIds);
  }

  return builder.build();
}

/**
 * Create a mock bundle entry for testing
 * @param bundleId - Bundle identifier
 * @param version - Bundle version
 * @param overrides - Optional partial overrides
 * @returns Complete LockfileBundleEntry object
 */
export function createMockBundleEntry(
    bundleId: string,
    version: string,
    overrides?: Partial<LockfileBundleEntry>
): LockfileBundleEntry {
  return {
    version,
    sourceId: overrides?.sourceId ?? 'mock-source',
    sourceType: overrides?.sourceType ?? 'github',
    installedAt: overrides?.installedAt ?? new Date().toISOString(),
    commitMode: overrides?.commitMode ?? 'commit',
    checksum: overrides?.checksum,
    files: overrides?.files ?? []
  };
}

/**
 * Create a mock file entry for testing
 * @param path - File path relative to repository root
 * @param checksum - Optional SHA256 checksum (generates valid mock if not provided)
 * @returns Complete LockfileFileEntry object
 */
export function createMockFileEntry(
    path: string,
    checksum?: string
): LockfileFileEntry {
  return {
    path,
    checksum: checksum ?? generateMockChecksum()
  };
}

/**
 * Create a mock source entry for testing
 * @param type - Source type
 * @param url - Source URL
 * @param branch - Optional branch name
 * @returns Complete LockfileSourceEntry object
 */
export function createMockSourceEntry(
    type: string,
    url: string,
    branch?: string
): LockfileSourceEntry {
  return {
    type,
    url,
    ...(branch && { branch })
  };
}

/**
 * Create a mock hub entry for testing
 * @param name - Hub display name
 * @param url - Hub URL
 * @returns Complete LockfileHubEntry object
 */
export function createMockHubEntry(
    name: string,
    url: string
): LockfileHubEntry {
  return { name, url };
}

/**
 * Create a mock profile entry for testing
 * @param name - Profile display name
 * @param bundleIds - List of bundle IDs
 * @returns Complete LockfileProfileEntry object
 */
export function createMockProfileEntry(
    name: string,
    bundleIds: string[]
): LockfileProfileEntry {
  return { name, bundleIds };
}

/**
 * Generate a mock SHA256 checksum (64 hex characters)
 */
export function generateMockChecksum(): string {
  const chars = '0123456789abcdef';
  let checksum = '';
  for (let i = 0; i < 64; i++) {
    checksum += chars[Math.floor(Math.random() * chars.length)];
  }
  return checksum;
}

/**
 * Fast-check generators for property-based testing of lockfile structures
 *
 * These generators create valid lockfile objects and their components
 * for use in property-based tests.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const LockfileGenerators = {
  /**
   * Generate a valid SHA256 checksum (64 lowercase hex characters)
   */
  checksum: (): fc.Arbitrary<string> => {
    return fc.hexaString({ minLength: 64, maxLength: 64 })
      .map((s) => s.toLowerCase());
  },

  /**
   * Generate a valid semantic version string
   */
  version: (): fc.Arbitrary<string> => {
    return fc.tuple(
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 })
    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);
  },

  /**
   * Generate a valid bundle ID (lowercase alphanumeric with hyphens)
   * Filters out JavaScript reserved property names like 'constructor', 'prototype', etc.
   */
  bundleId: (): fc.Arbitrary<string> => {
    const reservedNames = ['constructor', 'prototype', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'];
    return fc.string({ minLength: 1, maxLength: 30 })
      .map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a').toLowerCase())
      .filter((s) => s.length > 0 && !reservedNames.includes(s));
  },

  /**
   * Generate a valid source ID
   */
  sourceId: (): fc.Arbitrary<string> => {
    return fc.string({ minLength: 1, maxLength: 30 })
      .map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a').toLowerCase())
      .filter((s) => s.length > 0);
  },

  /**
   * Generate a valid source type
   */
  sourceType: (): fc.Arbitrary<string> => {
    return fc.constantFrom(
      'github',
      'local',
      'awesome-copilot',
      'local-awesome-copilot',
      'apm',
      'local-apm'
    );
  },

  /**
   * Generate a valid commit mode
   */
  commitMode: (): fc.Arbitrary<RepositoryCommitMode> => {
    return fc.constantFrom('commit', 'local-only');
  },

  /**
   * Generate a valid ISO timestamp
   */
  isoTimestamp: (): fc.Arbitrary<string> => {
    return fc.date({
      min: new Date('2020-01-01'),
      max: new Date('2030-12-31')
    }).map((d) => d.toISOString());
  },

  /**
   * Generate a valid file path for lockfile entries
   */
  filePath: (): fc.Arbitrary<string> => {
    const directories = ['.github/prompts', '.github/agents', '.github/instructions', '.github/skills'];
    const extensions = ['.prompt.md', '.agent.md', '.instructions.md', ''];

    return fc.tuple(
      fc.constantFrom(...directories),
      fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a')),
      fc.constantFrom(...extensions)
    ).map(([dir, name, ext]) => `${dir}/${name}${ext}`);
  },

  /**
   * Generate a valid URL
   */
  url: (): fc.Arbitrary<string> => {
    return fc.tuple(
      fc.constantFrom('https://github.com', 'file://local'),
      fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a'))
    ).map(([base, path]) => `${base}/${path}`);
  },

  /**
   * Generate a valid file entry
   */
  fileEntry: (): fc.Arbitrary<LockfileFileEntry> => {
    return fc.record({
      path: LockfileGenerators.filePath(),
      checksum: LockfileGenerators.checksum()
    });
  },

  /**
   * Generate a valid source entry
   */
  sourceEntry: (): fc.Arbitrary<LockfileSourceEntry> => {
    return fc.record({
      type: LockfileGenerators.sourceType(),
      url: LockfileGenerators.url(),
      branch: fc.option(fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a')), { nil: undefined })
    });
  },

  /**
   * Generate a valid hub entry
   */
  hubEntry: (): fc.Arbitrary<LockfileHubEntry> => {
    return fc.record({
      name: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[^a-zA-Z0-9 -]/g, 'a')),
      url: LockfileGenerators.url()
    });
  },

  /**
   * Generate a valid profile entry
   * @param bundleIds
   */
  profileEntry: (bundleIds?: string[]): fc.Arbitrary<LockfileProfileEntry> => {
    const bundleIdsArb = bundleIds
      ? fc.constant(bundleIds)
      : fc.array(LockfileGenerators.bundleId(), { minLength: 1, maxLength: 5 });

    return fc.record({
      name: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[^a-zA-Z0-9 -]/g, 'a')),
      bundleIds: bundleIdsArb
    });
  },

  /**
   * Generate a valid bundle entry
   * @param sourceId
   */
  bundleEntry: (sourceId?: string): fc.Arbitrary<LockfileBundleEntry> => {
    return fc.record({
      version: LockfileGenerators.version(),
      sourceId: sourceId ? fc.constant(sourceId) : LockfileGenerators.sourceId(),
      sourceType: LockfileGenerators.sourceType(),
      installedAt: LockfileGenerators.isoTimestamp(),
      commitMode: LockfileGenerators.commitMode(),
      checksum: fc.option(LockfileGenerators.checksum(), { nil: undefined }),
      files: fc.array(LockfileGenerators.fileEntry(), { minLength: 0, maxLength: 5 })
    });
  },

  /**
   * Generate a valid complete lockfile
   * @param options - Configuration for the generated lockfile
   * @param options.minBundles
   * @param options.maxBundles
   * @param options.includeHubs
   * @param options.includeProfiles
   */
  lockfile: (options?: {
    minBundles?: number;
    maxBundles?: number;
    includeHubs?: boolean;
    includeProfiles?: boolean;
  }): fc.Arbitrary<Lockfile> => {
    const minBundles = options?.minBundles ?? 0;
    const maxBundles = options?.maxBundles ?? 5;
    const includeHubs = options?.includeHubs ?? false;
    const includeProfiles = options?.includeProfiles ?? false;

    // Generate source IDs first, then use them for bundles
    return fc.array(LockfileGenerators.sourceId(), { minLength: 1, maxLength: 3 })
      .chain((sourceIds) => {
        // Create sources record
        const sourcesArb = fc.tuple(
          ...sourceIds.map((id) =>
            LockfileGenerators.sourceEntry().map((entry) => [id, entry] as const)
          )
        ).map((entries) => Object.fromEntries(entries));

        // Create bundles record using the source IDs
        const bundlesArb = fc.array(
          fc.tuple(
            LockfileGenerators.bundleId(),
            fc.constantFrom(...sourceIds).chain((sourceId) =>
              LockfileGenerators.bundleEntry(sourceId)
            )
          ),
          { minLength: minBundles, maxLength: maxBundles }
        ).map((entries) => Object.fromEntries(entries));

        // Create optional hubs
        const hubsArb = includeHubs
          ? fc.option(
            fc.array(
              fc.tuple(LockfileGenerators.sourceId(), LockfileGenerators.hubEntry()),
              { minLength: 1, maxLength: 3 }
            ).map((entries) => Object.fromEntries(entries)),
            { nil: undefined }
          )
          : fc.constant(undefined);

        // Create optional profiles
        const profilesArb = includeProfiles
          ? fc.option(
            fc.array(
              fc.tuple(LockfileGenerators.sourceId(), LockfileGenerators.profileEntry()),
              { minLength: 1, maxLength: 3 }
            ).map((entries) => Object.fromEntries(entries)),
            { nil: undefined }
          )
          : fc.constant(undefined);

        return fc.record({
          $schema: fc.constant(LOCKFILE_DEFAULTS.SCHEMA_URL),
          version: LockfileGenerators.version(),
          generatedAt: LockfileGenerators.isoTimestamp(),
          generatedBy: fc.constant(LOCKFILE_DEFAULTS.GENERATED_BY),
          bundles: bundlesArb,
          sources: sourcesArb,
          hubs: hubsArb,
          profiles: profilesArb
        });
      });
  },

  /**
   * Generate a lockfile with consistent source references
   * (all bundles reference sources that exist in the sources section)
   * @param options
   * @param options.minBundles
   * @param options.maxBundles
   */
  consistentLockfile: (options?: {
    minBundles?: number;
    maxBundles?: number;
  }): fc.Arbitrary<Lockfile> => {
    const minBundles = options?.minBundles ?? 1;
    const maxBundles = options?.maxBundles ?? 5;

    return fc.tuple(
      LockfileGenerators.sourceId(),
      LockfileGenerators.sourceEntry(),
      LockfileGenerators.version(),
      LockfileGenerators.isoTimestamp()
    ).chain(([sourceId, sourceEntry, version, generatedAt]) => {
      return fc.array(
        fc.tuple(
          LockfileGenerators.bundleId(),
          LockfileGenerators.bundleEntry(sourceId)
        ),
        { minLength: minBundles, maxLength: maxBundles }
      ).map((bundleEntries) => ({
        $schema: LOCKFILE_DEFAULTS.SCHEMA_URL,
        version,
        generatedAt,
        generatedBy: LOCKFILE_DEFAULTS.GENERATED_BY,
        bundles: Object.fromEntries(bundleEntries),
        sources: { [sourceId]: sourceEntry }
      }));
    });
  }
};

/**
 * Test suite for LockfileBuilder (can be imported and run in test files)
 */
export function testLockfileBuilder() {
  const assert = require('node:assert');

  suite('LockfileBuilder', () => {
    test('should create empty lockfile with defaults', () => {
      const lockfile = LockfileBuilder.create().build();

      assert.strictEqual(lockfile.$schema, LOCKFILE_DEFAULTS.SCHEMA_URL);
      assert.strictEqual(lockfile.version, LOCKFILE_DEFAULTS.VERSION);
      assert.strictEqual(lockfile.generatedBy, LOCKFILE_DEFAULTS.GENERATED_BY);
      assert.deepStrictEqual(lockfile.bundles, {});
      assert.deepStrictEqual(lockfile.sources, {});
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

    test('should add hub entry', () => {
      const lockfile = LockfileBuilder.create()
        .withHub('my-hub', 'My Hub', 'https://hub.example.com')
        .build();

      assert.ok(lockfile.hubs);
      assert.ok(lockfile.hubs!['my-hub']);
      assert.strictEqual(lockfile.hubs!['my-hub'].name, 'My Hub');
      assert.strictEqual(lockfile.hubs!['my-hub'].url, 'https://hub.example.com');
    });

    test('should add profile entry', () => {
      const lockfile = LockfileBuilder.create()
        .withProfile('my-profile', 'My Profile', ['bundle-1', 'bundle-2'])
        .build();

      assert.ok(lockfile.profiles);
      assert.ok(lockfile.profiles!['my-profile']);
      assert.strictEqual(lockfile.profiles!['my-profile'].name, 'My Profile');
      assert.deepStrictEqual(lockfile.profiles!['my-profile'].bundleIds, ['bundle-1', 'bundle-2']);
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

    test('should include files when requested', () => {
      const lockfile = createMockLockfile(1, { includeFiles: true });

      assert.ok(lockfile.bundles['bundle-0'].files.length > 0);
      assert.ok(lockfile.bundles['bundle-0'].files[0].path);
      assert.ok(lockfile.bundles['bundle-0'].files[0].checksum);
    });

    test('should include hubs when requested', () => {
      const lockfile = createMockLockfile(1, { includeHubs: true });

      assert.ok(lockfile.hubs);
      assert.ok(lockfile.hubs!['mock-hub']);
    });

    test('should include profiles when requested', () => {
      const lockfile = createMockLockfile(2, { includeProfiles: true });

      assert.ok(lockfile.profiles);
      assert.ok(lockfile.profiles!['mock-profile']);
      assert.deepStrictEqual(lockfile.profiles!['mock-profile'].bundleIds, ['bundle-0', 'bundle-1']);
    });
  });
}
