/**
 * Enhanced global help renderer with progressive disclosure.
 *
 * Produces a landing-page style help output when the CLI is invoked
 * with no arguments or with `--help`. Shows a Quick Start section
 * followed by commands grouped into categories.
 *
 * Ported from feat/cli-backup (commit 44c5678, author: Waldek Herka).
 * Adapted from clipanion-based to our function-based CLI structure.
 */
import {
  type CliCommand,
  getCliCommandDefinition,
  SUPPORTED_CLI_COMMANDS,
} from './cli';

interface CommandEntry {
  path: string;
  description: string;
  category: string;
}

const CATEGORY_ORDER: readonly string[] = [
  'Getting Started',
  'Install & Manage',
  'Inspect & Validate',
  'Create & Scaffold',
  'Configure & Debug'
];

const COMMAND_CATEGORIES: Record<CliCommand, string> = {
  list: 'Getting Started',
  install: 'Install & Manage',
  update: 'Install & Manage',
  uninstall: 'Install & Manage',
  validate: 'Inspect & Validate',
  inspect: 'Inspect & Validate',
  completion: 'Configure & Debug',
  scaffold: 'Create & Scaffold'
};

const QUICK_START: readonly { command: string; description: string }[] = [
  { command: 'list', description: 'List available or installed bundles.' },
  { command: 'install', description: 'Install a bundle to a target.' },
  { command: 'validate', description: 'Validate a local bundle before install.' }
];

/**
 * Render the global help landing page with progressive disclosure.
 * @param name     — binary name, e.g. "prompt-registry".
 * @param version  — binary version, e.g. "1.0.0".
 * @returns Multi-line string ready for stdout.
 */
export const renderGlobalHelp = (
  name = 'prompt-registry',
  version = '1.0.0'
): string => {
  const entries: CommandEntry[] = SUPPORTED_CLI_COMMANDS.map((cmd) => {
    const def = getCliCommandDefinition(cmd);
    return {
      path: def.name,
      description: def.description,
      category: COMMAND_CATEGORIES[cmd] ?? 'Other'
    };
  });

  const byCategory = new Map<string, CommandEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  for (const list of byCategory.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }

  const lines: string[] = [
    `${name} ${version} — Copilot prompt bundle manager\n`,
    'Quick Start\n'
  ];

  const qsMaxPath = Math.min(18, Math.max(...QUICK_START.map((e) => e.command.length)));
  for (const entry of QUICK_START) {
    const pathCol = entry.command.padEnd(qsMaxPath + 2);
    lines.push(`  ${pathCol}${entry.description}\n`);
  }
  lines.push('\n');

  for (const category of CATEGORY_ORDER) {
    const list = byCategory.get(category);
    if (!list || list.length === 0) {
      continue;
    }

    lines.push(`${category}\n`);

    const maxPathLen = Math.min(24, Math.max(...list.map((e) => e.path.length)));

    for (const entry of list) {
      const pathCol = entry.path.padEnd(maxPathLen + 2);
      lines.push(`  ${pathCol}${entry.description}\n`);
    }
    lines.push('\n');
  }

  lines.push(`Run '${name} <command> -h' for detailed usage and examples.\n`);

  return lines.join('');
};
