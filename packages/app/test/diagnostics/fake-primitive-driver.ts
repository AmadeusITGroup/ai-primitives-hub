/**
 * Test doubles for `runPrimitiveDiagnostics`: a scripted
 * `PrimitiveDiagnosticsDriver` on an `InMemoryFileSystem`, a dict-backed
 * `BundleExtractor` (plus a throwing variant), governed in-memory archives
 * and a counting clock.
 *
 * The fake driver behaves like a healthy product by default: builds a
 * governed archive per bundle, `target add` writes `ws/ai-primitives-hub.yml`
 * and reports the requested scope, `install` rejects by the support matrix
 * or writes every item file at its oracle destination (plus bookkeeping
 * lockfiles), and `uninstall` removes what install placed. Tests override
 * single operations to reproduce a defect.
 * @module test/diagnostics/fake-primitive-driver
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  buildPrimitiveFixture,
  type BundleExtractor,
  type Clock,
  type DiagnosticBundle,
  type DiagnosticSandbox,
  type DiagnosticScope,
  type DriverCommandResult,
  expectedDestination,
  expectedStatus,
  type ExtractedFiles,
  type FixtureFile,
  type PreparedSandbox,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  type PrimitiveDiagnosticsDriver,
  type SnapshotRoot,
  type TargetType,
} from '@ai-primitives-hub/core';
import {
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  dump as dumpYaml,
} from 'js-yaml';
import {
  resolveUserConfigPaths,
} from '../../src';
import type {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Sandbox dirs under the home, as the CLI's `buildDiagnosticEnv` lays them out. */
const HOME_DIRS = {
  XDG_CONFIG_HOME: 'xdg',
  XDG_CACHE_HOME: 'cache',
  XDG_DATA_HOME: 'xdg-data',
  XDG_STATE_HOME: 'xdg-state',
  XDG_RUNTIME_DIR: 'xdg-runtime',
  TMPDIR: 'tmp',
  TEMP: 'tmp',
  TMP: 'tmp'
} as const;

/**
 * A driver-like sandbox env: HOME, USERPROFILE, every XDG dir and the temp dirs inside `home`.
 * @param home - Sandbox home.
 * @returns Env bag.
 */
export const sandboxEnv = (home: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(HOME_DIRS).map(([name, dir]) => [name, path.join(home, dir)])),
  HOME: home,
  USERPROFILE: home
});

/**
 * Labelled roots of a sandbox, most specific first (port order).
 * @param sandbox - Sandbox.
 * @returns Snapshot roots.
 */
export const sandboxRoots = (sandbox: DiagnosticSandbox): SnapshotRoot[] => {
  const env = sandboxEnv(sandbox.home);
  return [
    { label: '$XDG_CONFIG_HOME', path: env.XDG_CONFIG_HOME },
    { label: '$XDG_CACHE_HOME', path: env.XDG_CACHE_HOME },
    { label: '$XDG_DATA_HOME', path: env.XDG_DATA_HOME },
    { label: '$XDG_STATE_HOME', path: env.XDG_STATE_HOME },
    { label: '$XDG_RUNTIME_DIR', path: env.XDG_RUNTIME_DIR },
    { label: '$TMPDIR', path: env.TMPDIR },
    { label: '$HOME', path: sandbox.home },
    { label: '<workspace>', path: sandbox.cwd },
    { label: '<case>', path: sandbox.root }
  ];
};

/**
 * Absolute path of a sandbox label.
 * @param roots - Snapshot roots.
 * @param label - `${rootLabel}/${relative}`.
 * @returns Absolute path.
 */
export const resolveLabel = (roots: readonly SnapshotRoot[], label: string): string => {
  const [rootLabel, ...rest] = label.split('/');
  const root = roots.find((candidate) => candidate.label === rootLabel);
  if (root === undefined) {
    throw new Error(`no root for label ${label}`);
  }
  return path.join(root.path, ...rest);
};

/**
 * A governed archive for a catalogue bundle, as a healthy `bundle build` produces it
 * (port of core's `createPrimitiveReleaseArchive` test fixture).
 * @param bundle - Catalogue bundle.
 * @param fixture - Fixture repository.
 * @returns Extracted archive.
 */
export const createPrimitiveArchive = (
  bundle: DiagnosticBundle,
  fixture: ReadonlyMap<string, FixtureFile> = buildPrimitiveFixture()
): ExtractedFiles => {
  const sourceSnapshotPath = `metadata/source/${bundle.collectionFile}`;
  const bytesOf = (filePath: string): Uint8Array => fixture.get(filePath)!.bytes;
  const entries: [string, Uint8Array, 'installable' | 'metadata'][] = [
    ...bundle.items.flatMap((item) => item.files).map((filePath): [string, Uint8Array, 'installable'] => [filePath, bytesOf(filePath), 'installable']),
    ['LICENSE', bytesOf('LICENSE'), 'metadata'],
    ['README.md', bytesOf('README.md'), 'metadata'],
    [sourceSnapshotPath, bytesOf(bundle.collectionFile), 'metadata']
  ];
  const manifest = {
    formatVersion: 1,
    id: bundle.id,
    version: bundle.version,
    name: bundle.id,
    readme: 'README.md',
    items: bundle.items.map((item) => ({ id: item.expectedId, path: item.path, kind: item.kind })),
    provenance: {
      source: 'https://github.com/example/aph-e2e-fixture',
      revision: '0123456789abcdef0123456789abcdef01234567',
      collectionPath: bundle.collectionFile,
      sourceSnapshotPath,
      license: 'SEE LICENSE IN LICENSE',
      licensePath: 'LICENSE'
    },
    files: entries.map(([filePath, content, role]) => ({
      path: filePath,
      role,
      size: content.byteLength,
      sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`
    }))
  };
  return new Map([
    ['deployment-manifest.yml', encoder.encode(dumpYaml(manifest, { lineWidth: -1 }))],
    ...entries.map(([filePath, content]) => [filePath, content] as const)
  ]);
};

/**
 * A dict-backed extractor: the fake zip's bytes are the bundle id.
 * @param archives - Archive per bundle id.
 * @returns Extractor.
 */
export const createFakeExtractor = (archives: ReadonlyMap<string, ExtractedFiles>): BundleExtractor => ({
  extract: (bytes) => {
    const archive = archives.get(decoder.decode(bytes));
    return archive === undefined ? Promise.reject(new Error('not a zip')) : Promise.resolve(archive);
  }
});

/**
 * An extractor that always throws.
 * @param message - Error message.
 * @returns Extractor.
 */
export const createThrowingExtractor = (message = 'corrupt zip: bad central directory'): BundleExtractor => ({
  extract: () => Promise.reject(new Error(message))
});

/**
 * A clock that advances one millisecond per read.
 * @returns Clock.
 */
export const createCountingClock = (): Clock => {
  let now = 1000;
  return { now: () => now++, nowIso: () => new Date(now).toISOString() };
};

/** What one fake install is about. */
export interface FakeInstallCall {
  caseId: string;
  sandbox: DiagnosticSandbox;
  roots: readonly SnapshotRoot[];
  bundle: DiagnosticBundle;
  target: TargetType;
  scope: DiagnosticScope;
  from: string;
  /** Files the healthy product would place (absolute paths). */
  defaultFiles: string[];
}

/** Scripted install outcome. */
export interface FakeInstallOutcome {
  exitCode: number;
  errorCode?: string;
  /** Absolute paths to write. */
  files: string[];
}

const ok = <T>(data?: T): DriverCommandResult<T> => ({ exitCode: 0, status: 'ok', data, warnings: [], errorMessages: [] });

/** One recorded driver call. */
export interface FakeDriverCall {
  method: keyof PrimitiveDiagnosticsDriver;
  input: Record<string, unknown>;
  root?: string;
}

/**
 * Scripted fake driver. Override the `on*` hooks to reproduce defects.
 */
export class FakePrimitiveDriver implements PrimitiveDiagnosticsDriver {
  public readonly calls: FakeDriverCall[] = [];
  public readonly archives = new Map<string, ExtractedFiles>(PRIMITIVE_DIAGNOSTIC_BUNDLES.map((bundle) => [bundle.id, createPrimitiveArchive(bundle)]));
  public commitError?: Error;
  public onBuild?: (bundle: DiagnosticBundle) => DriverCommandResult<{ zipAsset: string; bundleId: string }> | undefined;

  private readonly targets = new Map<string, { type: TargetType; scope: DiagnosticScope }>();
  private readonly placed = new Map<string, string[]>();

  public constructor(private readonly fs: InMemoryFileSystem) {}

  /** Escaping sandbox: its HOME points outside its root. */
  public escapes: (sandbox: DiagnosticSandbox) => boolean = () => false;
  public onValidate: (collectionFile: string) => DriverCommandResult = () => ok();
  public onInstall: (call: FakeInstallCall) => FakeInstallOutcome = (call) => this.defaultInstall(call);
  /** Milliseconds to wait in `install` (randomises completion order). */
  public installDelay: (caseId: string) => number = () => 0;

  public prepareSandbox(sandbox: DiagnosticSandbox): Promise<PreparedSandbox> {
    this.calls.push({ method: 'prepareSandbox', input: { ...sandbox }, root: sandbox.root });
    const env = sandboxEnv(sandbox.home);
    const userDirs: Record<string, string> = { ...env, userConfigRoot: resolveUserConfigPaths(env).root };
    if (this.escapes(sandbox)) {
      userDirs.HOME = '/outside/home';
    }
    return Promise.resolve({ ...sandbox, roots: sandboxRoots(sandbox), storage: new XdgAppStorage(env).getPaths(), userDirs });
  }

  public commitFixtureRepository(sandbox: DiagnosticSandbox, input: { remoteUrl: string }): Promise<void> {
    this.calls.push({ method: 'commitFixtureRepository', input, root: sandbox.root });
    return this.commitError === undefined ? Promise.resolve() : Promise.reject(this.commitError);
  }

  public validateCollection(sandbox: DiagnosticSandbox, input: { collectionFile: string }): Promise<DriverCommandResult> {
    this.calls.push({ method: 'validateCollection', input, root: sandbox.root });
    return Promise.resolve(this.onValidate(input.collectionFile));
  }

  public async buildBundle(
    sandbox: DiagnosticSandbox,
    input: { collectionFile: string; version: string; outDir: string }
  ): Promise<DriverCommandResult<{ zipAsset: string; bundleId: string }>> {
    this.calls.push({ method: 'buildBundle', input, root: sandbox.root });
    const bundle = PRIMITIVE_DIAGNOSTIC_BUNDLES.find((candidate) => candidate.collectionFile === input.collectionFile)!;
    const scripted = this.onBuild?.(bundle);
    if (scripted !== undefined) {
      return scripted;
    }
    const zipPath = path.join(input.outDir, `${bundle.id}-${input.version}.zip`);
    await this.fs.writeFileBytes(zipPath, encoder.encode(bundle.id));
    return ok({ zipAsset: path.relative(sandbox.cwd, zipPath), bundleId: bundle.id });
  }

  public async materializeBundle(input: { zipPath: string; destination: string }): Promise<string[]> {
    this.calls.push({ method: 'materializeBundle', input });
    const archive = this.archives.get(decoder.decode(await this.fs.readFileBytes(input.zipPath)))!;
    const written: string[] = [];
    for (const [entry, bytes] of archive) {
      const target = path.join(input.destination, entry);
      await this.fs.writeFileBytes(target, bytes);
      written.push(target);
    }
    return written;
  }

  public async addTarget(
    sandbox: DiagnosticSandbox,
    input: { name: string; type: TargetType; scope: DiagnosticScope }
  ): Promise<DriverCommandResult<{ target: { scope?: string } }>> {
    this.calls.push({ method: 'addTarget', input, root: sandbox.root });
    this.targets.set(sandbox.root, { type: input.type, scope: input.scope });
    await this.fs.writeFile(path.join(sandbox.cwd, 'ai-primitives-hub.yml'), `targets:\n  - name: ${input.name}\n    type: ${input.type}\n`);
    return ok({ target: { scope: input.scope } });
  }

  public async install(sandbox: DiagnosticSandbox, input: { bundleId: string; from: string; target: string }): Promise<DriverCommandResult> {
    this.calls.push({ method: 'install', input, root: sandbox.root });
    const caseId = path.basename(sandbox.root);
    const delay = this.installDelay(caseId);
    if (delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    const { type, scope } = this.targets.get(sandbox.root)!;
    const bundle = PRIMITIVE_DIAGNOSTIC_BUNDLES.find((candidate) => candidate.id === input.bundleId)!;
    const roots = sandboxRoots(sandbox);
    const defaultFiles = bundle.items.flatMap((item) => item.files.map((file) => expectedDestination(type, scope, item, file)))
      .flatMap((destination) => (destination.kind === 'file' ? [resolveLabel(roots, destination.label)] : []));
    const outcome = this.onInstall({ caseId, sandbox, roots, bundle, target: type, scope, from: input.from, defaultFiles });
    if (outcome.exitCode !== 0) {
      return {
        exitCode: outcome.exitCode,
        status: 'error',
        warnings: [],
        errorCode: outcome.errorCode,
        errorMessages: [`install failed: ${outcome.errorCode ?? 'unknown'}`]
      };
    }
    for (const file of outcome.files) {
      await this.fs.writeFileBytes(file, encoder.encode(`placed ${file}`));
    }
    await this.fs.writeFile(path.join(sandbox.cwd, 'prompt-registry.lock.json'), '{}');
    await this.fs.writeFile(path.join(resolveUserConfigPaths(sandboxEnv(sandbox.home)).root, 'ai-primitives-hub.lock.json'), '{}');
    this.placed.set(sandbox.root, outcome.files);
    return ok();
  }

  public async uninstall(sandbox: DiagnosticSandbox, input: { target: string }): Promise<DriverCommandResult> {
    this.calls.push({ method: 'uninstall', input, root: sandbox.root });
    for (const file of this.placed.get(sandbox.root) ?? []) {
      await this.fs.remove(file);
    }
    return ok();
  }

  /**
   * Calls of one method.
   * @param method - Driver method.
   * @returns The recorded calls, in call order.
   */
  public callsOf(method: keyof PrimitiveDiagnosticsDriver): FakeDriverCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * The healthy product: reject by the support matrix, otherwise place every item file.
   * @param call - Install call.
   * @returns Outcome.
   */
  public defaultInstall(call: FakeInstallCall): FakeInstallOutcome {
    return expectedStatus(call.bundle.items.map((item) => item.kind), call.target) === 'rejected'
      ? { exitCode: 1, errorCode: 'BUNDLE.UNSUPPORTED_CONTENT', files: [] }
      : { exitCode: 0, files: call.defaultFiles };
  }
}
