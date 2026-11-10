/**
 * Target-management commands: `target use`, `target current`, `installed`,
 * `lockfile inspect`. Experimental; gated by `experimental.targetManagement`.
 * @module commands/target-management
 */
import * as path from 'node:path';
import {
  inspectLegacyV2,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';
import {
  runInstalled,
  runLockfileMigrate,
  runTargetCurrent,
  runTargetUse,
} from './target-managed';

const CATEGORY = 'Install & Manage';

abstract class ManagedCommand extends Command {
  public output = Option.String('-o,--output');
  public workspaceRoot = Option.String('--workspace-root');
  public global = Option.Boolean('--global', false);
  public commandContext!: { ctx: Context };

  protected flags() {
    return {
      output: (this.output as OutputFormat | undefined) ?? 'text',
      ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot }),
      global: this.global === true
    };
  }
}

export class TargetUseCommand extends ManagedCommand {
  public static readonly paths = [['target', 'use']];
  public static readonly usage = Command.Usage({
    description: 'Select the target harness (type or configured target name); requires experimental.targetManagement.',
    category: CATEGORY
  });

  public name = Option.String();

  public execute(): Promise<number> {
    return runTargetUse(this.commandContext.ctx, this.flags(), this.name);
  }
}

export class TargetCurrentCommand extends ManagedCommand {
  public static readonly paths = [['target', 'current']];
  public static readonly usage = Command.Usage({
    description: 'Show the selected target harness; requires experimental.targetManagement.',
    category: CATEGORY
  });

  public execute(): Promise<number> {
    return runTargetCurrent(this.commandContext.ctx, this.flags());
  }
}

export class InstalledCommand extends ManagedCommand {
  public static readonly paths = [['installed']];
  public static readonly usage = Command.Usage({
    description: 'List installations (both scopes) for the selected target harness; requires experimental.targetManagement.',
    category: CATEGORY
  });

  public execute(): Promise<number> {
    return runInstalled(this.commandContext.ctx, this.flags());
  }
}

export class LockfileInspectCommand extends ManagedCommand {
  public static readonly paths = [['lockfile', 'inspect']];
  public static readonly usage = Command.Usage({
    description: 'Inspect a legacy v2 lockfile: unresolved entries are marked needsReinstall (read-only).',
    category: CATEGORY
  });

  public file = Option.String();

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.flags().output;
    try {
      const raw = await ctx.fs.readJson(path.resolve(ctx.cwd(), this.file));
      formatOutput({ ctx, command: 'lockfile.inspect', output: fmt, status: 'ok', data: inspectLegacyV2(raw) });
      return 0;
    } catch (error) {
      formatOutput({ ctx, command: 'lockfile.inspect', output: fmt, status: 'error', data: null, errors: [{ code: 'LOCKFILE.INVALID', message: (error as Error).message }] });
      ctx.stderr.write(`LOCKFILE.INVALID: ${(error as Error).message}\n`);
      return 1;
    }
  }
}

export class LockfileMigrateCommand extends ManagedCommand {
  public static readonly paths = [['lockfile', 'migrate']];
  public static readonly usage = Command.Usage({
    description: 'Migrate legacy v2 repository lockfiles to the multi-target format; requires experimental.targetManagement.',
    category: CATEGORY
  });

  public dryRun = Option.Boolean('--dry-run', false);
  public harness = Option.String('--harness');

  public execute(): Promise<number> {
    return runLockfileMigrate(this.commandContext.ctx, { ...this.flags(), dryRun: this.dryRun }, { harness: this.harness });
  }
}
