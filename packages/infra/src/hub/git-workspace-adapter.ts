/**
 * `GitWorkspacePort` implementation backed by `ProcessExecutor` (`git` CLI).
 *
 * Uses argv-safe `execFile('git', [...])` so repository URLs, branch names,
 * and commit messages are never interpreted by a shell.
 * @module hub/git-workspace-adapter
 */
import {
  type GitWorkspacePort,
  type GitWorkspaceStatus,
  parseGitHubOwnerRepo,
  type ProcessExecutor,
  type TokenProvider,
} from '@ai-primitives-hub/core';

/**
 * Extract `<owner>/<repo>` from a GitHub HTTPS or SSH remote URL using the
 * shared domain parser.
 * @param remoteUrl Git remote URL.
 * @returns Normalized `owner/repo` slug, or `undefined` if not a GitHub remote.
 */
export function extractGitHubSlugFromRemoteUrl(remoteUrl: string): string | undefined {
  const parsed = parseGitHubOwnerRepo(remoteUrl);
  if (!parsed || parsed.host !== 'github.com') {
    return undefined;
  }
  return `${parsed.owner}/${parsed.repo}`;
}

export class GitWorkspaceAdapter implements GitWorkspacePort {
  public constructor(
    private readonly executor: ProcessExecutor,
    private readonly tokenProvider?: TokenProvider
  ) {}

  /**
   * Build ephemeral `-c http.https://<host>/.extraheader=...` arguments when a
   * `TokenProvider` is configured (e.g. VS Code's native GitHub session), so
   * HTTPS Git operations authenticate without requiring `gh` CLI or persisting
   * credentials in `.git/config`.
   * @param host Target Git host.
   */
  private async buildGitAuthArgs(host = 'github.com'): Promise<string[]> {
    if (!this.tokenProvider) {
      return [];
    }
    const token = await this.tokenProvider.getToken(host);
    if (!token) {
      return [];
    }
    const basicAuth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }

  public async isGitRepository(dir: string): Promise<boolean> {
    try {
      const res = await this.executor.execFile('git', ['rev-parse', '--show-cdup'], { cwd: dir });
      return res.stdout.trim().length === 0;
    } catch {
      return false;
    }
  }

  public async cloneRepository(cloneUrl: string, targetDir: string): Promise<void> {
    const authArgs = cloneUrl.startsWith('https://') ? await this.buildGitAuthArgs() : [];
    await this.executor.execFile('git', [...authArgs, 'clone', '--', cloneUrl, targetDir]);
  }

  public async getRemotes(dir: string): Promise<Record<string, string>> {
    try {
      const res = await this.executor.execFile('git', ['remote', '-v'], { cwd: dir });
      const remotes: Record<string, string> = {};
      for (const line of res.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
        if (match) {
          remotes[match[1]] = match[2];
        }
      }
      return remotes;
    } catch {
      return {};
    }
  }

  public async ensureRemote(dir: string, name: string, url: string): Promise<void> {
    const remotes = await this.getRemotes(dir);
    if (remotes[name] === undefined) {
      await this.executor.execFile('git', ['remote', 'add', name, url], { cwd: dir });
    } else if (remotes[name] !== url) {
      await this.executor.execFile('git', ['remote', 'set-url', name, url], { cwd: dir });
    }
  }

  public async getCurrentBranch(dir: string): Promise<string> {
    const res = await this.executor.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    return res.stdout.trim();
  }

  public async fetchRemote(dir: string, remote: string, branch?: string): Promise<void> {
    const authArgs = await this.buildGitAuthArgs();
    const args = branch ? [...authArgs, 'fetch', remote, branch] : [...authArgs, 'fetch', remote];
    await this.executor.execFile('git', args, { cwd: dir });
  }

  public async checkoutBranch(
    dir: string,
    branch: string,
    options?: { create?: boolean; startPoint?: string }
  ): Promise<void> {
    if (options?.create) {
      let branchExists = false;
      try {
        await this.executor.execFile('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir });
        branchExists = true;
      } catch {
        branchExists = false;
      }
      if (branchExists) {
        await this.executor.execFile('git', ['checkout', branch], { cwd: dir });
        return;
      }
      const args = options.startPoint
        ? ['checkout', '-b', branch, options.startPoint]
        : ['checkout', '-b', branch];
      await this.executor.execFile('git', args, { cwd: dir });
      return;
    }
    await this.executor.execFile('git', ['checkout', branch], { cwd: dir });
  }

  public async getStatus(dir: string): Promise<GitWorkspaceStatus> {
    const isGitRepo = await this.isGitRepository(dir);
    if (!isGitRepo) {
      return {
        isGitRepo: false,
        remotes: {},
        modifiedFiles: [],
        hasUncommittedChanges: false
      };
    }

    const [remotes, currentBranch, porcelain] = await Promise.all([
      this.getRemotes(dir),
      this.getCurrentBranch(dir).catch(() => undefined),
      this.executor.execFile('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: dir })
    ]);

    const modifiedFiles: string[] = [];
    if (porcelain.stdout.includes('\0')) {
      const fields = porcelain.stdout.split('\0');
      for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (entry.length < 4) {
          continue;
        }
        const xy = entry.slice(0, 2);
        modifiedFiles.push(entry.slice(3));
        if (xy.includes('R') || xy.includes('C')) {
          i++; // skip the original path of a rename or copy
        }
      }
    } else {
      for (const rawLine of porcelain.stdout.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.length < 4) {
          continue;
        }
        const withoutStatus = line.slice(3);
        const renameParts = withoutStatus.split(' -> ');
        const target = renameParts.at(-1) ?? withoutStatus;
        modifiedFiles.push(target.replace(/^"(.*)"$/, '$1'));
      }
    }

    return {
      isGitRepo: true,
      currentBranch,
      remotes,
      modifiedFiles,
      hasUncommittedChanges: modifiedFiles.length > 0
    };
  }

  public async getFileAtRef(dir: string, ref: string, relativeFilePath: string): Promise<string | undefined> {
    try {
      const res = await this.executor.execFile('git', ['show', `${ref}:${relativeFilePath}`], { cwd: dir });
      return res.stdout;
    } catch {
      return undefined;
    }
  }

  public async commitAndPush(
    dir: string,
    files: string[],
    message: string,
    remote: string,
    branch: string
  ): Promise<{ commitSha: string }> {
    if (files.length > 0) {
      await this.executor.execFile('git', ['add', '--', ...files], { cwd: dir });
      await this.executor.execFile('git', ['commit', '-m', message, '--', ...files], { cwd: dir });
    }
    const shaRes = await this.executor.execFile('git', ['rev-parse', 'HEAD'], { cwd: dir });
    const authArgs = await this.buildGitAuthArgs();
    await this.executor.execFile('git', [...authArgs, 'push', '-u', remote, branch], { cwd: dir });
    return { commitSha: shaRes.stdout.trim() };
  }
}
