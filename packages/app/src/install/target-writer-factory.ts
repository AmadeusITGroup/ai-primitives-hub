/**
 * Target writer selection.
 *
 * Picks the writer that places a bundle on a target: the `.github/`
 * repository-scope writer for Copilot-like targets at repository scope,
 * and the layout-driven file-tree writer for everything else. Both
 * deliveries build their writers here, so a file lands in the same place
 * whichever client installed it.
 * @module install/target-writer-factory
 */
import type {
  FileSystem,
  Target,
  TargetType,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  NO_EXCLUSION,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
} from '@ai-primitives-hub/infra';
import {
  TransformerRegistry,
} from '../transform/transformer-registry';
import {
  FileTreeTargetWriter,
} from '../writers/file-tree-writer';

/**
 * Inputs of {@link createTargetWriterFactory}. On-disk roots are passed
 * in; nothing is derived from `env` except `${VAR}` and `~` expansion.
 */
export interface TargetWriterFactoryOptions {
  /** Filesystem every writer uses. */
  fs: FileSystem;
  /** Environment used for `${VAR}` and `~` expansion in layout paths. */
  env: Readonly<Record<string, string | undefined>>;
  /** Directory the project layout file lookup starts from; `null` skips the project layer. */
  projectDir: string | null;
  /** Directory of the user layout file; `null` skips the user layer. */
  userConfigDir: string | null;
  /**
   * Whether the repository-scope writer updates `.git/info/exclude` itself
   * for `local-only` installs. Pass `false` when the caller owns the
   * exclusion calls.
   *
   * `@migration-cleanup(writer-owned-exclusion)`: remove once every caller
   * owns its exclusion calls.
   */
  writerOwnsExclusion: boolean;
}

/** Target types whose repository scope installs into the `.github/` tree. */
const REPOSITORY_SCOPE_WRITER_TYPES: ReadonlySet<TargetType> = new Set<TargetType>([
  'vscode',
  'vscode-insiders',
  'copilot-cli'
]);

/**
 * Build a function that returns the writer for a target.
 *
 * One transformer registry and, when either layout layer is enabled, one
 * layout loader are shared by every writer the function returns.
 * @param opts Filesystem, environment, layout layers and exclusion ownership.
 * @returns Writer factory. It throws for a repository target without a `rootPath`.
 */
export function createTargetWriterFactory(opts: TargetWriterFactoryOptions): (target: Target) => TargetWriter {
  const transformers = TransformerRegistry.withBuiltIns();
  const layoutLoader = opts.projectDir === null && opts.userConfigDir === null
    ? undefined
    : new FileSystemLayoutConfigLoader({ cwd: opts.projectDir, fs: opts.fs, userConfigDir: opts.userConfigDir });

  return (target: Target): TargetWriter => {
    const rootPath = target.rootPath ?? '';
    if (target.scope === 'repository' && rootPath.length === 0) {
      throw new Error('repository target needs rootPath');
    }
    if (target.scope === 'repository' && REPOSITORY_SCOPE_WRITER_TYPES.has(target.type)) {
      return new RepositoryScopeWriterAdapter(new RepositoryScopeWriter({
        fs: opts.fs,
        workspaceRoot: rootPath,
        commitMode: target.commitMode ?? 'commit',
        ...(opts.writerOwnsExclusion ? {} : { exclusion: NO_EXCLUSION })
      }));
    }
    return new FileTreeTargetWriter({
      fs: opts.fs,
      env: opts.env,
      transformer: transformers.getTransformer(target.type),
      ...(layoutLoader === undefined ? {} : { layoutLoader })
    });
  };
}
