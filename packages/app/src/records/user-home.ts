/**
 * The user level's home folder and the pre-write check that a user target
 * folder sits inside it (BR14.3, NFR4.16, NFR4.17).
 *
 * One home value serves the whole user level: it is the root every
 * user-level path is recorded against, and the `HOME` both deliveries'
 * writers expand `${HOME}` and `~` against (`expandPath` in core). The CLI,
 * the extension and doctor all call {@link resolveUserHome}, so the same
 * file gets the same relative path whoever wrote it.
 * @module records/user-home
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordError,
  type RecordFs,
} from '@ai-primitives-hub/core';
import {
  confinePath,
} from './confine-path';

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * The user level's home folder: a non-empty `HOME`, else a non-empty
 * `USERPROFILE`, else `os.homedir()` (BR14.3).
 * @param env - Environment variables (`ctx.env` in the CLI, `process.env` in the extension).
 * @returns Absolute home folder.
 */
export const resolveUserHome = (env: Record<string, string | undefined>): string =>
  path.resolve(nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE) ?? os.homedir());

const outsideHomeHint = (home: string): string =>
  `Use a target under ${home} or a repository target.`;

/**
 * Refuse a user-level target folder whose real path is outside the home
 * folder, before any bundle file is written (BR14.3, NFR4.16). Uses U1's
 * Layer A and Layer B checks, so a folder symlinked out of home is refused
 * and one symlinked inside home is accepted. The folder need not exist yet.
 * @param fs - Filesystem port.
 * @param home - Home folder from {@link resolveUserHome}.
 * @param folder - Absolute folder the writer will write into.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT` naming the folder and the home folder.
 */
export const assertUserFolderInsideHome = async (fs: RecordFs, home: string, folder: string): Promise<void> => {
  const relative = path.relative(path.resolve(home), path.resolve(folder));
  const outside = relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  const refuse = (cause?: unknown) => recordError('RECORD.PATH_OUTSIDE_ROOT', {
    message: 'The user target folder is outside the home folder; nothing was written.',
    detail: `the user target folder ${folder} is outside the home folder ${home}`,
    hint: outsideHomeHint(home),
    context: { folder, home },
    ...(cause === undefined ? {} : { cause })
  });
  if (outside) {
    throw refuse();
  }
  try {
    // The folder is checked as the parent of a probe leaf, so every folder on
    // the way (including the target folder itself) is realpath'd.
    await confinePath(fs, home, `${relative.split(path.sep).join('/')}/.ai-primitives-hub-probe`);
  } catch (error) {
    throw refuse(error);
  }
};
