/**
 * Target-management domain types. Pure shapes; no IO.
 * @module domain/runtime-target/types
 */
import type {
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import type {
  ValidatedManifest,
} from '../collection/manifest-validator';
import type {
  TargetType,
} from '../install/target';
import type {
  RepositoryCommitMode,
} from '../install/types';

/** Scopes target management accepts. `workspace` scope is deliberately rejected. */
export type RuntimeTargetScope = 'user' | 'repository';

export interface RuntimeTargetSelectionInput {
  type: TargetType;
  /** Invocation-local only: resolves the instance for this call, never persisted. */
  scope?: RuntimeTargetScope;
  /** Absolute base-directory override (user scope) or workspace-root override (repository scope). */
  path?: string;
  /** Select into the user-default slot instead of the workspace slot. */
  userDefault?: boolean;
}

/**
 * Persisted selection — harness type only. Scope is chosen at install time and
 * lives in the installation record, never in the persisted selection.
 */
export interface RuntimeSelection {
  type: TargetType;
}

/** Concrete, canonicalized target identity. Display name and host excluded. */
export interface RuntimeTargetInstance {
  type: TargetType;
  scope: RuntimeTargetScope;
  /** Canonical absolute base directory after layout + override resolution. */
  root: string;
}

export interface RuntimeActiveTarget {
  instance: RuntimeTargetInstance;
  /** Which selection slot produced this active target. */
  selection: 'workspace' | 'user-default';
}

export interface RuntimeTargetCatalogEntry {
  type: TargetType;
  scopes: RuntimeTargetScope[];
  /** Unexpanded baseDir templates per scope. */
  baseDirs: Record<string, string>;
  /** Capability families refused by target management (rejected before any write). */
  unsupported: string[];
}

export interface RuntimeCollectionId {
  sourceId: string;
  manifestId: string;
}

export interface RuntimeInstalledCollection extends RuntimeCollectionId {
  version: string;
  payloadId: string;
  installedAt: string;
  outputCount: number;
}

export interface RuntimeAvailableCollection extends RuntimeCollectionId {
  version: string;
  payloadId: string;
  provenance: string;
  /** Instance keys this collection is currently projected onto. */
  installedOn: string[];
  /** Whether an active-instance receipt references this snapshot. */
  current: boolean;
}

export interface RuntimeVerification {
  collection: RuntimeCollectionId;
  path: string;
  status: 'healthy' | 'missing' | 'modified';
}

/** Explicit canonical content import; never projects or mutates legacy files. */
export interface RuntimeImportedCollection {
  files: ExtractedFiles;
  sourceId: string;
  expectedVersion?: string;
  /** e.g. 'legacy-install' or 'directory'. */
  provenance: string;
  /** Identity of the legacy record this snapshot was taken from. */
  legacyRef?: string;
}

/** Where a collection was acquired from; recorded so its payload can be re-acquired. */
export interface RuntimeSourceInfo {
  type: string;
  /** Empty when the origin cannot be re-acquired. */
  url: string;
}

export interface RuntimePayloadInput {
  files: ExtractedFiles;
  manifest: ValidatedManifest;
  sourceId: string;
  registryRef?: RuntimeRegistryReference;
  source?: RuntimeSourceInfo;
}

export interface RuntimeRegistryReference {
  bundleId: string;
  sourceType: string;
}

export type RuntimeOperation =
  | { kind: 'install'; payload: RuntimePayloadInput }
  | { kind: 'update'; payload: RuntimePayloadInput; installationId?: string }
  | { kind: 'project'; sourceTargetId?: string }
  | { kind: 'uninstall'; sourceId: string; manifestId: string; installationId?: string };

/** Exact authoritative installation row spanning scopes (receiptId = installationId). */
export interface RuntimeInstallation {
  installationId: string;
  sourceId: string;
  manifestId: string;
  instance: RuntimeTargetInstance;
  version: string;
  installedAt: string;
  payloadId: string;
  /** Snapshot manifest, or a minimal `{id, version, name}` view when the payload is unavailable. */
  manifest: ValidatedManifest;
  /** False when the payload snapshot is missing and must be re-acquired from `source`. */
  payloadAvailable: boolean;
  source?: RuntimeSourceInfo;
  contextRoot?: string;
  commitMode?: RepositoryCommitMode;
  registryRef?: RuntimeRegistryReference;
}

export interface RuntimePlanWrite {
  /** Absolute canonical destination path. */
  path: string;
  /** Expected installed bytes (post-transform) digest. */
  sha256: string;
  mode?: number;
  /** Source bundle-relative path that produced this write. */
  bundlePath: string;
}

export interface RuntimePlanRemoval {
  path: string;
  /** Expected current digest; removal is skipped/fails if it drifted. */
  sha256: string;
}

export interface RuntimePlanConflict {
  path?: string;
  code: string;
  message: string;
}

export interface RuntimeProjectionPlan {
  /** Stable fingerprint covering op, target, state revision, layouts and observed bytes. */
  hash: string;
  operation: string;
  instance: RuntimeTargetInstance;
  contextRoot?: string;
  commitMode?: RepositoryCommitMode;
  collections: { sourceId: string; manifestId: string; version: string }[];
  writes: RuntimePlanWrite[];
  removals: RuntimePlanRemoval[];
  /** Paths deliberately left in place (shared owners, locally modified). */
  preserved: string[];
  conflicts: RuntimePlanConflict[];
  canApply: boolean;
  stateRevision: number;
}

export interface RuntimeApplyResult {
  applied: boolean;
  instance: RuntimeTargetInstance;
  written: string[];
  removed: string[];
  /** Locally modified outputs kept while ownership was removed. */
  preservedModified: string[];
  receipts: string[];
}

/** Persisted selection slot map key = canonical workspace root. */
export interface RuntimeSelections {
  workspaces: Record<string, RuntimeSelection>;
  userDefault?: RuntimeSelection;
}

export interface RuntimePayloadSnapshot {
  payloadId: string;
  sourceId: string;
  manifestId: string;
  version: string;
  manifest: ValidatedManifest;
  files: ReadonlyMap<string, Uint8Array>;
  createdAt: string;
}

export interface RuntimeImportRef {
  importId: string;
  payloadId: string;
  sourceId: string;
  manifestId: string;
  provenance: string;
  legacyRef?: string;
  importedAt: string;
}

export interface RuntimeReceiptOutput {
  sha256: string;
  mode?: number;
  sourcePath?: string;
}

export interface RuntimeProjectionReceipt {
  receiptId: string;
  instance: RuntimeTargetInstance;
  collection: RuntimeCollectionId;
  payloadId: string;
  version: string;
  /** Absolute output path -> expected installed bytes/mode. */
  outputs: Record<string, RuntimeReceiptOutput>;
  installedAt: string;
  /** Canonical opened context root recorded at install (repo-scope provenance). */
  contextRoot?: string;
  /** Explicit commit mode recorded at install, when applicable. */
  commitMode?: RepositoryCommitMode;
  /** Marketplace acquisition reference; not part of content identity. */
  registryRef?: RuntimeRegistryReference;
  /** Acquisition origin recorded in the lockfile `sources` section. */
  source?: RuntimeSourceInfo;
}

export interface RuntimeTargetState {
  schemaVersion: 1;
  revision: number;
  selections: RuntimeSelections;
  payloads: Record<string, RuntimePayloadSnapshot>;
  imports: Record<string, RuntimeImportRef>;
  receipts: Record<string, RuntimeProjectionReceipt>;
  /** Trusted user-store index; repository documents cannot extend it on load. */
  repositories?: string[];
}
