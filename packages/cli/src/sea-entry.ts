#!/usr/bin/env node
/**
 * SEA binary entry point.
 * This file is bundled into the SEA blob and executes the CLI.
 */
import {
  main,
} from './main';

// Suppress the Node.js Single Executable Application experimental warning
// so end-users never see it in production builds.
const originalEmitWarning = process.emitWarning.bind(process) as (warning: string | Error, ...args: unknown[]) => void;
process.emitWarning = (warning, ...args): void => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('Single executable application')) {
    return;
  }
  originalEmitWarning(warning, ...args);
};

main().then((exitCode) => {
  process.exit(exitCode ?? 0);
}).catch((error) => {
  // eslint-disable-next-line no-console -- SEA fatal error; must print to stderr before exit.
  console.error(error);
  process.exit(1);
});
