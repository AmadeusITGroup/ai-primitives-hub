/**
 * `primitive validate` subcommand.
 *
 * Thin delivery adapter: runs the shared primitive rules (skills, agents, prompts,
 * instructions and MCP servers) through the governance engine in `@ai-primitives-hub/app`.
 * @module commands/primitive-validate
 */
import {
  GOVERNED_PRIMITIVE_KINDS,
  type GovernedPrimitiveKind,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  Option,
  type OutputFormat,
} from '../framework';
import {
  executeValidationGovernance,
} from './validation-governance';

export class PrimitiveValidateCommand extends Command {
  public static readonly paths = [['primitive', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate skill, agent, prompt, instruction and MCP server files with the governance rules.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub primitive validate <path>... [options]
             ai-primitives-hub primitive validate [<path>...] --base-ref <commit> --head-ref <commit>

      Each path is a file or a directory (searched recursively). The kind is inferred
      from the file name: SKILL.md, *.agent.md, *.prompt.md, *.instructions.md, mcp.json
      or *.mcp.json. A hub-governance.yml at the repository root is applied if present.

      PR mode (--base-ref and --head-ref): only primitives the PR added or modified are
      validated, limited to the given paths (default: the whole repository). The checkout
      must be at --head-ref with full history.

      Options:
        -o, --output <format>   Output format (text, json, yaml, ndjson)
        --kind <kind>           Force the kind: ${GOVERNED_PRIMITIVE_KINDS.join(', ')}
        --policy <path>         Governance configuration (default: hub-governance.yml)
        --min-score <number>    Enforce a 0-100 score floor
        --report-path <path>    Write the Markdown report to a file
        --base-ref <commit>     PR mode: exact base commit
        --head-ref <commit>     PR mode: exact head commit (must be checked out)
    `,
    examples: [
      ['Validate every primitive in a folder', 'ai-primitives-hub primitive validate prompts/'],
      ['Validate one MCP file', 'ai-primitives-hub primitive validate servers.json --kind mcp-server'],
      ['Validate only what a PR changed', 'ai-primitives-hub primitive validate --base-ref <base-sha> --head-ref <head-sha>']
    ]
  });

  public output = Option.String('-o,--output');
  public kind = Option.String('--kind');
  public policy = Option.String('--policy');
  public minScore = Option.String('--min-score');
  public reportPath = Option.String('--report-path');
  public baseRef = Option.String('--base-ref');
  public headRef = Option.String('--head-ref');
  public inputs = Option.Rest();
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    if (this.kind !== undefined && !(GOVERNED_PRIMITIVE_KINDS as readonly string[]).includes(this.kind)) {
      ctx.stderr.write(`Unknown --kind '${this.kind}'. Use one of: ${GOVERNED_PRIMITIVE_KINDS.join(', ')}.\n`);
      return Promise.resolve(1);
    }
    const prMode = this.baseRef !== undefined || this.headRef !== undefined;
    if (!prMode && this.inputs.length === 0) {
      ctx.stderr.write('Give at least one file or directory, or use --base-ref and --head-ref for PR mode.\n');
      return Promise.resolve(1);
    }
    return executeValidationGovernance(ctx, {
      subject: 'primitive', primitivePaths: this.inputs, primitiveKind: this.kind as GovernedPrimitiveKind | undefined
    }, { governance: true, policy: this.policy, minScore: this.minScore, reportPath: this.reportPath, baseRef: this.baseRef, headRef: this.headRef },
    (this.output ?? 'text') as OutputFormat);
  }
}
