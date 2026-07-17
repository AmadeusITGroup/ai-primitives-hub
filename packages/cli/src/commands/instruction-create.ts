/**
 * `instruction create` subcommand.
 *
 * Creates a new instruction file with proper structure using templates.
 *
 * Usage:
 *   ai-primitives-hub instruction create style \
 *     --description "Code style guidelines"
 * @module commands/instruction-create
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
 * Instruction create command class.
 */
export class InstructionCreateCommand extends Command {
  public static readonly paths = [['instruction', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new instruction file',
    category: 'Primitive',
    details: `
      Usage: ai-primitives-hub instruction create <name> [options]

      Options:
        --description <text>   Instruction description
        --path <dir>           Output directory (default: instructions/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub instruction create style
        ai-primitives-hub instruction create style --description "Code style guidelines"
    `
  });

  public name = Option.String({ required: true });
  public description = Option.String('--description');
  public collection = Option.String('--collection');
  public pathOption = Option.String('--path');
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');

    try {
      // Determine instruction name
      const instructionName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: instructionName,
        collectionId: instructionName,
        name: displayName,
        description: this.description || `A ${displayName} instruction`
      };

      // Determine output path
      const outputPath = this.pathOption || 'instructions';
      const targetPath = path.isAbsolute(outputPath) ? outputPath : path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.instruction);

      // Scaffold the instruction
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
            kind: 'instruction',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add instruction to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'instruction create',
        output: fmt,
        status: 'ok',
        data: {
          name: instructionName,
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
