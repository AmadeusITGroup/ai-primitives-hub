/**
 * Shared target-writer construction for install, update, and uninstall.
 * @module framework/target-writer
 */
import {
  FileTreeTargetWriter,
  type TargetWriter,
  TransformerRegistry,
} from '@ai-primitives-hub/app';
import type {
  ExtractedFiles,
  Target,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  LocalOnlyTargetWriter,
  type RepositoryCommitMode,
  resolveUserConfigDir,
} from '@ai-primitives-hub/infra';
import type {
  Context,
} from './context';

/**
 * Bind a writer to the target after command-line scope overrides are applied.
 */
class ConfiguredTargetWriter implements TargetWriter {
  public constructor(
    private readonly delegate: TargetWriter,
    private readonly configuredTarget: Target
  ) {}

  public async write(_target: Target, files: ExtractedFiles): Promise<TargetWriteResult> {
    return await this.delegate.write(this.configuredTarget, files);
  }

  public async remove(_target: Target, filePath: string): Promise<void> {
    await this.delegate.remove(this.configuredTarget, filePath);
  }
}

/**
 * Create a layout-aware writer for the effective target and scope.
 * Repository targets retain their native VS Code, Kiro, Claude Code, or
 * Windsurf directory layout instead of being forced into `.github/copilot`.
 * @param ctx CLI context.
 * @param target Configured target.
 * @param scope Effective installation scope.
 * @param commitMode Repository commit mode.
 * @returns A writer configured consistently for all lifecycle commands.
 */
export function createTargetWriter(
  ctx: Context,
  target: Target,
  scope: Target['scope'],
  commitMode: RepositoryCommitMode
): TargetWriter {
  const configuredTarget: Target = {
    ...target,
    scope,
    commitMode: scope === 'repository' ? commitMode : undefined,
    rootPath: scope === 'user' ? target.rootPath : (target.rootPath ?? ctx.cwd())
  };
  const transformer = TransformerRegistry.withBuiltIns().getTransformer(configuredTarget.type);
  const layoutLoader = new FileSystemLayoutConfigLoader({
    cwd: ctx.cwd(),
    fs: ctx.fs,
    userConfigDir: resolveUserConfigDir(ctx.env)
  });
  const layoutWriter = new FileTreeTargetWriter({
    fs: ctx.fs,
    env: ctx.env,
    transformer,
    layoutLoader
  });
  let writer: TargetWriter = new ConfiguredTargetWriter(layoutWriter, configuredTarget);

  if (scope === 'repository' && commitMode === 'local-only') {
    writer = new LocalOnlyTargetWriter(writer, ctx.fs, configuredTarget.rootPath as string);
  }
  return writer;
}
