/**
 * `collection create` subcommand.
 *
 * Creates a new collection file with proper structure using templates.
 *
 * Usage:
 *   ai-primitives-hub collection create my-collection \
 *     --description "My prompt collection" \
 *     --author "Author Name" \
 *     --tags "ai,coding"
 * @module commands/collection-create
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateSanitizedId,
  TemplateContext,
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
 * Collection create command class.
 */
export class CollectionCreateCommand extends Command {
  public static readonly paths = [['collection', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new collection file',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub collection create <id> [options]

      Options:
        --name <name>          Display name (default: id)
        --description <text>   Collection description
        --author <name>        Author name
        --tags <tags>          Comma-separated tags
        --path <dir>           Output directory (default: collections/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub collection create my-collection
        ai-primitives-hub collection create my-collection --description "My prompts"
        ai-primitives-hub collection create my-collection --author "John Doe" --tags "ai,coding"
    `
  });

  public name = Option.String({ required: true });
  public nameOption = Option.String('--name');
  public description = Option.String('--description');
  public author = Option.String('--author');
  public tags = Option.String('--tags');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

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
      const targetPath = path.isAbsolute(outputPath) ? outputPath : path.join(ctx.cwd(), outputPath);

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
