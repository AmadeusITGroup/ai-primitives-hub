/**
 * `skill new` subcommand.
 *
 * Replaces the non-interactive path of `lib/bin/create-skill.js`.
 * Creates a new skill folder under `<cwd>/<skillsDir>/<skillName>/`
 * containing a populated `SKILL.md`.
 *
 * The legacy binary's interactive readline wizard is **deferred** —
 * a later iteration lands `--prompt` style flag wiring, after which a follow-up
 * iteration can re-introduce the wizard via `inquirer` (with the prompt
 * stream injected through `Context.stdin`/`stdout`).
 */
import {
  createSkill,
} from '@prompt-registry/app';
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

interface SkillNewData {
  skillName: string;
  path: string;
}

export interface SkillNewOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /** Skill name (required). */
  skillName: string;
  /** Description for the SKILL.md (required). */
  description: string;
  /** Skills directory under the cwd. Default 'skills'. */
  skillsDir?: string;
}

/**
 * Command context for skill new command.
 */
interface SkillNewContext {
  ctx: Context;
}

/**
 * Base class for skill new command.
 */
abstract class BaseSkillNewCommand extends Command {
  public commandContext: SkillNewContext = { ctx: null as any };
}

/**
 * Native clipanion class command for skill new.
 */
export class SkillNewCommand extends BaseSkillNewCommand {
  public static readonly paths = [['skill', 'new']];

  public static readonly usage = Command.Usage({
    description: 'Create a new agent skill folder + SKILL.md template.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry skill new [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --skill-name <name>         Skill name (required)
        --description <desc>        Description for SKILL.md (required)
        --skills-dir <dir>          Skills directory (default: skills)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public skillName = Option.String('--skill-name');
  public description = Option.String('--description');
  public skillsDir = Option.String('--skills-dir');

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const result = createSkill(cwd, this.skillName ?? '', this.description ?? '', this.skillsDir ?? 'skills');
    if (!result.success) {
      const err = new RegistryError({
        code: classifyError(result.error ?? 'unknown error'),
        message: result.error ?? 'createSkill failed',
        context: { skillName: this.skillName, path: result.path }
      });
      emitError(ctx, fmt, err);
      return 1;
    }
    formatOutput({
      ctx,
      command: 'skill.new',
      output: fmt,
      status: 'ok',
      data: { skillName: this.skillName ?? '', path: result.path } satisfies SkillNewData,
      textRenderer: (d) => `Created skill at ${d.path}\n`
    });
    return 0;
  }
}

/**
 * Create a CommandDefinition wrapper for the skill new command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultSkillName Default skill name (optional).
 * @param defaultDescription Default description (optional).
 * @param defaultSkillsDir Default skills directory (optional).
 * @returns CommandClass.
 */
const createSkillNewCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultSkillName?: string,
  defaultDescription?: string,
  defaultSkillsDir?: string
): typeof SkillNewCommand => {
  class ConfiguredCommand extends SkillNewCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultSkillName !== undefined && !this.skillName) {
        this.skillName = defaultSkillName;
      }
      if (defaultDescription !== undefined && !this.description) {
        this.description = defaultDescription;
      }
      if (defaultSkillsDir !== undefined && !this.skillsDir) {
        this.skillsDir = defaultSkillsDir;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(SkillNewCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured skill new command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultSkillName Default skill name (optional).
 * @param defaultDescription Default description (optional).
 * @param defaultSkillsDir Default skills directory (optional).
 * @returns CommandClass.
 */
export const createSkillNewCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultSkillName?: string,
  defaultDescription?: string,
  defaultSkillsDir?: string
): typeof SkillNewCommand => {
  return createSkillNewCommandDefinition(ctx, defaultOutput, defaultSkillName, defaultDescription, defaultSkillsDir);
};

/**
 * Build the `skill new` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createSkillNewCommand = (
  opts: SkillNewOptions
): CommandDefinition =>
  defineCommand({
    path: ['skill', 'new'],
    description: 'Create a new agent skill folder + SKILL.md template.',
    category: 'Build & Author',
    run: ({ ctx }: { ctx: Context }): number => {
      const cwd = ctx.cwd();
      const result = createSkill(cwd, opts.skillName, opts.description, opts.skillsDir ?? 'skills');
      if (!result.success) {
        const err = new RegistryError({
          code: classifyError(result.error ?? 'unknown error'),
          message: result.error ?? 'createSkill failed',
          context: { skillName: opts.skillName, path: result.path }
        });
        emitError(ctx, opts.output ?? 'text', err);
        return 1;
      }
      formatOutput({
        ctx,
        command: 'skill.new',
        output: opts.output ?? 'text',
        status: 'ok',
        data: { skillName: opts.skillName, path: result.path } satisfies SkillNewData,
        textRenderer: (d) => `Created skill at ${d.path}\n`
      });
      return 0;
    }
  });

const classifyError = (msg: string): string => {
  if (msg.includes('already exists')) {
    return 'PRIMITIVE.ALREADY_EXISTS';
  }
  if (msg.toLowerCase().includes('invalid')) {
    return 'PRIMITIVE.INVALID_NAME';
  }
  return 'PRIMITIVE.CREATE_FAILED';
};

const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'skill.new',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};
