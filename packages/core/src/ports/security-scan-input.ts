/** Port for collecting bounded security-scan inputs and ignore declarations. */
import type {
  SecurityDocument,
  SuppressionDeclaration,
  SuppressionWarning,
} from '../domain/security';
import type {
  SecurityCancellation,
} from './security-scan-engine';

export interface SecurityResourceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxFindings: number;
  maxIgnoreBytes: number;
  maxIgnoreLines: number;
  maxReportBytes: number;
  timeoutMs: number;
  documentTimeoutMs: number;
}

export interface SecurityInputCandidate {
  id: string;
  rootId: string;
  absolutePath: string;
  displayPath: string;
  depth: number;
}

export interface SecurityInputCollection {
  candidates: readonly SecurityInputCandidate[];
  ignoredFiles: readonly { path: string; reason: string; source?: string }[];
  skippedFiles: readonly { path: string; reason: string }[];
  errors: readonly { path?: string; code: string; message: string }[];
  suppressions: readonly SuppressionDeclaration[];
  warnings: readonly SuppressionWarning[];
}

export interface SecurityInputRequest {
  roots: readonly string[];
  extensions: readonly string[];
  recursive: boolean;
  excludes: readonly string[];
  includeDocFiles: boolean;
  ignoreTrust: 'repository' | 'none' | 'baseline';
  baselineSuppressionPath?: string;
  baselineFileIgnorePath?: string;
}

export interface SecurityInputReadResult {
  document?: SecurityDocument;
  error?: { code: string; message: string };
}

export interface SecurityScanInput {
  collect(
    request: SecurityInputRequest,
    limits: SecurityResourceLimits,
    cancellation: SecurityCancellation
  ): Promise<SecurityInputCollection>;
  read(
    candidate: SecurityInputCandidate,
    limits: SecurityResourceLimits,
    cancellation: SecurityCancellation
  ): Promise<SecurityInputReadResult>;
}
