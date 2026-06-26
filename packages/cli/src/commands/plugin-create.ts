/**
 * `plugin create` subcommand.
 *
 * Creates a new plugin directory with plugin.json using templates.
 *
 * Usage:
 *   prompt-registry plugin create my-plugin \
 *     --description "My custom plugin"
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
 * Command context for plugin create command.
 */
interface PluginCreateContext {
  ctx: Context;
}

/**
 * Base class for plugin create command.
 */
abstract class BasePluginCreateCommand extends Command {
  public commandContext: PluginCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for plugin create.
 */
export class PluginCreateCommand extends BasePluginCreateCommand {
  public static readonly paths = [['plugin', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new plugin directory',
    category: 'Primitive',
    details: `
      Usage: prompt-registry plugin create <name> [options]

      Options:
        --description <text>   Plugin description
        --version <version>   Plugin version (default: 1.0.0)
        --author <name>        Author name
        --path <dir>           Output directory (default: plugins/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry plugin create my-plugin
        prompt-registry plugin create my-plugin --description "My custom plugin"
    `
  });

  public name = Option.String({ required: true });
  public description = Option.String('--description');
  public version = Option.String('--version');
  public author = Option.String('--author');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine plugin name
      const pluginName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: pluginName,
        collectionId: pluginName,
        name: displayName,
        description: this.description || `A ${displayName} plugin`,
        version: this.version || '1.0.0',
        author: this.author || process.env.USER || 'Your Name'
      };

      // Determine output path
      const outputPath = this.pathOption || 'plugins';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.plugin);

      // Scaffold the plugin
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
            kind: 'plugin',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add plugin to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'plugin create',
        output: fmt,
        status: 'ok',
        data: {
          name: pluginName,
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
 * Create a configured plugin create command class.
 * @param ctx
 */
const createPluginCreateCommandDefinition = (
  ctx: Context
): typeof PluginCreateCommand => {
  class ConfiguredCommand extends PluginCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(PluginCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured plugin create command class.
 * @param ctx
 */
export const createPluginCreateCommandClass = (
  ctx: Context
): typeof PluginCreateCommand => {
  return createPluginCreateCommandDefinition(ctx);
};
