/** Port for a replaceable static security scan engine. */
import type {
  SecurityDocument,
  SecurityFinding,
  SecuritySeverity,
} from '../domain/security';

export interface SecurityCancellation {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

export interface SecurityEngineDescriptor {
  id: string;
  version: string;
  rulePackId: string;
  rulePackVersion: string;
  rulePackDigest: string;
}

export interface SecurityEngineCapabilities {
  readonly contentTypes: readonly string[];
  readonly locations: 'line' | 'range';
  readonly supportsFileMode: boolean;
  readonly supportsCancellation: boolean;
}

export interface SecurityEngineOptions {
  includeLlmControls: boolean;
  skipInfoControls: boolean;
  maxFindings: number;
}

export interface SecurityScanEngine {
  readonly descriptor: SecurityEngineDescriptor;
  readonly capabilities: SecurityEngineCapabilities;
  scanDocument(
    document: SecurityDocument,
    options: SecurityEngineOptions,
    cancellation: SecurityCancellation
  ): Promise<readonly SecurityFinding[]>;
}

export const isSecuritySeverity = (value: unknown): value is SecuritySeverity =>
  value === 'CRITICAL' || value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' || value === 'INFO';
