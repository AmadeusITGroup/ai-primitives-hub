/**
 * Global help renderer.
 *
 * Produces a landing-page style help output when the CLI is invoked
 * with no arguments or with `--help`. Replaces clipanion's default
 * dense listing with progressive disclosure: a short Quick Start
 * section followed by commands grouped into 6 consolidated categories.
 */
import type {
  Cli,
} from 'clipanion';

const CATEGORY_ORDER: readonly string[] = [
  'Getting Started',
  'Install & Manage',
  'Hub & Discovery',
  'Build & Author',
  'Index & Search',
  'Configure & Debug'
];

interface QuickStartEntry {
  command: string;
  description: string;
}

const QUICK_START: readonly QuickStartEntry[] = [
  { command: 'target add', description: 'Add your first install target (e.g. vscode, copilot-cli).' },
  { command: 'hub add', description: 'Import a hub from a GitHub repo or local path.' },
  { command: 'profile activate', description: 'Activate a profile on your configured targets.' }
];

interface HelpEntry {
  /** Command path without binary prefix, e.g. "init" or "index search". */
  path: string;
  /** One-line description. */
  description: string;
  /** Category for grouping. */
  category: string;
}

/**
 * Render the global help landing page.
 * @param cli      — clipanion Cli instance (already has all commands registered).
 * @param name     — binary name, e.g. "prompt-registry".
 * @param version  — binary version, e.g. "1.0.0".
 * @returns Multi-line string ready for stdout.
 */
export const renderGlobalHelp = (
  cli: Cli,
  name: string,
  version: string
): string => {
  const defs = cli.definitions({ colored: false });

  const entries: HelpEntry[] = [];
  for (const def of defs) {
    // Skip built-ins (--help, --version) and commands with no description.
    if (!def.description) {
      continue;
    }

    // def.path includes the binary name prefix (e.g. "prompt-registry init").
    // Strip it so we show just the command path.
    const prefix = `${name} `;
    const rawPath = def.path.startsWith(prefix)
      ? def.path.slice(prefix.length)
      : def.path;

    // Skip built-in --help / --version commands.
    if (rawPath === '--help' || rawPath === '-h' || rawPath === '--version') {
      continue;
    }

    entries.push({
      path: rawPath,
      description: def.description?.trim() ?? '',
      category: def.category?.trim() ?? 'Other'
    });
  }

  // Group by category.
  const byCategory = new Map<string, HelpEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  // Sort alphabetically within each category.
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }

  const lines: string[] = [`${name} ${version} — Copilot prompt bundle manager\n`, 'Quick Start\n'];

  // Quick Start — 3-command onboarding strip.
  const qsMaxPath = Math.min(18, Math.max(...QUICK_START.map((e) => e.command.length)));
  for (const entry of QUICK_START) {
    const pathCol = entry.command.padEnd(qsMaxPath + 2);
    lines.push(`  ${pathCol}${entry.description}\n`);
  }
  lines.push('\n');

  // Render categories in the prescribed order.
  for (const category of CATEGORY_ORDER) {
    const list = byCategory.get(category);
    if (!list || list.length === 0) {
      continue;
    }

    lines.push(`${category}\n`);

    // Compute the longest path so we can align descriptions.
    const maxPathLen = Math.min(
      24,
      Math.max(...list.map((e) => e.path.length))
    );

    for (const entry of list) {
      const pathCol = entry.path.padEnd(maxPathLen + 2);
      lines.push(`  ${pathCol}${entry.description}\n`);
    }
    lines.push('\n');
  }

  lines.push(`Run '${name} <command> -h' for detailed usage and examples.\n`);

  return lines.join('');
};
