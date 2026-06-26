/**
 * `skill validate` subcommand.
 *
 * Replaces `lib/bin/validate-skills.js`. Wraps `validateAllSkills`
 * from `lib/src/skills.ts` and routes the result through the
 * framework's output formatter.
 */
import {
  validateAllSkills,
} from '@prompt-registry/app';
import {
  type AllSkillsValidationResult,
} from '@prompt-registry/core';
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
} from '../framework';

export interface SkillValidateOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /** Skills directory under the cwd. Default 'skills'. */
  skillsDir?: string;
  /** Verbose mode prints each ok skill in text mode. */
  verbose?: boolean;
}

/**
 * Command context for skill validate command.
 */
interface SkillValidateContext {
  ctx: Context;
}

/**
 * Base class for skill validate command.
 */
abstract class BaseSkillValidateCommand extends Command {
  public commandContext: SkillValidateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for skill validate.
 */
export class SkillValidateCommand extends BaseSkillValidateCommand {
  public static readonly paths = [['skill', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate every skill folder under <cwd>/skills/ against the Agent Skills spec.',
    category: 'Build & Author',
    details: `
      Usage: prompt-registry skill validate [options]

      Validates SKILL.md files and folder structure against the Agent Skills specification.

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --skills-dir <dir>          Skills directory (default: skills)
        --verbose                   Print each ok skill in text mode

      Examples:
        prompt-registry skill validate
        prompt-registry skill validate --skills-dir my-skills
        prompt-registry skill validate -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public skillsDir = Option.String('--skills-dir');
  public verbose = Option.Boolean('--verbose', false);

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const cwd = ctx.cwd();
    const result = validateAllSkills(cwd, this.skillsDir ?? 'skills');
    formatOutput({
      ctx,
      command: 'skill.validate',
      output: fmt,
      status: result.valid ? 'ok' : 'error',
      data: result,
      textRenderer: (d) => renderText(d, this.verbose)
    });
    return result.valid ? 0 : 1;
  }
}

/**
 * Create a CommandDefinition wrapper for the skill validate command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultSkillsDir Default skills directory (optional).
 * @param defaultVerbose Default verbose flag (optional).
 * @returns CommandClass.
 */
const createSkillValidateCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultSkillsDir?: string,
  defaultVerbose?: boolean
): typeof SkillValidateCommand => {
  class ConfiguredCommand extends SkillValidateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultSkillsDir !== undefined && !this.skillsDir) {
        this.skillsDir = defaultSkillsDir;
      }
      if (defaultVerbose !== undefined && !this.verbose) {
        this.verbose = defaultVerbose;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(SkillValidateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured skill validate command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultSkillsDir Default skills directory (optional).
 * @param defaultVerbose Default verbose flag (optional).
 * @returns CommandClass.
 */
export const createSkillValidateCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultSkillsDir?: string,
  defaultVerbose?: boolean
): typeof SkillValidateCommand => {
  return createSkillValidateCommandDefinition(ctx, defaultOutput, defaultSkillsDir, defaultVerbose);
};

/**
 * Build the `skill validate` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createSkillValidateCommand = (
  opts: SkillValidateOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['skill', 'validate'],
    description: 'Validate every skill folder under <cwd>/skills/ against the Agent Skills spec.',
    category: 'Build & Author',
    run: ({ ctx }: { ctx: Context }): number => {
      const cwd = ctx.cwd();
      const result = validateAllSkills(cwd, opts.skillsDir ?? 'skills');
      formatOutput({
        ctx,
        command: 'skill.validate',
        output: opts.output ?? 'text',
        status: result.valid ? 'ok' : 'error',
        data: result,
        textRenderer: (d) => renderText(d, opts.verbose ?? false)
      });
      return result.valid ? 0 : 1;
    }
  });

const renderText = (d: AllSkillsValidationResult, verbose: boolean): string => {
  const lines: string[] = [`Validated ${d.totalSkills} skill(s): ${d.validSkills} valid, ${d.invalidSkills} invalid`];
  for (const s of d.skills) {
    if (!s.valid) {
      lines.push(`[FAIL] ${s.skillName}: ${s.errors.join('; ')}`);
    } else if (verbose) {
      lines.push(`[ OK ] ${s.skillName}`);
    }
  }
  return `${lines.join('\n')}\n`;
};
