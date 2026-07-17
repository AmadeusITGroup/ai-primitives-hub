/**
 * `skill validate` subcommand.
 *
 * Wraps `validateAllSkills` from `@ai-primitives-hub/app` and routes the
 * result through the framework's output formatter.
 * @module commands/skill-validate
 */
import {
  validateAllSkills,
} from '@ai-primitives-hub/app';
import type {
  AllSkillsValidationResult,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Render skill validation results as text.
 * @param d Validation result.
 * @param verbose Whether to also print each passing skill.
 * @returns Formatted text output.
 */
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

/**
 * Skill validate command class.
 */
export class SkillValidateCommand extends Command {
  public static readonly paths = [['skill', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate every skill folder under <cwd>/skills/ against the Agent Skills spec.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub skill validate [options]

      Validates SKILL.md files and folder structure against the Agent Skills specification.

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --skills-dir <dir>          Skills directory (default: skills)
        --verbose                   Print each ok skill in text mode

      Examples:
        ai-primitives-hub skill validate
        ai-primitives-hub skill validate --skills-dir my-skills
        ai-primitives-hub skill validate -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public skillsDir = Option.String('--skills-dir');
  public verbose = Option.Boolean('--verbose', false);
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';
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
    return Promise.resolve(result.valid ? 0 : 1);
  }
}
