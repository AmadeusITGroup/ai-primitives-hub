/**
 * `plugin create` subcommand.
 *
 * Scaffolds an Agent Plugins 1.0.0 plugin at `<path>/<name>/plugin.json`
 * (default `plugins/<name>/plugin.json`) through app's `createPlugin`, and
 * optionally adds it to a collection. Invalid names and an unreadable
 * `--collection` are rejected before anything is written; an existing
 * manifest is never overwritten.
 *
 * Usage:
 *   ai-primitives-hub plugin create my-plugin \
 *     --description "My custom plugin" --collection my-collection
 * @module commands/plugin-create
 */
import {
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  createPlugin,
  type CreatePluginErrorCode,
  readCollection,
  writeCollection,
} from '@ai-primitives-hub/app';
import {
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  type Collection,
  type CollectionItem,
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

const collectionUpdateError = (error: unknown): RegistryError => new RegistryError({
  code: 'FS.COLLECTION_UPDATE_FAILED',
  message: `Failed to add plugin to collection: ${(error as Error).message}`
});

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
      <name> must follow the Agent Plugins 1.0.0 name rule (e.g. my-plugin, acme.tools;
      at most ${AGENT_PLUGIN_NAME_MAX_LENGTH} characters). Invalid names are rejected with the rule and a
      suggested name, and nothing is written. With --collection, a missing collection
      is also rejected before writing. An existing plugin.json is never overwritten.

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

      // Read the collection before scaffolding: a missing or unreadable
      // collection must fail with nothing written, since an existing
      // plugin.json is never overwritten and would block a corrected rerun.
      const collectionFile = this.collection
        ? path.join(ctx.cwd(), 'collections', `${this.collection}.collection.yml`)
        : undefined;
      let collection: Collection | undefined;
      if (collectionFile) {
        try {
          collection = readCollection(ctx.cwd(), collectionFile);
        } catch (error) {
          renderError(collectionUpdateError(error), ctx);
          return 1;
        }
      }

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
      if (collection && collectionFile) {
        try {
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
          // Remove only the files this run created, so a rerun is not blocked
          // by its own plugin.json. Cleanup errors must not mask the write error.
          for (const file of result.createdFiles) {
            try {
              rmSync(file, { force: true });
            } catch {
              // Keep reporting the original collection-write error.
            }
          }
          renderError(collectionUpdateError(error), ctx);
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
