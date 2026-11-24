/**
 * The user level's home folder, shared by the CLI, the extension and doctor,
 * and the pre-write check that a user target folder sits inside it.
 * @module records/user-home
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordError,
  type RecordFs,
  relativeInside,
} from '@ai-primitives-hub/core';
import {
  confinePath,
} from './confine-path';

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * The user level's home folder: `HOME`, else `USERPROFILE`, else `os.homedir()`.
 * Unlike infra's `homeDir`, `HOME` wins on Windows too, because the writers expand `~` against it.
 * @param env - Environment variables.
 */
export const resolveUserHome = (env: Record<string, string | undefined>): string =>
  path.resolve(nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE) ?? os.homedir());

const outsideHomeHint = (home: string): string =>
  `Use a target under ${home} or a repository target.`;

/**
 * Refuse a user target folder whose real path is outside home; it need not exist yet.
 * @param fs - Filesystem port.
 * @param home - Home folder.
 * @param folder - Absolute folder the writer will write into.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT`.
 */
export const assertUserFolderInsideHome = async (fs: RecordFs, home: string, folder: string): Promise<void> => {
  // Home itself is not a target folder: it counts as outside.
  const relative = relativeInside(path.resolve(home), path.resolve(folder));
  const refuse = (cause?: unknown) => recordError('RECORD.PATH_OUTSIDE_ROOT', {
    message: 'The user target folder is outside the home folder; nothing was written.',
    detail: `the user target folder ${folder} is outside the home folder ${home}`,
    hint: outsideHomeHint(home),
    context: { folder, home },
    ...(cause === undefined ? {} : { cause })
  });
  if (relative === undefined) {
    throw refuse();
  }
  try {
    // Check a probe leaf, so the target folder itself is realpath'd too.
    await confinePath(fs, home, `${relative}/.ai-primitives-hub-probe`);
  } catch (error) {
    throw refuse(error);
  }
};
