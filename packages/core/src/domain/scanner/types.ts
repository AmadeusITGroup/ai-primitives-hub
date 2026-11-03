/**
 * Types of the built-in scanner: rule records, the findings they produce and the gating options a rule can use.
 * @module domain/scanner/types
 */

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type ArtifactClass =
  | 'skill'
  | 'prompt_template'
  | 'agent_config'
  | 'general_md'
  | 'claude_settings';

export interface OwaspRef {
  id: string;
  name: string;
  url: string;
}

/**
 * Rule record, for the families SEC, INJ, MD, HKS, AGT, MCP, SKL, LLM, ASI and AST.
 *
 * Gating options (all honored by the engine):
 *  - skipExample:    skip when the line is inside an example/attack/demo section
 *  - skipCode:       skip when the line is inside a fenced ``` code block
 *  - excludePattern: skip when this pattern also matches the line
 *  - contextPattern + contextRadius + requireContext: context gating within +/- radius lines
 *  - artifactClasses: only evaluate for these classified artifact kinds
 */
export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  pattern: RegExp;
  owasp?: OwaspRef;
  /** 'line' = evaluated per line (default); 'document' = evaluated once per file. */
  scope?: 'line' | 'document';
  /** 'secret' families redact the matched value and only fire the first secret per line. */
  family:
    | 'secret'
    | 'injection'
    | 'markdown'
    | 'hook'
    | 'agentic'
    | 'ast'
    | 'high_impact_line'
    | 'high_impact_document';
  skipExample?: boolean;
  skipCode?: boolean;
  excludePattern?: RegExp;
  contextPattern?: RegExp;
  contextRadius?: number;
  requireContext?: boolean;
  artifactClasses?: readonly ArtifactClass[];
  variantId?: string;
  relatedAst?: string;
}

export interface Finding {
  ruleId: string;
  variantId?: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  owasp?: OwaspRef;
  file: string;
  line: number;
  column: number;
  /** Matched text; '[REDACTED]' for secret-family / SEC-* findings. */
  match: string;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1
};
