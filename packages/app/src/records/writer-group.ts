/**
 * Writer group: tools whose repository layout writes the same kinds to the same
 * folders, so one install serves them all and their entries move together.
 * @module records/writer-group
 */
import type {
  ScopedLayoutDef,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';

const toRouteKey = (kind: string): string => (kind.endsWith('/') ? kind : `${kind}/`);

// A tool without a repository layout writes with its user layout.
const repositoryLayoutOf = (tool: string): ScopedLayoutDef | undefined => {
  const layout = Object.hasOwn(defaultLayouts.layouts, tool) ? defaultLayouts.layouts[tool] : undefined;
  return layout?.repository ?? layout?.user;
};

/**
 * Tools that write the given kinds to the same repository folders as the host tool, sorted.
 * @param hostTool - The tool that ran the writer.
 * @param writtenKinds - Kinds the bundle wrote, e.g. `prompts/`.
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
