/**
 * `hook create` subcommand.
 *
 * Creates a new hook configuration file using templates.
 *
 * Usage:
 *   prompt-registry hook create format \
 *     --type "format" \
 *     --description "Formatting hook"
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
 * Command context for hook create command.
 */
interface HookCreateContext {
  ctx: Context;
}

/**
 * Base class for hook create command.
 */
abstract class BaseHookCreateCommand extends Command {
  public commandContext: HookCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for hook create.
 */
export class HookCreateCommand extends BaseHookCreateCommand {
  public static readonly paths = [['hook', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new hook configuration file',
    category: 'Primitive',
    details: `
      Usage: prompt-registry hook create <name> [options]

      Options:
        --type <type>          Hook type (e.g., format, validate)
        --description <text>   Hook description
        --path <dir>           Output directory (default: hooks/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry hook create format --type format
        prompt-registry hook create format --type format --description "Formatting hook"
    `
  });

  public name = Option.String({ required: true });
  public type = Option.String('--type');
  public description = Option.String('--description');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine hook name
      const hookName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: hookName,
        collectionId: hookName,
        name: displayName,
        type: this.type || 'generic',
        description: this.description || `A ${displayName} hook`
      };

      // Determine output path
      const outputPath = this.pathOption || 'hooks';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.hook);

      // Scaffold the hook
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
            kind: 'hook',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add hook to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'hook create',
        output: fmt,
        status: 'ok',
        data: {
          name: hookName,
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
 * Create a configured hook create command class.
 * @param ctx
 */
const createHookCreateCommandDefinition = (
  ctx: Context
): typeof HookCreateCommand => {
  class ConfiguredCommand extends HookCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(HookCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured hook create command class.
 * @param ctx
 */
export const createHookCreateCommandClass = (
  ctx: Context
): typeof HookCreateCommand => {
  return createHookCreateCommandDefinition(ctx);
};
