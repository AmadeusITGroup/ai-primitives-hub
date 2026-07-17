/**
 * `plugin create` subcommand.
 *
 * Creates a new plugin directory with plugin.json using templates.
 *
 * Usage:
 *   ai-primitives-hub plugin create my-plugin \
 *     --description "My custom plugin"
 * @module commands/plugin-create
 */
import * as path from 'node:path';
import {
  readCollection,
  writeCollection,
} from '@ai-primitives-hub/app';
import {
  generateSanitizedId,
  TemplateContext,
} from '@ai-primitives-hub/core';
import type {
  CollectionItem,
} from '@ai-primitives-hub/core';
import {
  TEMPLATE_PATHS,
  TemplateEngine,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Plugin create command class.
 */
export class PluginCreateCommand extends Command {
  public static readonly paths = [['plugin', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new plugin directory',
    category: 'Primitive',
    details: `
      Usage: ai-primitives-hub plugin create <name> [options]

      Options:
        --description <text>   Plugin description
        --version <version>   Plugin version (default: 1.0.0)
        --author <name>        Author name
        --path <dir>           Output directory (default: plugins/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub plugin create my-plugin
        ai-primitives-hub plugin create my-plugin --description "My custom plugin"
    `
  });

  public name = Option.String({ required: true });
  public description = Option.String('--description');
  public version = Option.String('--version');
  public author = Option.String('--author');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

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
      const targetPath = path.isAbsolute(outputPath) ? outputPath : path.join(ctx.cwd(), outputPath);

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
