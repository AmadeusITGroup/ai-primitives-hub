/**
 * TargetWriter port — executes exact operations produced by the app planner.
 * Concrete adapters live in `infra`/`app`.
 * @module ports/target-writer
 */
import type {
  Target,
} from '../domain/install/target';
import type {
  PrimitiveKind,
} from '../domain/primitive/types';

export interface TargetWriteOperation {
  itemId: string;
  kind: PrimitiveKind;
  sourcePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  bytes: Uint8Array;
  sourceChecksum: string;
}

export interface TargetWritePlan {
  target: Target;
  operations: readonly TargetWriteOperation[];
}

export interface InstalledFileRecord {
  itemId: string;
  kind: PrimitiveKind;
  sourcePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  installedChecksum: string;
}

export interface TargetWriteResult {
  installed: readonly InstalledFileRecord[];
}

export interface TargetWriter {
  preflight?(plan: TargetWritePlan): Promise<void>;
  write(plan: TargetWritePlan): Promise<TargetWriteResult>;
  rollback?(installed: readonly InstalledFileRecord[]): Promise<void>;
  remove(files: readonly InstalledFileRecord[]): Promise<void>;
}
