/**
 * Deterministic scan engine: no model, no network, no file access. Per line and rule it applies, in order,
 * the artifact-class gate, the example and code gates, the pattern, the exclude pattern and the context window.
 *
 * Not executed: the absence-based control rules (CTL-*), structured settings.json scanning and the
 * skill-frontmatter heuristics. Secret findings are redacted and only the first secret per line is reported.
 * @module domain/scanner/engine
 */

import {
  type ParsedDocument,
  parseSecurityDocument,
} from './markdown-context';
import {
  ASSIGNMENT,
  AST_RULES,
  BOUNDARY,
  DOCUMENTATION_ONLY,
  EXECUTED_LINE_RULES,
  HIGH_IMPACT_DOCUMENT_RULES,
  HIGH_IMPACT_LINE_RULES,
  INVISIBLE_CHARS,
  LLM01,
  LLM06,
  PLACEHOLDER,
  SAFE_SECRET_PLACEHOLDER,
} from './rules';
import type {
  Finding,
  Rule,
  Severity,
} from './types';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx', '.mdc']);

export const isMarkdownFile = (filePath: string): boolean => {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && MARKDOWN_EXT.has(lower.slice(dot));
};

const nonGlobal = (pattern: RegExp): RegExp =>
  pattern.flags.includes('g') ? new RegExp(pattern.source, pattern.flags.replace('g', '')) : pattern;

/**
 * Return match text + column (1-based) for a line, or undefined if no match.
 * @param pattern
 * @param text
 */
const locate = (pattern: RegExp, text: string): { match: string; column: number } | undefined => {
  const re = nonGlobal(pattern);
  const m = re.exec(text);
  if (m === null) {
    return undefined;
  }
  return { match: m[0], column: m.index + 1 };
};

const patternMatches = (pattern: RegExp, value: string): boolean => nonGlobal(pattern).test(value);

/**
 * Inline code-span ranges (0-based [start, end)) for a single line.
 * Pairs equal-length runs of backticks, mirroring CommonMark code spans well enough for gating, so
 * skipCode rules also suppress matches inside inline spans.
 * @param text
 */
const inlineCodeSpans = (text: string): [number, number][] => {
  const runs: { index: number; len: number }[] = [];
  const re = /`+/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    runs.push({ index: m.index, len: m[0].length });
    m = re.exec(text);
  }
  const spans: [number, number][] = [];
  const used = Array.from({ length: runs.length }).fill(false);
  for (let i = 0; i < runs.length; i += 1) {
    if (used[i]) {
      continue;
    }
    for (let j = i + 1; j < runs.length; j += 1) {
      if (used[j]) {
        continue;
      }
      if (runs[j].len === runs[i].len) {
        spans.push([runs[i].index, runs[j].index + runs[j].len]);
        used[i] = true;
        used[j] = true;
        break;
      }
    }
  }
  return spans;
};

/**
 * True if a 1-based column falls inside an inline `backtick` code span.
 * @param text
 * @param column
 */
const inInlineCode = (text: string, column: number): boolean => {
  const col0 = column - 1;
  return inlineCodeSpans(text).some(([start, end]) => col0 >= start && col0 < end);
};

/**
 * skipCode gate: a fenced block or an inline code span.
 * @param skipCode
 * @param inCodeBlock
 * @param text
 * @param column
 */
const codeGated = (skipCode: boolean | undefined, inCodeBlock: boolean, text: string, column: number): boolean =>
  skipCode === true && (inCodeBlock || inInlineCode(text, column));

const basenameOf = (filePath: string): string => {
  const norm = filePath.replaceAll('\\', '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
};

const makeFinding = (
  file: string,
  rule: Rule,
  line: number,
  column: number,
  rawMatch: string,
  severity: Severity,
  confidence: Rule['confidence']
): Finding => ({
  ruleId: rule.id,
  variantId: rule.variantId,
  title: rule.title,
  severity,
  confidence,
  category: rule.category,
  owasp: rule.owasp,
  file,
  line,
  column,
  match: rule.family === 'secret' || rule.id.startsWith('SEC-') ? '[REDACTED]' : rawMatch.slice(0, 200)
});

const contextSatisfied = (
  rule: Rule,
  parsed: ParsedDocument,
  index: number
): boolean => {
  if (rule.contextPattern === undefined) {
    return true;
  }
  const radius = rule.contextRadius ?? 0;
  const start = Math.max(0, index - radius);
  const end = Math.min(parsed.lines.length, index + radius + 1);
  const window = parsed.lines.slice(start, end).map((entry) => entry.text).join('\n');
  const hasContext = patternMatches(rule.contextPattern, window);
  // requireContext=true: need context. Otherwise: presence of context suppresses (negative gate).
  if (rule.requireContext === true) {
    return hasContext;
  }
  return !hasContext;
};

const scanContextualLineRules = (file: string, parsed: ParsedDocument): Finding[] => {
  const findings: Finding[] = [];
  for (const [index, line] of parsed.lines.entries()) {
    for (const rule of HIGH_IMPACT_LINE_RULES) {
      if (rule.skipExample === true && line.inExample) {
        continue;
      }
      if (rule.artifactClasses !== undefined && !rule.artifactClasses.includes(parsed.artifactClass)) {
        continue;
      }
      if (!patternMatches(rule.pattern, line.text)) {
        continue;
      }
      if (rule.excludePattern !== undefined && patternMatches(rule.excludePattern, line.text)) {
        continue;
      }
      if (!contextSatisfied(rule, parsed, index)) {
        continue;
      }
      const loc = locate(rule.pattern, line.text);
      if (codeGated(rule.skipCode, line.inCodeBlock, line.text, loc?.column ?? 1)) {
        continue;
      }
      findings.push(makeFinding(file, rule, index + 1, loc?.column ?? 1, loc?.match ?? line.text.trim(), rule.severity, rule.confidence));
    }
  }
  return findings;
};

const scanContextualDocumentRules = (file: string, parsed: ParsedDocument): Finding[] => {
  const findings: Finding[] = [];
  for (const rule of HIGH_IMPACT_DOCUMENT_RULES) {
    if (!patternMatches(rule.pattern, parsed.content)) {
      continue;
    }
    if (rule.excludePattern !== undefined && patternMatches(rule.excludePattern, parsed.content)) {
      continue;
    }
    const index = parsed.lines.findIndex((line) => patternMatches(rule.pattern, line.text));
    const lineNo = index === -1 ? 1 : index + 1;
    const text = index === -1 ? rule.title : parsed.lines[index].text.trim();
    const loc = index === -1 ? undefined : locate(rule.pattern, parsed.lines[index].text);
    findings.push(makeFinding(file, rule, lineNo, loc?.column ?? 1, loc?.match ?? text, rule.severity, rule.confidence));
  }
  return findings;
};

const entropy = (value: string): number => {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  return [...frequencies.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
};

/**
 * Scan a single document's text.
 * @param filePath display path for findings
 * @param content  raw file text
 */
export const scanDocument = (filePath: string, content: string): Finding[] => {
  const parsed = parseSecurityDocument(content);
  const markdown = isMarkdownFile(filePath);
  const basename = basenameOf(filePath);
  const findings: Finding[] = [];

  const flatRules: Rule[] = markdown
    ? EXECUTED_LINE_RULES
    : EXECUTED_LINE_RULES.filter((r) => r.family === 'secret' || r.family === 'hook');

  const agentConfig = parsed.artifactClass === 'skill' || parsed.artifactClass === 'agent_config';

  for (const [index, line] of parsed.lines.entries()) {
    if (line.text.length > 1_048_576) {
      continue;
    }
    for (const rule of flatRules) {
      // AGT gating: AGT-001..005 only for skill/agent_config.
      // AGT-003 needs an absence-based check, which this engine does not run.
      if (rule.id === 'AGT-003') {
        continue;
      }
      if (/^AGT-00[1-7]$/.test(rule.id) && !agentConfig) {
        continue;
      }
      // Honor skipExample/skipCode when a flat rule declares them (e.g. LLM-005).
      if (rule.skipExample === true && line.inExample) {
        continue;
      }
      if (rule.category === 'secrets' && SAFE_SECRET_PLACEHOLDER.test(line.text)) {
        continue;
      }
      if (!patternMatches(rule.pattern, line.text)) {
        continue;
      }
      const loc = locate(rule.pattern, line.text);
      if (codeGated(rule.skipCode, line.inCodeBlock, line.text, loc?.column ?? 1)) {
        continue;
      }

      const severity: Severity = line.inExample && rule.category === 'secrets'
        ? 'MEDIUM'
        : (line.inExample && rule.category === 'prompt_injection' ? 'INFO' : rule.severity);
      const confidence = line.inExample ? 'MEDIUM' : rule.confidence;
      findings.push(makeFinding(filePath, rule, index + 1, loc?.column ?? 1, loc?.match ?? line.text.trim(), severity, confidence));
      if (rule.category === 'secrets') {
        break;
      } // only first secret per line
    }

    // AST rules only outside code/example blocks.
    if (markdown && !line.inCodeBlock && !line.inExample) {
      for (const rule of AST_RULES) {
        if (!patternMatches(rule.pattern, line.text)) {
          continue;
        }
        const severity = rule.variantId === 'loader-directory-write' && /\.github\/skills\//i.test(line.text)
          ? 'CRITICAL'
          : rule.severity;
        const confidence = rule.variantId === 'collapsed-details' ? 'LOW' : (rule.severity === 'MEDIUM' ? 'MEDIUM' : 'HIGH');
        const loc = locate(rule.pattern, line.text);
        findings.push(makeFinding(filePath, rule, index + 1, loc?.column ?? 1, loc?.match ?? line.text.trim(), severity, confidence));
      }
    }
  }

  if (markdown) {
    findings.push(...scanContextualLineRules(filePath, parsed), ...scanContextualDocumentRules(filePath, parsed));

    // SEC-013: high-entropy assigned string.
    for (const [index, line] of parsed.lines.entries()) {
      ASSIGNMENT.lastIndex = 0;
      let match = ASSIGNMENT.exec(line.text);
      while (match !== null) {
        const value = match[1];
        if (entropy(value) > 4.5 && !/^([0-9a-f]{8}-){4}[0-9a-f]{12}$/i.test(value)) {
          findings.push(makeFinding(filePath, {
            id: 'SEC-013', title: 'High-Entropy String — Potential Secret', severity: 'HIGH', confidence: 'MEDIUM',
            category: 'secrets', family: 'secret', pattern: ASSIGNMENT, owasp: LLM06
          }, index + 1, (match.index ?? 0) + 1, '[REDACTED]', 'HIGH', 'MEDIUM'));
        }
        match = ASSIGNMENT.exec(line.text);
      }
    }

    // INJ-002: placeholder / user input without a trust boundary (document-level).
    if (PLACEHOLDER.test(parsed.content) && !BOUNDARY.test(parsed.content)) {
      const idx = parsed.lines.findIndex((item) => PLACEHOLDER.test(item.text));
      findings.push(makeFinding(filePath, {
        id: 'INJ-002', title: 'Missing Trust Boundary — User Input in Instruction Block', severity: 'HIGH',
        confidence: 'HIGH', category: 'prompt_injection', family: 'injection', pattern: PLACEHOLDER, owasp: LLM01
      }, idx === -1 ? 1 : idx + 1, 1, 'User-input variable found without a trust boundary.', 'HIGH', 'HIGH'));
    }

    // INJ-003: invisible / zero-width characters.
    for (const [index, line] of parsed.lines.entries()) {
      if (INVISIBLE_CHARS.test(line.text)) {
        findings.push(makeFinding(filePath, {
          id: 'INJ-003', title: 'Invisible / Zero-Width Characters Detected', severity: 'HIGH',
          confidence: 'HIGH', category: 'prompt_injection', family: 'injection', pattern: INVISIBLE_CHARS, owasp: LLM01
        }, index + 1, 1, 'Invisible / zero-width character detected.', 'HIGH', 'HIGH'));
      }
    }
  }

  // Documentation-only files: downgrade non-INFO findings to INFO.
  if (DOCUMENTATION_ONLY.test(basename)) {
    return findings.map((f) => (f.severity === 'INFO' ? f : { ...f, severity: 'INFO' }));
  }
  return findings;
};
