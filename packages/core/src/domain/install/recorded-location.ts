/**
 * Where a recorded install file lives on disk.
 *
 * A lockfile entry records each file by its bundle-relative `path` and,
 * when the writer placed it somewhere the route doesn't predict, an
 * `installedPath` relative to the target's base directory. Uninstall,
 * superseded-file removal and modified checks turn those records back
 * into absolute locations with the rule below, so they find exactly the
 * file the install wrote and never a path outside the target root (the
 * lockfile is user-editable).
 *
 * Pure and lexical: no IO. Symlinked directories below the root are a
 * real-path concern of the caller.
 * @module domain/install/recorded-location
 */
import * as path from 'node:path';
import {
  matchKindRoute,
} from './kind-route';
import type {
  KindRoutes,
} from './layout';

/** A file as a lockfile entry records it. */
export interface RecordedFile {
  /** Bundle-relative path (workspace-relative in entries of earlier extension versions). */
  path: string;
  /** Output path relative to the target's base directory, `/`-separated. */
  installedPath?: string;
}

/** Locations of recorded files, in the order they were asked for. */
export interface RecordedLocations {
  /** Absolute base directory every location lies below. */
  root: string;
  /** Absolute location per file, or `null` when it has none inside `root`. */
  paths: (string | null)[];
}

const DRIVE_PATH = /^[A-Za-z]:/;

/**
 * Join a relative path below a root, refusing anything that would name the
 * root itself or a path outside it.
 * @param root - Absolute root directory.
 * @param relative - Path relative to `root`; `\` and `/` are both separators.
 * @returns The absolute location, or `null` when `relative` is empty, `.`,
 *   absolute (POSIX or win32), a drive path, a UNC path, or normalises to a
 *   path above `root`.
 */
export const resolveContained = (root: string, relative: string): string | null => {
  if (relative === ''
    || path.posix.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || DRIVE_PATH.test(relative)) {
    return null;
  }
  const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === './' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return path.join(root, ...normalized.split('/'));
};

/**
 * Whether `candidate` lies strictly below `root`.
 * @param root - Absolute root directory.
 * @param candidate - Absolute path.
 * @returns True when `candidate` is inside `root` and not `root` itself.
 */
const isStrictlyBelow = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

/**
 * First `/`-separated segment of a path.
 * @param value - Path with `/` separators.
 * @returns The first segment.
 */
const firstSegment = (value: string): string => value.split('/')[0];

/**
 * Dot directories a legacy workspace-relative entry may start with: the
 * first segment of the root below the workspace (`.github`, `.kiro` …), or,
 * when the root is the workspace itself, the host's own dot directories
 * taken from its routes (`.cursor`, `.devin` …).
 * @param root - Absolute target root.
 * @param routes - Layout routes.
 * @param workspaceRoot - Absolute workspace root.
 * @returns The allowed first segments; empty when `root` is outside the workspace.
 */
const legacyDotDirectories = (root: string, routes: KindRoutes, workspaceRoot: string): Set<string> => {
  const rel = path.relative(workspaceRoot, root).split(path.sep).join('/');
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return new Set();
  }
  if (rel !== '') {
    return new Set([firstSegment(rel)]);
  }
  return new Set(Object.values(routes)
    .map((outPrefix) => firstSegment(outPrefix.replaceAll('\\', '/')))
    .filter((segment) => segment.startsWith('.')));
};

/**
 * Locate a recorded file inside a target root.
 *
 * 1. a recorded `installedPath` is resolved below `root`;
 * 2. otherwise the layout route matching the bundle path places it;
 * 3. otherwise, with a workspace root, a legacy workspace-relative entry
 *    (`.github/prompts/x.prompt.md`) is accepted when it starts with one of
 *    the host's dot directories and lies below `root`;
 * 4. otherwise the file has no location.
 *
 * The route wins over the legacy rule: bundle paths may themselves start
 * with a dot directory (`.kiro/steering/`), and a layout override may move
 * that route elsewhere.
 * @param input - Root, routes, workspace root and the recorded file.
 * @param input.root - Absolute target base directory.
 * @param input.routes - Layout `kindRoutes` of the target.
 * @param input.workspaceRoot - Absolute workspace root at repository
 *   scope, `null` elsewhere (disables the legacy rule).
 * @param input.file - The recorded file.
 * @returns The absolute location, or `null` when the file has none inside `root`.
 */
export const resolveRecordedLocation = (input: {
  root: string;
  routes: KindRoutes;
  workspaceRoot: string | null;
  file: RecordedFile;
}): string | null => {
  const { root, routes, workspaceRoot, file } = input;
  if (file.installedPath !== undefined) {
    return resolveContained(root, file.installedPath);
  }
  const route = matchKindRoute(file.path, routes);
  if (route !== null) {
    // Joined like the writers' `path.join(baseDir, outPrefix, tail)`: a route output may omit its trailing `/`.
    return resolveContained(root, path.posix.join(route.outPrefix.replaceAll('\\', '/'), route.tail));
  }
  // @migration-cleanup(lockfile-workspace-paths): earlier extension versions
  // recorded workspace-relative paths; read them until those entries are gone.
  if (workspaceRoot !== null) {
    const segment = firstSegment(path.posix.normalize(file.path.replaceAll('\\', '/')));
    if (segment.startsWith('.') && legacyDotDirectories(root, routes, workspaceRoot).has(segment)) {
      const candidate = resolveContained(workspaceRoot, file.path);
      return candidate !== null && isStrictlyBelow(root, candidate) ? candidate : null;
    }
  }
  return null;
};
