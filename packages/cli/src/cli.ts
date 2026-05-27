/**
 * Shared CLI argument parsing utilities.
 * @module cli
 */

/**
 * Parse a single-value CLI argument.
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--collection-file')
 * @returns The value if found, undefined otherwise
 */
export function parseSingleArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return undefined;
}

/**
 * Parse a multi-value CLI argument (can appear multiple times).
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--changed-path')
 * @returns Array of values
 */
export function parseMultiArg(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) {
      values.push(argv[i + 1]);
      i++;
    }
  }
  return values;
}

/**
 * Check if a boolean flag is present.
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--dry-run')
 * @returns True if flag is present
 */
export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/**
 * Get positional argument at index (after filtering out flags).
 * @param argv - Command line arguments
 * @param index - Positional index (0-based)
 * @returns The positional argument if found
 */
export function getPositionalArg(argv: string[], index: number): string | undefined {
  let posIndex = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      // Skip flag and its value if it has one
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        i++;
      }
      continue;
    }
    if (posIndex === index) {
      return arg;
    }
    posIndex++;
  }
  return undefined;
}
