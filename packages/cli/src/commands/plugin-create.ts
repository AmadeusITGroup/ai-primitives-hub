/**
 * `plugin create` subcommand.
 *
 * Scaffolds an Agent Plugins 1.0.0 plugin at `<path>/<name>/plugin.json`
 * (default `plugins/<name>/plugin.json`) through app's `createPlugin`, and
 * optionally adds it to a collection. Invalid names are rejected before
 * anything is written; an existing manifest is never overwritten.
 *
 * Usage:
 *   ai-primitives-hub plugin create my-plugin \
 *     --description "My custom plugin" --collection my-collection
 * @module commands/plugin-create
 */
import * as path from 'node:path';
import {
  createPlugin,
  type CreatePluginErrorCode,
  readCollection,
  writeCollection,
} from '@ai-primitives-hub/app';
import type {
  CollectionItem,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

const ERROR_CODES: Record<CreatePluginErrorCode, string> = {
  'invalid-name': 'PRIMITIVE.INVALID_NAME',
  'already-exists': 'PRIMITIVE.ALREADY_EXISTS',
  'scaffold-failed': 'FS.SCAFFOLD_FAILED'
};

/**
 * Plugin create command class.
 */
export class PluginCreateCommand extends Command {
  public static readonly paths = [['plugin', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new Agent Plugins 1.0.0 plugin directory',
    category: 'Primitive',
    details: `
      Usage: ai-primitives-hub plugin create <name> [options]

      Writes <path>/<name>/plugin.json with $schema, name, version, description and author.
      <name> must be 1-64 lowercase letters, digits, "." or "-", start and end with a
      letter or digit, and contain no "--" or "..". Invalid names are rejected and
      nothing is written. An existing plugin.json is never overwritten.

      Options:
        --description <text>   Plugin description
        --version <version>    Plugin version (default: 1.0.0)
        --author <name>        Author name
        --path <dir>           Parent directory (default: plugins/); the plugin is written to <dir>/<name>/plugin.json
        --collection <id>      Add the plugin to collections/<id>.collection.yml
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub plugin create my-plugin
        ai-primitives-hub plugin create my-plugin --description "My custom plugin"
        ai-primitives-hub plugin create my-plugin --collection my-collection
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
      const outputPath = this.pathOption || 'plugins';
      const parentDir = path.isAbsolute(outputPath) ? outputPath : path.join(ctx.cwd(), outputPath);

      const result = await createPlugin({
        parentDir,
        name: this.name,
        description: this.description,
        version: this.version,
        author: this.author || process.env.USER || 'Your Name'
      });

      if (!result.success) {
        const err = new RegistryError({
          code: ERROR_CODES[result.error?.code ?? 'scaffold-failed'],
          message: result.error?.message || 'Scaffolding failed',
          hint: result.error?.hint,
          context: { name: this.name, path: result.manifestPath }
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

          // Repo-root relative path to the plugin's root plugin.json
          const relativePath = path.relative(ctx.cwd(), result.manifestPath).replace(/\\/g, '/');

          const newItem: CollectionItem = {
            path: relativePath,
            kind: 'plugin',
            name: this.name,
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

      formatOutput({
        ctx,
        command: 'plugin create',
        output: fmt,
        status: 'ok',
        data: {
          name: this.name,
          path: result.manifestPath,
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
