/**
 * Domain types for static security analysis of AI primitive artifacts.
 * @module domain/security/types
 */

export const SECURITY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type SecuritySeverity = typeof SECURITY_SEVERITIES[number];

export const SECURITY_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type SecurityConfidence = typeof SECURITY_CONFIDENCES[number];

export type SecurityArtifactClass = 'skill' | 'prompt_template' | 'agent_config' | 'general_md' | 'claude_settings';

export interface ParsedSecurityLine {
  text: string;
  section: string;
  inExample: boolean;
  inCodeBlock: boolean;
}

export interface ParsedSecurityDocument {
  content: string;
  frontmatter: string;
  bodyStart: number;
  lines: ParsedSecurityLine[];
  artifactClass: SecurityArtifactClass;
}

export interface SecurityDocument {
  id: string;
  rootId: string;
  displayPath: string;
  content: string;
  metadata: {
    bytes: number;
    modifiedAtMs?: number;
    posixMode?: number;
    source: 'filesystem' | 'editor';
    documentVersion?: number;
  };
}

export interface SecurityFinding {
  ruleId: string;
  variantId?: string;
  title: string;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  category: string;
  file: string;
  line?: number;
  section?: string;
  vulnerableContent: string;
  risk: string;
  recommendedFix: string;
  owasp?: { id: string; name: string; url: string };
  fingerprint: string;
  canonicalFingerprint: string;
  isInfoControl?: boolean;
}

export interface SuppressionDeclaration {
  token: string;
  sourcePath: string;
  scopeRoot?: string;
  line: number;
  comment?: string;
}

export interface SuppressionWarning {
  code: 'SECURITY.INVALID_SUPPRESSION';
  sourcePath: string;
  line: number;
  message: string;
}

export interface SuppressionParseResult {
  declarations: SuppressionDeclaration[];
  warnings: SuppressionWarning[];
}

export interface SuppressedFinding {
  finding: SecurityFinding;
  declaration: SuppressionDeclaration;
  kind: 'instance' | 'canonical';
}

export interface SuppressionResult {
  active: SecurityFinding[];
  suppressed: SuppressedFinding[];
}

export type FailurePolicy = 'none' | 'any' | SecuritySeverity;

export interface FailurePolicyResult {
  passed: boolean;
  blocking: SecuritySeverity[];
}
