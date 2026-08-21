/** Pack local workspace artifacts into a temporary scaffold for E2E tests. */
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PACK_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

function findWorkspaceRoot(startDir: string): string {
  let directory = startDir;

  while (true) {
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      return directory;
    }

    const parentDirectory = path.dirname(directory);
    if (parentDirectory === directory) {
      throw new Error(`Could not find pnpm-workspace.yaml above ${startDir}`);
    }
    directory = parentDirectory;
  }
}

const workspaceRoot = findWorkspaceRoot(__dirname);

type CommandError = Error & {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
};

function runCommand(command: string, args: string[], cwd: string, timeout: number): void {
  try {
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout
    });
  } catch (error) {
    const { message, stdout, stderr } = error as CommandError;
    const detail = [message, stdout, stderr]
      .filter((value): value is Buffer | string => value !== undefined && String(value).trim().length > 0)
      .map((value) => String(value).trim())
      .join('\n');
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}${detail.length > 0 ? `:\n${detail}` : ''}`);
  }
}

/** Workspace packages required by the scaffolded CLI and its dependencies. */
export const WORKSPACE_PACKAGES = [
  { dir: 'packages/core', name: '@ai-primitives-hub/core' },
  { dir: 'packages/infra', name: '@ai-primitives-hub/infra' },
  { dir: 'packages/app', name: '@ai-primitives-hub/app' },
  { dir: 'lib', name: '@prompt-registry/collection-scripts' },
  { dir: 'packages/cli', name: '@ai-primitives-hub/cli' }
] as const;

/** Pack the configured workspace packages and return their tarball paths. */
export function packWorkspacePackages(destination: string): Map<string, string> {
  fs.mkdirSync(destination, { recursive: true });
  const tarballs = new Map<string, string>();

  for (const { dir, name } of WORKSPACE_PACKAGES) {
    const packageDir = path.join(workspaceRoot, dir);
    if (!fs.existsSync(path.join(packageDir, 'dist'))) {
      throw new Error(`${name} has no dist/; run \`pnpm build\` first (looked in ${packageDir})`);
    }

    const existingFiles = new Set(fs.readdirSync(destination));
    runCommand('pnpm', ['pack', '--pack-destination', destination], packageDir, PACK_TIMEOUT_MS);

    const newTarballs = fs.readdirSync(destination)
      .filter((file) => file.endsWith('.tgz') && !existingFiles.has(file));
    if (newTarballs.length !== 1) {
      throw new Error(`Expected one tarball after packing ${name}, found ${String(newTarballs.length)}`);
    }
    tarballs.set(name, path.join(destination, newTarballs[0]));
  }

  return tarballs;
}

/** Rewrite a temporary project's manifest to use the packed workspace artifacts. */
export function useLocalWorkspaceBuilds(projectDir: string, tarballs: Map<string, string>): void {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  const fileReference = (name: string): string => {
    const tarball = tarballs.get(name);
    if (tarball === undefined) {
      throw new Error(`No tarball packed for ${name}`);
    }
    return `file:${tarball}`;
  };

  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    '@ai-primitives-hub/cli': fileReference('@ai-primitives-hub/cli')
  };
  packageJson.overrides = {
    ...packageJson.overrides,
    ...Object.fromEntries([...tarballs.keys()].map((name) => [name, fileReference(name)]))
  };

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

export interface InstallWorkspaceBuildsOptions {
  /** Scaffolded project to install into. */
  projectDir: string;
  /** Install timeout in milliseconds. Defaults to 120 seconds. */
  installTimeoutMs?: number;
}

/** Pack, install, and remove local workspace artifacts for a temporary project. */
export function installWorkspaceBuilds(options: InstallWorkspaceBuildsOptions): void {
  const tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-primitives-hub-packs-'));

  try {
    const tarballs = packWorkspacePackages(tarballDir);
    useLocalWorkspaceBuilds(options.projectDir, tarballs);
    runCommand(
      'npm',
      ['install', '--prefer-offline', '--package-lock=false'],
      options.projectDir,
      options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
    );
  } finally {
    fs.rmSync(tarballDir, { recursive: true, force: true });
  }
}
