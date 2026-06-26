/**
 * `version compute` subcommand.
 *
 * Replaces `lib/bin/compute-collection-version.js`. Computes the next
 * semver version + git tag for a collection given:
 *   - the collection file's `version` field (manual override), and
 *   - the set of existing git tags matching `<collection-id>-v*`.
 *
 * The git interaction is injected via `gitTagsProvider` so the command
 * stays Context-pure for tests. The default provider shells out to
 * `git tag --list` synchronously (same as the legacy script) and is
 * the *only* place this command file touches a child process.
 */
import {
  spawnSync,
} from 'node:child_process';
import {
  readCollection,
} from '@prompt-registry/app';
import * as semver from 'semver';
import {
  Command,
  copyCommandPrototype,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Version compute data structure.
 */
interface VersionComputeData {
  collectionId: string;
  collectionFile: string;
  lastVersion: string | null;
  manualVersion: string;
  nextVersion: string;
  tag: string;
}

/**
 * Version compute command options.
 */
export interface VersionComputeOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /** Collection file (repo-relative). Mirrors --collection-file. */
  collectionFile: string;
  /**
   * Optional override for tag enumeration. Tests pass a fixed array;
   * production wiring uses `defaultGitTagsProvider` which shells out
   * to `git tag --list`.
   */
  gitTagsProvider?: (cwd: string) => string[];
}

/**
 * Command context for version compute command.
 */
interface VersionComputeContext {
  ctx: Context;
  gitTagsProvider?: (cwd: string) => string[];
}

/**
 * Base class for version compute command.
 */
abstract class BaseVersionComputeCommand extends Command {
  public commandContext: VersionComputeContext = { ctx: null as any, gitTagsProvider: undefined };
}

/**
 * Native clipanion class command for version compute.
 */
export class VersionComputeCommand extends BaseVersionComputeCommand {
  public static readonly paths = [['version', 'compute']];

  public static readonly usage = Command.Usage({
    description: 'Compute the next semver version + git tag for a collection.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry version compute [options]

      Options:
        -o, --output <format>           Output format (text, json, yaml, ndjson)
        --collection-file <path>        Collection file path (repo-relative)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public collectionFile = Option.String('--collection-file');

  public async execute(): Promise<number> {
    const { ctx, gitTagsProvider } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    try {
      const provider = gitTagsProvider ?? defaultGitTagsProvider;
      const data = computeNextVersion({
        repoRoot: cwd,
        collectionFile: this.collectionFile ?? '',
        allTags: provider(cwd)
      });
      formatOutput({
        ctx,
        command: 'version.compute',
        output: fmt,
        status: 'ok',
        data,
        textRenderer: renderText
      });
      return 0;
    } catch (err) {
      const re = err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'INTERNAL.UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
          cause: err
        });
      emitError(ctx, fmt, re);
      return 1;
    }
  }
}

/**
 * Create a CommandDefinition wrapper for the version compute command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param collectionFile Collection file path.
 * @param gitTagsProvider Optional git tags provider for testing.
 * @returns CommandClass.
 */
const createVersionComputeCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  collectionFile?: string,
  gitTagsProvider?: (cwd: string) => string[]
): typeof VersionComputeCommand => {
  class ConfiguredCommand extends VersionComputeCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx, gitTagsProvider };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (collectionFile !== undefined && !this.collectionFile) {
        this.collectionFile = collectionFile;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(VersionComputeCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured version compute command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param collectionFile Collection file path.
 * @param gitTagsProvider Optional git tags provider for testing.
 * @returns CommandClass.
 */
export const createVersionComputeCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  collectionFile?: string,
  gitTagsProvider?: (cwd: string) => string[]
): typeof VersionComputeCommand => {
  return createVersionComputeCommandDefinition(ctx, defaultOutput, collectionFile, gitTagsProvider);
};

/**
 * Build the `version compute` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createVersionComputeCommand = (
  opts: VersionComputeOptions
): CommandDefinition =>
  defineCommand({
    path: ['version', 'compute'],
    description: 'Compute the next semver version + git tag for a collection.',
    category: 'Build & Author',
    run: ({ ctx }: { ctx: Context }): number => {
      const cwd = ctx.cwd();
      try {
        const provider = opts.gitTagsProvider ?? defaultGitTagsProvider;
        const data = computeNextVersion({
          repoRoot: cwd,
          collectionFile: opts.collectionFile,
          allTags: provider(cwd)
        });
        formatOutput({
          ctx,
          command: 'version.compute',
          output: opts.output ?? 'text',
          status: 'ok',
          data,
          textRenderer: renderText
        });
        return 0;
      } catch (err) {
        const re = err instanceof RegistryError
          ? err
          : new RegistryError({
            code: 'INTERNAL.UNEXPECTED',
            message: err instanceof Error ? err.message : String(err),
            cause: err
          });
        emitError(ctx, opts.output ?? 'text', re);
        return 1;
      }
    }
  });

/**
 * Validate collection ID.
 * @param collectionId Collection ID to validate.
 * @returns Validated collection ID.
 */
function validateCollectionId(collectionId: unknown): string {
  if (typeof collectionId !== 'string' || collectionId.length === 0) {
    throw new RegistryError({
      code: 'BUNDLE.INVALID_MANIFEST',
      message: 'collection.id is required',
      hint: 'Add an `id:` field to the collection.yml file.'
    });
  }
  return collectionId;
}

/**
 * Validate manual version.
 * @param version Version to validate.
 * @returns Validated version string.
 */
function validateManualVersion(version: unknown): string {
  const DEFAULT_VERSION = '1.0.0';
  if (version === undefined || typeof version !== 'string') {
    return DEFAULT_VERSION;
  }
  if (semver.valid(version) === null) {
    throw new RegistryError({
      code: 'BUNDLE.INVALID_VERSION',
      message: `collection.version must be a valid semver string (got: ${version})`,
      context: { version }
    });
  }
  return version;
}

/**
 * Extract versions from git tags.
 * @param collectionId Collection ID.
 * @param allTags All git tags.
 * @returns Sorted list of version strings.
 */
function extractVersionsFromTags(collectionId: string, allTags: string[]): string[] {
  const tagPrefix = `${collectionId}-v`;
  const tagsForCollection = allTags.filter((t) => t.startsWith(tagPrefix));
  return tagsForCollection
    .map((t) => t.slice(tagPrefix.length))
    .filter((v) => semver.valid(v) !== null)
    .toSorted(semver.rcompare);
}

/**
 * Calculate version increment.
 * @param manualVersion Manual version from collection file.
 * @param lastVersion Last version from git tags.
 * @returns Next version string.
 */
function calculateVersionIncrement(
  manualVersion: string,
  lastVersion: string | null
): string {
  if (lastVersion === null) {
    return manualVersion;
  }
  if (semver.gt(manualVersion, lastVersion)) {
    return manualVersion;
  }
  const incremented = semver.inc(lastVersion, 'patch');
  if (incremented === null) {
    throw new RegistryError({
      code: 'BUNDLE.INVALID_VERSION',
      message: `unable to increment patch on ${lastVersion}`
    });
  }
  return incremented;
}

/**
 * Resolve tag for next version.
 * @param collectionId Collection ID.
 * @param nextVersion Next version.
 * @param manualVersion Manual version.
 * @param lastVersion Last version from git tags.
 * @param allTags All git tags.
 * @returns Tag string.
 */
function resolveTag(
  collectionId: string,
  nextVersion: string,
  manualVersion: string,
  lastVersion: string | null,
  allTags: string[]
): string {
  const tagSet = new Set(allTags);
  if (lastVersion !== null && semver.gt(manualVersion, lastVersion)) {
    return checkTagExistsAndThrow(`${collectionId}-v${nextVersion}`, tagSet, manualVersion);
  }
  return findFreeTag(collectionId, nextVersion, tagSet);
}

/**
 * Check if tag exists and throw error if so.
 * @param tag Tag to check.
 * @param tagSet Set of existing tags.
 * @param manualVersion Manual version.
 * @returns Tag if it doesn't exist.
 */
function checkTagExistsAndThrow(tag: string, tagSet: Set<string>, manualVersion: string): string {
  if (tagSet.has(tag)) {
    throw new RegistryError({
      code: 'BUNDLE.TAG_EXISTS',
      message: `Tag already exists for manual version: ${tag}`,
      hint: 'Bump the `version:` field in the collection.yml or remove the existing tag.',
      context: { tag, manualVersion }
    });
  }
  return tag;
}

/**
 * Find a free tag by incrementing version until one doesn't exist.
 * @param collectionId Collection ID.
 * @param initialVersion Initial version.
 * @param tagSet Set of existing tags.
 * @returns Free tag string.
 */
function findFreeTag(collectionId: string, initialVersion: string, tagSet: Set<string>): string {
  let nextVersion = initialVersion;
  let tag = `${collectionId}-v${nextVersion}`;
  while (tagSet.has(tag)) {
    const incremented = semver.inc(nextVersion, 'patch');
    if (incremented === null) {
      throw new RegistryError({
        code: 'BUNDLE.INVALID_VERSION',
        message: `unable to find a free patch version after ${nextVersion}`
      });
    }
    nextVersion = incremented;
    tag = `${collectionId}-v${nextVersion}`;
  }
  return tag;
}

/**
 * Compute next version data.
 * @param input Input data with repo root, collection file, and all tags.
 * @param input.repoRoot Repository root path.
 * @param input.collectionFile Collection file path.
 * @param input.allTags All git tags.
 * @returns Version compute data.
 */
const computeNextVersion = (input: {
  repoRoot: string;
  collectionFile: string;
  allTags: string[];
}): VersionComputeData => {
  const collection = readCollection(input.repoRoot, input.collectionFile);
  const collectionId = validateCollectionId(collection.id);
  const manualVersion = validateManualVersion(collection.version);
  const { lastVersion, nextVersion, tag } = computeVersionAndTag(collectionId, manualVersion, input.allTags);
  return {
    collectionId,
    collectionFile: input.collectionFile.replaceAll('\\', '/'),
    lastVersion,
    manualVersion,
    nextVersion,
    tag
  };
};

/**
 * Compute version and tag.
 * @param collectionId Collection ID.
 * @param manualVersion Manual version.
 * @param allTags All git tags.
 * @returns Last version, next version, and tag.
 */
function computeVersionAndTag(collectionId: string, manualVersion: string, allTags: string[]): {
  lastVersion: string | null;
  nextVersion: string;
  tag: string;
} {
  const versions = extractVersionsFromTags(collectionId, allTags);
  const lastVersion = versions.length === 0 ? null : versions[0];
  const nextVersion = calculateVersionIncrement(manualVersion, lastVersion);
  const tag = resolveTag(collectionId, nextVersion, manualVersion, lastVersion, allTags);
  return { lastVersion, nextVersion, tag };
}

/**
 * Default git tags provider using git command.
 * @param cwd Current working directory.
 * @returns List of git tags.
 */
const defaultGitTagsProvider = (cwd: string): string[] => {
  // The single point in this command file where we shell out. Bounded
  // and deterministic — any future migration to a `Context.git`
  // abstraction can replace this one function.
  const res = spawnSync('git', ['tag', '--list'], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    return [];
  }
  return (res.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'version.compute',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};

/**
 * Render version compute data as text.
 * @param d Version compute data.
 * @returns Formatted text output.
 */
const renderText = (d: VersionComputeData): string =>
  `${d.collectionId}: ${d.lastVersion ?? '(none)'} -> ${d.nextVersion} (tag: ${d.tag})\n`;
