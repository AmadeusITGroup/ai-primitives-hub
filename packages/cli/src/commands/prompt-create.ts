/**
 * `prompt create` subcommand.
 *
 * Creates a new prompt file with proper structure using templates.
 *
 * Usage:
 *   prompt-registry prompt create hello \
 *     --description "A greeting prompt"
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
 * Command context for prompt create command.
 */
interface PromptCreateContext {
  ctx: Context;
}

/**
 * Base class for prompt create command.
 */
abstract class BasePromptCreateCommand extends Command {
  public commandContext: PromptCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for prompt create.
 */
export class PromptCreateCommand extends BasePromptCreateCommand {
  public static readonly paths = [['prompt', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new prompt file',
    category: 'Primitive',
    details: `
      Usage: prompt-registry prompt create <name> [options]

      Options:
        --description <text>   Prompt description
        --path <dir>           Output directory (default: prompts/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry prompt create hello
        prompt-registry prompt create hello --description "A greeting prompt"
    `
  });

  public name = Option.String({ required: true });
  public description = Option.String('--description');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine prompt name
      const promptName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: promptName,
        collectionId: promptName,
        name: displayName,
        description: this.description || `A ${displayName} prompt`
      };

      // Determine output path
      const outputPath = this.pathOption || 'prompts';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.prompt);

      // Scaffold the prompt
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
            kind: 'prompt',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add prompt to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'prompt create',
        output: fmt,
        status: 'ok',
        data: {
          name: promptName,
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
 * Create a configured prompt create command class.
 * @param ctx
 */
const createPromptCreateCommandDefinition = (
  ctx: Context
): typeof PromptCreateCommand => {
  class ConfiguredCommand extends PromptCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(PromptCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured prompt create command class.
 * @param ctx
 */
export const createPromptCreateCommandClass = (
  ctx: Context
): typeof PromptCreateCommand => {
  return createPromptCreateCommandDefinition(ctx);
};
