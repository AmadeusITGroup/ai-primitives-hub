/**
 * Installs this repository's own packages into a throwaway project, so a
 * test exercises the workspace build instead of whatever npm currently
 * serves.
 *
 * Motivation: the scaffold template depends on `@ai-primitives-hub/cli`
 * from the registry. A test that simply ran `npm install` therefore
 * verified a *published* artifact - changes under `packages/cli/src` were
 * not covered at all, and a newer published CLI calling an export that
 * `@prompt-registry/collection-scripts@1.0.5` never shipped turned the
 * suite red on unrelated pull requests.
 *
 * Only the throwaway copy is rewritten. `package.template.json` keeps its
 * registry dependency, so a real user's scaffold is unaffected and never
 * sees a `file:` reference.
 * @module helpers/workspace-pack-helpers
 */
import {
  execSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Repository root, two levels above `apps/vscode-extension`. */
const repoRoot = path.resolve(process.cwd(), '../..');

const PACK_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Workspace packages a scaffolded project resolves, in dependency order.
 *
 * `cli` is the only direct dependency; the rest arrive transitively
 * (`cli` -> `app`, `core`, `infra`, `collection-scripts`; `app` -> `core`,
 * `infra`; `infra` -> `core`). Every one must be supplied locally, because
 * `pnpm pack` rewrites `workspace:*` into a concrete version that would
 * otherwise resolve from the registry.
 *
 * Keep this in step with those dependencies: a workspace dependency
 * missing here is silently fetched from npm, which is the exact failure
 * mode this module exists to prevent.
 */
export const WORKSPACE_PACKAGES = [
  { dir: 'packages/core', name: '@ai-primitives-hub/core' },
  { dir: 'packages/infra', name: '@ai-primitives-hub/infra' },
  { dir: 'packages/app', name: '@ai-primitives-hub/app' },
  { dir: 'lib', name: '@prompt-registry/collection-scripts' },
  { dir: 'packages/cli', name: '@ai-primitives-hub/cli' }
] as const;

/**
 * Pack every workspace package into `destination`.
 *
 * Uses `pnpm pack`, not `npm pack`: only pnpm replaces the `workspace:`
 * protocol with a real version, and a tarball still carrying
 * `workspace:*` cannot be installed at all.
 * @param destination - Directory to write tarballs into.
 * @returns Absolute tarball path per package name.
 * @throws {Error} If a package has no `dist/`, or pnpm fails (an
 * incompatible Node version being the usual cause).
 */
export function packWorkspacePackages(destination: string): Map<string, string> {
  fs.mkdirSync(destination, { recursive: true });
  const tarballs = new Map<string, string>();

  for (const { dir, name } of WORKSPACE_PACKAGES) {
    const packageDir = path.join(repoRoot, dir);
    const { version } = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
    ) as { version: string };

    // `pnpm pack` ships `dist/`, so the workspace must already be built.
    // Fail here rather than leaving a confusing install error later.
    if (!fs.existsSync(path.join(packageDir, 'dist'))) {
      throw new Error(`${name} has no dist/ - run \`pnpm build\` first (looked in ${packageDir})`);
    }

    try {
      execSync(`pnpm pack --pack-destination "${destination}"`, {
        cwd: packageDir,
        stdio: 'pipe',
        timeout: PACK_TIMEOUT_MS
      });
    } catch (error) {
      // `execSync`'s message omits the child's output, and pnpm reports an
      // engine mismatch on stdout rather than stderr - so read both.
      const { stdout, stderr } = error as { stdout?: Buffer | string; stderr?: Buffer | string };
      const detail = [stdout, stderr]
        .map((stream) => (stream === undefined ? '' : String(stream).trim()))
        .filter((text) => text.length > 0)
        .join(' | ');
      throw new Error(`pnpm pack failed for ${name}${detail.length > 0 ? `: ${detail}` : ''}`);
    }

    // pnpm names tarballs `<name-without-scope-slash>-<version>.tgz`.
    const tarball = path.join(destination, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    if (!fs.existsSync(tarball)) {
      throw new Error(`Expected tarball ${tarball} after packing ${name}`);
    }
    tarballs.set(name, tarball);
  }

  return tarballs;
}

/**
 * Repoint a project's `package.json` at locally packed builds.
 *
 * `overrides` is what does the real work: without it the packed CLI would
 * still resolve its own dependencies from the registry.
 * @param projectDir - Project to rewrite (a temp directory).
 * @param tarballs - Tarball paths from {@link packWorkspacePackages}.
 */
export function useLocalWorkspaceBuilds(projectDir: string, tarballs: Map<string, string>): void {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  const fileRef = (name: string): string => {
    const tarball = tarballs.get(name);
    if (tarball === undefined) {
      throw new Error(`No tarball packed for ${name}`);
    }
    return `file:${tarball}`;
  };

  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    '@ai-primitives-hub/cli': fileRef('@ai-primitives-hub/cli')
  };
  packageJson.overrides = {
    ...packageJson.overrides,
    ...Object.fromEntries([...tarballs.keys()].map((name) => [name, fileRef(name)]))
  };

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

export interface InstallWorkspaceBuildsOptions {
  /** Scaffolded project to install into. */
  projectDir: string;
  /** Where tarballs are written. Siblings the project so teardown finds it. */
  tarballDir: string;
  /** Install budget. Defaults to 120s - a local install of five tarballs. */
  installTimeoutMs?: number;
}

/**
 * Pack the workspace, repoint the project at it, and `npm install`.
 *
 * The single entry point a test needs; it throws with an actionable
 * message on any step so the caller can decide whether to fail or skip.
 * @param options - See {@link InstallWorkspaceBuildsOptions}.
 */
export function installWorkspaceBuilds(options: InstallWorkspaceBuildsOptions): void {
  const tarballs = packWorkspacePackages(options.tarballDir);
  useLocalWorkspaceBuilds(options.projectDir, tarballs);

  execSync('npm install --prefer-offline', {
    cwd: options.projectDir,
    stdio: 'pipe',
    timeout: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  });
}
