/**
 * `skill new` subcommand.
 *
 * Creates a new skill folder under `<cwd>/<skillsDir>/<skillName>/`
 * containing a populated `SKILL.md`.
 *
 * Non-interactive only — an interactive wizard (via `inquirer`, with the
 * prompt stream injected through `Context.stdin`/`stdout`) is a possible
 * future follow-up, not implemented here (matches the reference branch's
 * own deferred state for this command).
 * @module commands/skill-new
 */
import {
  createSkill,
} from '@ai-primitives-hub/app';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

interface SkillNewData {
  skillName: string;
  path: string;
}

/**
 * Classify a `createSkill` failure reason into a `RegistryError` code.
 * @param msg Failure message from `createSkill`.
 * @returns Error code.
 */
const classifyError = (msg: string): string => {
  if (msg.includes('already exists')) {
    return 'PRIMITIVE.ALREADY_EXISTS';
  }
  if (msg.toLowerCase().includes('invalid')) {
    return 'PRIMITIVE.INVALID_NAME';
  }
  return 'PRIMITIVE.CREATE_FAILED';
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

/**
 * Skill new command class.
 */
export class SkillNewCommand extends Command {
  public static readonly paths = [['skill', 'new']];

  public static readonly usage = Command.Usage({
    description: 'Create a new agent skill folder + SKILL.md template.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub skill new [options]

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
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
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
      return Promise.resolve(1);
    }
    formatOutput({
      ctx,
      command: 'skill.new',
      output: fmt,
      status: 'ok',
      data: { skillName: this.skillName ?? '', path: result.path } satisfies SkillNewData,
      textRenderer: (d) => `Created skill at ${d.path}\n`
    });
    return Promise.resolve(0);
  }
}
