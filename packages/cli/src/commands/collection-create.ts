/**
 * `collection create` subcommand.
 *
 * Creates a new collection file with proper structure using templates.
 *
 * Usage:
 *   prompt-registry collection create my-collection \
 *     --description "My prompt collection" \
 *     --author "Author Name" \
 *     --tags "ai,coding"
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

/**
 * Command context for collection create command.
 */
interface CollectionCreateContext {
  ctx: Context;
}

/**
 * Base class for collection create command.
 */
abstract class BaseCollectionCreateCommand extends Command {
  public commandContext: CollectionCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for collection create.
 */
export class CollectionCreateCommand extends BaseCollectionCreateCommand {
  public static readonly paths = [['collection', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new collection file',
    category: 'Collection',
    details: `
      Usage: prompt-registry collection create <id> [options]

      Options:
        --name <name>          Display name (default: id)
        --description <text>   Collection description
        --author <name>        Author name
        --tags <tags>          Comma-separated tags
        --path <dir>           Output directory (default: collections/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry collection create my-collection
        prompt-registry collection create my-collection --description "My prompts"
        prompt-registry collection create my-collection --author "John Doe" --tags "ai,coding"
    `
  });

  public name = Option.String({ required: true });
  public nameOption = Option.String('--name');
  public description = Option.String('--description');
  public author = Option.String('--author');
  public tags = Option.String('--tags');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine collection ID and display name
      const collectionId = generateSanitizedId(this.name);
      const displayName = this.nameOption || this.name;

      // Parse tags
      const tags = this.tags ? this.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0) : [];
      const tagsLine = tags.length > 0 ? `tags: ${tags.map((t) => `"${t}"`).join(', ')}` : '';

      // Build template context
      const context: TemplateContext = {
        projectName: collectionId,
        collectionId,
        name: displayName,
        description: this.description,
        author: this.author,
        tags: tags.length > 0 ? tags : undefined,
        tags_line: tagsLine
      };

      // Determine output path
      const outputPath = this.pathOption || 'collections';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Use collection ID in filename
      const collectionFileName = `${collectionId}.collection.yml`;

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.collection);

      // Scaffold the collection
      const result = await templateEngine.scaffoldProject(targetPath, context);

      if (!result.success) {
        const err = new RegistryError({
          code: 'FS.SCAFFOLD_FAILED',
          message: result.error || 'Scaffolding failed'
        });
        renderError(err, ctx);
        return 1;
      }

      // Rename collection file to use collection ID
      const oldPath = result.createdFiles[0];
      const newPath = path.join(path.dirname(oldPath), collectionFileName);
      const fs = await import('node:fs');
      fs.renameSync(oldPath, newPath);
      result.createdFiles[0] = newPath;

      // Format output
      formatOutput({
        ctx,
        command: 'collection create',
        output: fmt,
        status: 'ok',
        data: {
          collectionId,
          path: result.createdFiles[0],
          createdFiles: result.createdFiles
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
 * Create a configured collection create command class.
 * @param ctx
 */
const createCollectionCreateCommandDefinition = (
  ctx: Context
): typeof CollectionCreateCommand => {
  class ConfiguredCommand extends CollectionCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(CollectionCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured collection create command class.
 * @param ctx
 */
export const createCollectionCreateCommandClass = (
  ctx: Context
): typeof CollectionCreateCommand => {
  return createCollectionCreateCommandDefinition(ctx);
};
