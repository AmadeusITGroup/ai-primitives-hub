/**
 * `skill create` subcommand.
 *
 * Creates a new skill directory with SKILL.md using templates.
 *
 * Usage:
 *   prompt-registry skill create code-review \
 *     --description "Code review skill"
 */
import * as path from 'node:path';
import {
  generateSanitizedId,
  TemplateContext,
} from '@prompt-registry/core';
import {
  TEMPLATE_PATHS,
  TemplateEngine,
} from '@prompt-registry/infra';
import {
  readCollection,
  writeCollection,
} from '../collections';
import {
  Command,
  copyCommandPrototype,
  Option,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';
import type {
  CollectionItem,
} from '../types';

/**
 * Command context for skill create command.
 */
interface SkillCreateContext {
  ctx: Context;
}

/**
 * Base class for skill create command.
 */
abstract class BaseSkillCreateCommand extends Command {
  public commandContext: SkillCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for skill create.
 */
export class SkillCreateCommand extends BaseSkillCreateCommand {
  public static readonly paths = [['skill', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new skill directory',
    category: 'Primitive',
    details: `
      Usage: prompt-registry skill create <name> [options]

      Options:
        --description <text>   Skill description
        --author <name>        Author name
        --path <dir>           Output directory (default: skills/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry skill create code-review
        prompt-registry skill create code-review --description "Code review skill"
    `
  });

  public name = Option.String({ required: true });
  public description = Option.String('--description');
  public author = Option.String('--author');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine skill name
      const skillName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: skillName,
        collectionId: skillName,
        name: displayName,
        description: this.description || `A ${displayName} skill`,
        author: this.author || process.env.USER || 'Your Name'
      };

      // Determine output path
      const outputPath = this.pathOption || 'skills';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.skill);

      // Scaffold the skill
      const result = await templateEngine.scaffoldProject(targetPath, context);

      if (!result.success) {
        const err = new RegistryError({
          code: 'FS.SCAFFOLD_FAILED',
          message: result.error || 'Scaffolding failed'
        });
        renderError(err, ctx);
        return 1;
      }

      // Add to collection if specified
      if (this.collection) {
        const collectionId = this.collection;
        const collectionFile = path.join(ctx.cwd(), 'collections', `${collectionId}.collection.yml`);

        try {
          const collection = readCollection(ctx.cwd(), collectionFile);

          // Calculate repo-root relative path
          const createdFile = result.createdFiles[0];
          const relativePath = path.relative(ctx.cwd(), createdFile).replace(/\\/g, '/');

          // Add item to collection
          const newItem: CollectionItem = {
            path: relativePath,
            kind: 'skill',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add skill to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'skill create',
        output: fmt,
        status: 'ok',
        data: {
          name: skillName,
          path: result.createdFiles[0],
          createdFiles: result.createdFiles,
          collection: this.collection
        }
      });
      return 0;
    } catch (error) {
      const registryError = error instanceof RegistryError
        ? error
        : new RegistryError({
          code: 'INTERNAL.UNEXPECTED',
          message: (error as Error).message
        });

      renderError(registryError, ctx);
      return 1;
    }
  }
}

/**
 * Create a configured skill create command class.
 * @param ctx
 */
const createSkillCreateCommandDefinition = (
  ctx: Context
): typeof SkillCreateCommand => {
  class ConfiguredCommand extends SkillCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(SkillCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured skill create command class.
 * @param ctx
 */
export const createSkillCreateCommandClass = (
  ctx: Context
): typeof SkillCreateCommand => {
  return createSkillCreateCommandDefinition(ctx);
};
