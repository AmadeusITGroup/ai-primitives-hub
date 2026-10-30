/**
 * Writer group for the shared-folder sync (BR11.6; nfr-design
 * security-design "Sibling sync").
 *
 * When a tool installs a bundle at repository level, other tools whose
 * repository layout writes the same kinds to the same place hold the same
 * files. Those tools form the host's writer group: one write serves them all,
 * so their entries can be moved to the new version (`syncSiblings`). Any
 * other tool sharing a path is reported out of date instead.
 * @module records/writer-group
 */
import type {
  ScopedLayoutDef,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';

/**
 * A kind as a `kindRoutes` key: a bundle sub-path prefix ending in `/`.
 * @param kind - Kind as given, e.g. `prompts` or `prompts/`.
 */
const toRouteKey = (kind: string): string => (kind.endsWith('/') ? kind : `${kind}/`);

/**
 * The built-in repository layout of a tool; the user layout when it has no repository one.
 * @param tool - Target type.
 */
const repositoryLayoutOf = (tool: string): ScopedLayoutDef | undefined => {
  const layout = Object.hasOwn(defaultLayouts.layouts, tool) ? defaultLayouts.layouts[tool] : undefined;
  return layout?.repository ?? layout?.user;
};

/**
 * Tools that write the given kinds to the same repository folders as the host
 * tool (BR11.6): the same `baseDir` and the same route for every written kind.
 * @param hostTool - The tool that ran the writer, e.g. `vscode`.
 * @param writtenKinds - Kinds the bundle wrote, as `kindRoutes` keys (`prompts/`); a missing trailing `/` is added.
 * @returns The group, always including `hostTool`, sorted.
 */
export const writerGroupFor = (hostTool: string, writtenKinds: readonly string[]): string[] => {
  const host = repositoryLayoutOf(hostTool);
  if (host === undefined) {
    return [hostTool];
  }
  const routeKeys = writtenKinds.map((kind) => toRouteKey(kind));
  const group = Object.keys(defaultLayouts.layouts).filter((tool) => {
    const layout = repositoryLayoutOf(tool);
    return layout !== undefined
      && layout.baseDir === host.baseDir
      && routeKeys.every((key) => layout.kindRoutes[key] === host.kindRoutes[key]);
  });
  return [...new Set([hostTool, ...group])].toSorted();
};
