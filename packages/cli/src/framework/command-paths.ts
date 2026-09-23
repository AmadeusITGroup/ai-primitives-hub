/**
 * Derive the full flat list of registered command paths from clipanion
 * command classes and declarative `CommandDefinition`s.
 *
 * This is the single derivation point that lets the `completion`
 * command generate shell-completion scripts that stay in sync with
 * whatever is registered in `commands/registry.ts` (or passed via
 * `runCli`'s `opts.commands`) — no separate, hand-maintained list of
 * command/subcommand names. Path segments must be shell-word tokens: the
 * generated completion scripts use spaces to serialize and parse paths.
 * @module framework/command-paths
 */
import type {
  CommandClass,
} from 'clipanion';

/**
 * Read each class's static `paths` field (clipanion's own path
 * declarations, e.g. `[['index', 'search'], ['search']]` for an
 * aliased command), merge in any extra declarative paths (from
 * `defineCommand`-based `CommandDefinition`s registered via `runCli`'s
 * `opts.commands`), and flatten/deduplicate the result into one sorted
 * list.
 * @param classes Command classes as registered with clipanion (`Cli.register`).
 * @param extraPaths Paths from declarative `CommandDefinition`s (`opts.commands`), if any are registered alongside `classes`.
 * @returns Deduplicated, lexicographically sorted list of path segments.
 */
export const collectCommandPaths = (
  classes: readonly CommandClass[],
  extraPaths: readonly string[][] = []
): string[][] => {
  const seen = new Set<string>();
  const paths: string[][] = [];

  const addPath = (path: string[]): void => {
    const key = path.join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(path);
    }
  };

  for (const cls of classes) {
    const classPaths = (cls as unknown as { paths?: string[][] }).paths ?? [];
    for (const path of classPaths) {
      addPath(path);
    }
  }

  for (const path of extraPaths) {
    addPath(path);
  }

  return paths.toSorted((a, b) => a.join(' ').localeCompare(b.join(' ')));
};

/**
 * Read the command-path list injected into a command's `commandContext`
 * by `runCli`. Mirrors `getCommandContext`'s extraction pattern.
 * @param command Command class instance with an optional `commandContext` property.
 * @returns The full set of registered command paths (may be empty for test harnesses that register a subset of commands).
 */
export const getCommandPaths = (command: unknown): string[][] =>
  (command as { commandContext?: { commandPaths?: string[][] } }).commandContext?.commandPaths ?? [];
