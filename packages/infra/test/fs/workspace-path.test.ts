import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveWorkspacePath,
} from '../../src/fs/workspace-path';

describe('resolveWorkspacePath', () => {
  let directory: string;
  let workspace: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-path-'));
    workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['../outside', '/absolute', 'C:\\outside', 'C:outside', 'file:stream', '.', 'a\0b'])(
    'rejects unsafe path %s',
    (relative) => {
      expect(() => resolveWorkspacePath(workspace, relative)).toThrow();
    }
  );

  it('resolves missing descendants below the canonical workspace root', () => {
    expect(resolveWorkspacePath(workspace, 'docs/new/README.md')).toBe(
      path.join(fs.realpathSync.native(workspace), 'docs', 'new', 'README.md')
    );
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('rejects directory links to sibling paths sharing the workspace prefix', () => {
    const outside = `${workspace}-outside`;
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveWorkspacePath(workspace, 'linked/new/file.md')).toThrow(/outside the workspace/);
  });

  it('allows directory links contained inside the workspace and OS aliases of the root', () => {
    const target = path.join(workspace, 'docs');
    fs.mkdirSync(target);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(target, path.join(workspace, 'linked'), linkType);
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(workspace, alias, linkType);
    expect(resolveWorkspacePath(alias, 'linked/new.md')).toBe(
      path.join(fs.realpathSync.native(target), 'new.md')
    );
  });

  it.skipIf(process.platform === 'win32')('rejects dangling directory links instead of treating them as missing', () => {
    fs.symlinkSync(path.join(directory, 'absent'), path.join(workspace, 'linked'));
    expect(() => resolveWorkspacePath(workspace, 'linked/new/file.md')).toThrow(/unresolved symlink/);
  });
});
