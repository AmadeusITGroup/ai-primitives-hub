/**
 * PrimitiveDiagnosticsDriver port — the semantic operations
 * `doctor diagnostics --primitives` runs against a sandbox: prepare it,
 * commit the fixture repository, validate and build a collection,
 * materialise a bundle archive, add a target, install and uninstall.
 *
 * Semantic, not argv: the CLI adapter maps each call onto the real command
 * classes, so a later app-native driver can replace it without changes to
 * the suite. Interfaces only.
 * @module ports/primitive-diagnostics-driver
 */
import type {
  DiagnosticScope,
} from '../domain/diagnostics/primitives/types';
import type {
  TargetType,
} from '../domain/install/target';
import type {
  AppStoragePaths,
} from './app-storage';

/** Directories of one sandbox (the fixture sandbox or a case). */
export interface DiagnosticSandbox {
  /** Case root; every path below lives inside it. */
  root: string;
  /** Command cwd (project root; `target add` writes ./ai-primitives-hub.yml here). */
  cwd: string;
  /** Isolated home. The driver derives HOME/USERPROFILE, every XDG_* and TMPDIR/TEMP/TMP from it. */
  home: string;
}

/** A labelled snapshot root. */
export interface SnapshotRoot {
  label: string;
  path: string;
}

/** A sandbox whose directories exist, with the roots and paths the commands will use. */
export interface PreparedSandbox extends DiagnosticSandbox {
  /** Most specific first: $XDG_*, $TMPDIR, $HOME, <workspace>, <case>. */
  roots: readonly SnapshotRoot[];
  /** Resolved through the AppStorage port for this sandbox's env (ADR-0005). */
  storage: AppStoragePaths;
  /** Per-user directories the env points at, by variable name (paths only). */
  userDirs: Readonly<Record<string, string>>;
}

/** What one dispatched command reported. */
export interface DriverCommandResult<T = unknown> {
  exitCode: number;
  status?: 'ok' | 'warning' | 'error';
  data?: T;
  warnings: string[];
  /** errors[0].code of the envelope, when present. */
  errorCode?: string;
  /** Every failure reason the command reported. Empty on success. */
  errorMessages: string[];
  /** Archive-relative paths an install rejected as unsupported content, when the command listed them. */
  rejectedPaths?: string[];
  /** Content a `--skip-unsupported` install left out, one entry per archive file, when the command listed it. */
  skipped?: SkippedContent[];
}

/** One file a `--skip-unsupported` install left out. */
export interface SkippedContent {
  /** Archive-relative path. */
  path: string;
  /** Machine-readable reason code, e.g. `BUNDLE.UNSUPPORTED_CONTENT`. */
  code: string;
  /** Human-readable reason. */
  reason: string;
}

/** Operations the primitive diagnostics use case drives. */
export interface PrimitiveDiagnosticsDriver {
  prepareSandbox(sandbox: DiagnosticSandbox): Promise<PreparedSandbox>;
  /**
   * Commit the fixture files written under `sandbox.cwd`.
   * `executableFiles`: repository-relative paths recorded as executable (`100755`); every other file is `100644`.
   */
  commitFixtureRepository(sandbox: DiagnosticSandbox, input: { remoteUrl: string; executableFiles: readonly string[] }): Promise<void>;
  validateCollection(sandbox: DiagnosticSandbox, input: { collectionFile: string }): Promise<DriverCommandResult>;
  buildBundle(sandbox: DiagnosticSandbox, input: { collectionFile: string; version: string; outDir: string }): Promise<DriverCommandResult<{ zipAsset: string; bundleId: string }>>;
  materializeBundle(input: { zipPath: string; destination: string }): Promise<string[]>;
  addTarget(sandbox: DiagnosticSandbox, input: { name: string; type: TargetType; scope: DiagnosticScope }): Promise<DriverCommandResult<{ target: { scope?: string } }>>;
  /**
   * bundleId is the catalogue (collection) id. `skipUnsupported` runs the
   * opt-in partial install (`install --skip-unsupported`); absent or false
   * runs the default all-or-nothing install. `data.lockfile` is the
   * absolute path of the lockfile the install updated, when it reports one.
   */
  install(
    sandbox: DiagnosticSandbox,
    input: { bundleId: string; from: string; target: string; skipUnsupported?: boolean }
  ): Promise<DriverCommandResult<{ lockfile?: string }>>;
  uninstall(sandbox: DiagnosticSandbox, input: { target: string }): Promise<DriverCommandResult>;
}
