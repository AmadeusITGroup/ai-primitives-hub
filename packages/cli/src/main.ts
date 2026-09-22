#!/usr/bin/env node
/**
 * CLI entry point for the ai-primitives-hub CLI.
 * @module main
 */
import {
  defaultTokenProvider,
  NodeHttpClient,
} from '@ai-primitives-hub/infra';
import {
  ALL_COMMAND_CLASSES,
} from './commands/registry';
import {
  createProductionContext,
  runCli,
} from './framework';

/**
 * Main entry point.
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const ctx = createProductionContext();
  const http = new NodeHttpClient();
  const tokens = defaultTokenProvider(ctx.env);

  const exitCode = await runCli(process.argv.slice(2), {
    ctx,
    commands: [],
    commandClasses: ALL_COMMAND_CLASSES,
    name: 'ai-primitives-hub',
    version: '1.0.0',
    http,
    tokens,
    defaultOutput: 'text'
  });

  return exitCode;
}

// Export for use by index.ts and bin/ai-primitives-hub.js
export { main };
