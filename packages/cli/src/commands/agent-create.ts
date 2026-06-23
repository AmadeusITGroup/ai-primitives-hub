/**
 * `agent create` subcommand.
 *
 * Creates a new agent file with proper structure using templates.
 *
 * Usage:
 *   prompt-registry agent create coder \
 *     --description "Coding assistant agent"
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
 * Command context for agent create command.
 */
interface AgentCreateContext {
  ctx: Context;
}

/**
 * Base class for agent create command.
 */
abstract class BaseAgentCreateCommand extends Command {
  public commandContext: AgentCreateContext = { ctx: null as any };
}

/**
 * Native clipanion class command for agent create.
 */
export class AgentCreateCommand extends BaseAgentCreateCommand {
  public static readonly paths = [['agent', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new agent file',
    category: 'Primitive',
    details: `
      Usage: prompt-registry agent create <name> [options]

      Options:
        --description <text>   Agent description
        --path <dir>           Output directory (default: agents/)
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry agent create coder
        prompt-registry agent create coder --description "Coding assistant agent"
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
      // Determine agent name
      const agentName = generateSanitizedId(this.name);
      const displayName = this.name;

      // Build template context
      const context: TemplateContext = {
        projectName: agentName,
        collectionId: agentName,
        name: displayName,
        description: this.description || `A ${displayName} agent`
      };

      // Determine output path
      const outputPath = this.pathOption || 'agents';
      const targetPath = path.join(ctx.cwd(), outputPath);

      // Initialize template engine
      const templateEngine = new TemplateEngine(TEMPLATE_PATHS.agent);

      // Scaffold the agent
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
            kind: 'agent',
            name: displayName,
            description: this.description
          };

          collection.items.push(newItem);
          writeCollection(ctx.cwd(), collectionFile, collection);
        } catch (error) {
          const err = new RegistryError({
            code: 'FS.COLLECTION_UPDATE_FAILED',
            message: `Failed to add agent to collection: ${(error as Error).message}`
          });
          renderError(err, ctx);
          return 1;
        }
      }

      // Format output
      formatOutput({
        ctx,
        command: 'agent create',
        output: fmt,
        status: 'ok',
        data: {
          name: agentName,
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
 * Create a configured agent create command class.
 * @param ctx
 */
const createAgentCreateCommandDefinition = (
  ctx: Context
): typeof AgentCreateCommand => {
  class ConfiguredCommand extends AgentCreateCommand {
    public async execute(): Promise<number> {
      this.commandContext = { ctx };
      return super.execute();
    }
  }

  copyCommandPrototype(AgentCreateCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured agent create command class.
 * @param ctx
 */
export const createAgentCreateCommandClass = (
  ctx: Context
): typeof AgentCreateCommand => {
  return createAgentCreateCommandDefinition(ctx);
};
