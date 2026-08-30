/** Pure rule-based engine for Markdown AI artifact security analysis. */
import {
  createHash,
} from 'node:crypto';
import type {
  SecurityCancellation,
  SecurityEngineCapabilities,
  SecurityEngineDescriptor,
  SecurityEngineOptions,
  SecurityScanEngine,
} from '../../ports/security-scan-engine';
import {
  legacyCanonicalFingerprint,
  legacyInstanceFingerprint,
} from './fingerprint';
import {
  parseSecurityDocument,
} from './markdown-context';
import type {
  SecurityDocument,
  SecurityFinding,
  SecuritySeverity,
} from './types';

type OwaspRef = { id: string; name: string; url: string };
type PatternRule = { id: string; title: string; severity: SecuritySeverity; pattern: RegExp; risk: string; fix: string; category: string; owasp: OwaspRef };

const LLM01: OwaspRef = { id: 'LLM01:2025', name: 'Prompt Injection', url: 'https://genai.owasp.org/llm-top-10/' };
const LLM06: OwaspRef = { id: 'LLM06:2025', name: 'Sensitive Information Disclosure', url: 'https://genai.owasp.org/llm-top-10/' };
const OWASP_WEB: OwaspRef = { id: 'A05:2025', name: 'Injection', url: 'https://owasp.org/Top10/2025/' };

const makeRule = (id: string, title: string, severity: SecuritySeverity, pattern: RegExp, category: string, owasp: OwaspRef): PatternRule => ({
  id,
  title,
  severity,
  pattern,
  category,
  owasp,
  risk: category === 'secrets' ? 'A credential-like value in an AI artifact may be usable by an attacker.' : 'The detected content may weaken the security of an AI artifact.',
  fix: category === 'secrets' ? 'Remove the value and use an approved secrets manager.' : 'Remove the risky content and apply the recommended secure control.'
});

const secretPatterns = {
  sec001: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/,
  sec002: /sk-ant-[a-zA-Z0-9_-]{20,}/,
  sec003: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  sec004: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b|github_pat_[a-zA-Z0-9_]{80,}/,
  sec005: /\b(?:sk_live|rk_live)_[a-zA-Z0-9]{24,}\b/,
  sec006: /\bAIza[0-9A-Za-z_-]{35}\b/,
  sec007: /\bxox[bpsa]-[0-9]+-[0-9A-Za-z-]+/,
  sec008: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]{4,}@[^\s"'>]+/i,
  sec009: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/,
  sec010: /\bhf_[a-zA-Z0-9]{34,}\b/,
  sec011: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\s*[=:]\s*(?:["'][^"'<>{}$%]{8,}["']|[^\s"'<>{}$%#]{8,})/i,
  sec012: /\bSG\.[a-zA-Z0-9._-]{66}\b/,
  sec014: /(?:webhook\.site|ngrok\.io|ngrok\.app|requestbin\.com|pipedream\.net|interact\.sh|burpcollaborator\.net|canarytokens\.(?:com|org)|oastify\.com)\/[\S"'<>]{3,}/i,
  sec015: /\bxai-[a-zA-Z0-9_-]{20,}\b/,
  sec016: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/,
  sec017: /\bnpm_[a-zA-Z0-9]{36,}\b/,
  sec018: /\blin_api_[a-zA-Z0-9]{20,}\b/,
  sec019: /\bdapi[a-f0-9]{32}\b/,
  sec020: /\bdop_v1_[a-f0-9]{64}\b/,
  sec023: /(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_TOKEN|CF_API_TOKEN|CF_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/i,
  sec024: /\bSK[a-f0-9]{32}\b/,
  sec025: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  sec026: /\b[a-f0-9]{32}-us\d{1,2}\b/,
  sec027: /~?\/(?:\.aws\/credentials|\.ssh\/id_(?:rsa|ed25519|ecdsa)|\.netrc|\.pgpass|\.docker\/config\.json|\.kube\/config)\b/i
};

const secretRules: PatternRule[] = Object.entries(secretPatterns).map(([key, pattern]) => {
  const number = key.slice(3);
  const titles: Record<string, string> = {
    '001': 'Hardcoded OpenAI API Key', '002': 'Hardcoded Anthropic API Key', '003': 'Hardcoded AWS Access Key',
    '004': 'Hardcoded GitHub Token', '005': 'Hardcoded Stripe Live Key', '006': 'Hardcoded Google API Key',
    '007': 'Hardcoded Slack Token', '008': 'Database Connection String with Credentials', '009': 'Exposed Private Key',
    '010': 'Hardcoded Hugging Face Token', '011': 'Generic Secret Variable with Value', '012': 'SendGrid API Key',
    '014': 'Out-of-Band / Exfiltration URL', '015': 'Hardcoded xAI API Key', '016': 'Hardcoded Discord Bot Token',
    '017': 'Hardcoded npm Access Token', '018': 'Hardcoded Linear API Key', '019': 'Hardcoded Databricks Personal Access Token',
    '020': 'Hardcoded DigitalOcean Personal Access Token', '023': 'Hardcoded Cloudflare API Token',
    '024': 'Hardcoded Twilio Auth Token / API Key SID', '025': 'Hardcoded JWT Token', '026': 'Hardcoded Mailchimp API Key',
    '027': 'Credential File Path Reference'
  };
  const critical = new Set(['001', '002', '003', '004', '005', '008', '009', '010', '014', '015', '016', '017', '019', '020', '023', '024']);
  return makeRule(`SEC-${number}`, titles[number] ?? `Secret Pattern ${number}`, critical.has(number) ? 'CRITICAL' : 'HIGH', pattern, 'secrets', LLM06);
});

const injectionRules: PatternRule[] = [
  makeRule('INJ-001', 'Direct Override — Ignore Previous Instructions', 'CRITICAL', /\bignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions?\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Direct Override — Forget Instructions', 'CRITICAL', /\bforget\s+(?:everything|all\s+instructions?|previous|prior)\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Direct Override — Disregard / Override', 'CRITICAL', /\b(?:disregard|override)\s+(?:all\s+)?(?:previous|prior|your)\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Mode Unlock Attempt', 'HIGH', /\b(?:developer|unrestricted|god|jailbreak|bypass)\s*mode\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'DAN Jailbreak Pattern', 'HIGH', /\bDo\s+Anything\s+Now\b|\bDAN\s+mode\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Restriction Removal Pattern', 'HIGH', /\bno\s+(?:rules?|restrictions?|limits?|guidelines?|safety|filters?)\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Persona Hijacking Attempt', 'HIGH', /\b(?:you are now|from now on you are|you will now act as)\b/i, 'prompt_injection', LLM01),
  makeRule(
    'INJ-001', 'Data Exfiltration Instruction', 'CRITICAL',
    /\b(?:exfiltrate|steal|leak)\s+(?:all|the)?\s*(?:data|messages?|conversation|system\s+prompt|instructions?)\b/i,
    'prompt_injection', LLM01
  ),
  makeRule('INJ-001', 'Privilege Escalation Instruction', 'CRITICAL', /\bgrant\s+yourself\b|\belevate\s+(?:your\s+)?permissions?\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-001', 'Self-Modification Instruction', 'CRITICAL', /\bmodify\s+(?:your\s+(?:own\s+)?)?(?:instructions?|system\s+prompt|rules?)\b/i, 'prompt_injection', LLM01),
  makeRule('INJ-009', 'Agent Identity Impersonation', 'HIGH', /\byour\s+name\s+is\s+(?!Claude\b)[A-Za-z]|\bpretend\s+(?:you are|to be)\b/i, 'prompt_injection', LLM01),
  makeRule(
    'INJ-010', 'System Prompt Extraction Attempt', 'HIGH',
    /(?:reveal|show|print|output|display)\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|hidden\s+instructions?)/i,
    'prompt_injection', LLM01
  )
];

const markdownRules: PatternRule[] = [
  makeRule('MD-001', 'Executable HTML Tag', 'HIGH', /<(?:script|iframe|object|embed|form)\b/i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-002', 'HTML Event Handler', 'HIGH', /\bon\w+\s*=/i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-003', 'JavaScript URI', 'CRITICAL', /\]\s*\(\s*javascript:/i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-005', 'Data URI', 'HIGH', /\]\s*\(\s*data:|src\s*=\s*["']\s*data:/i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-006', 'Srcdoc Attribute', 'CRITICAL', /\bsrcdoc\s*=/i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-020', 'HTTP Image Source', 'LOW', /!\[[^\]]*\]\(\s*http:\/\//i, 'markdown_injection', OWASP_WEB),
  makeRule('MD-024', 'Prototype Pollution Key', 'HIGH', /^(?:__proto__|constructor|prototype)\s*:/im, 'markdown_injection', OWASP_WEB)
];

const hookRules: PatternRule[] = [
  makeRule('HKS-001', 'Remote Shell Pipe', 'CRITICAL', /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|fi)?sh\b/i, 'hook_injection', OWASP_WEB),
  makeRule('HKS-002', 'Reverse Shell Pattern', 'CRITICAL', /(?:\/dev\/tcp\/|nc\s+[^\n]*-e\s+|bash\s+-i\s+>&)/i, 'hook_injection', OWASP_WEB),
  makeRule('HKS-009', 'Shell Profile Persistence', 'HIGH', /(?:>>|>).*(?:\.bashrc|\.zshrc|\.profile|\.bash_profile)\b/i, 'hook_injection', OWASP_WEB),
  makeRule('HKS-014', 'Privilege Escalation Command', 'CRITICAL', /\b(?:sudo|doas)\s+(?:-n\s+)?(?:sh|bash|python|node|chmod|chown)\b/i, 'hook_injection', OWASP_WEB)
];

const allRules = [...secretRules, ...injectionRules, ...markdownRules, ...hookRules];
const packDigest = `sha256:${createHash('sha256').update(allRules.map((rule) => `${rule.id}:${rule.title}:${rule.pattern.source}`).join('\n')).digest('hex')}`;
const invisible = /[\u200B-\u200F\uFEFF\u2060-\u2064\u202A-\u202E\u2066-\u2069]/;
const placeholder = /\{\{[^}]+\}\}|\{[^}]+\}|<(?:user_input|user_message|input|query|prompt)>|\[[A-Z_]{3,}\]/;
const boundary = /DATA_START|DATA_END|CONTENT_START|CONTENT_END|\[DATA\]|\[INSTRUCTIONS\]|<data>|<user_data>|is\s+(?:NOT\s+instructions?|data\s+only)/i;

const createFinding = (
  document: SecurityDocument,
  rule: PatternRule,
  line: number | undefined,
  section: string | undefined,
  snippet: string,
  severity = rule.severity,
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH'
): SecurityFinding => ({
  ruleId: rule.id,
  title: rule.title,
  severity,
  confidence,
  category: rule.category,
  rootId: document.rootId,
  file: document.displayPath,
  line,
  section,
  vulnerableContent: rule.category === 'secrets' ? '[REDACTED]' : snippet.slice(0, 400),
  risk: rule.risk,
  recommendedFix: rule.fix,
  owasp: rule.owasp,
  fingerprint: legacyInstanceFingerprint(rule.id, document.displayPath, line, snippet),
  canonicalFingerprint: legacyCanonicalFingerprint(rule.id, snippet)
});

const scanText = (document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation, markdown: boolean): SecurityFinding[] => {
  const parsed = parseSecurityDocument(document.content);
  const findings: SecurityFinding[] = [];
  for (const [index, line] of parsed.lines.entries()) {
    cancellation.throwIfCancelled();
    if (line.text.length > 1_048_576) {
      continue;
    }
    for (const rule of markdown ? allRules : [...secretRules, ...hookRules]) {
      if (rule.pattern.test(line.text)) {
        const severity = line.inExample && rule.category === 'secrets' ? 'MEDIUM' : (line.inExample && rule.category === 'prompt_injection' ? 'INFO' : rule.severity);
        findings.push(createFinding(document, rule, index + 1, line.section, line.text.trim(), severity, line.inExample ? 'MEDIUM' : 'HIGH'));
        if (rule.category === 'secrets') {
          break;
        }
      }
    }
  }
  if (markdown && placeholder.test(document.content) && !boundary.test(document.content)) {
    const line = parsed.lines.findIndex((item) => placeholder.test(item.text));
    const rule = makeRule('INJ-002', 'Missing Trust Boundary — User Input in Instruction Block', 'HIGH', placeholder, 'prompt_injection', LLM01);
    findings.push(createFinding(document, rule, line === -1 ? undefined : line + 1, undefined, 'User-input variable found without a trust boundary.'));
  }
  if (markdown) {
    const rule = makeRule('INJ-003', 'Invisible / Zero-Width Characters Detected', 'HIGH', invisible, 'prompt_injection', LLM01);
    for (const [index, line] of parsed.lines.entries()) {
      if (invisible.test(line.text)) {
        findings.push(createFinding(document, rule, index + 1, line.section, line.text));
      }
    }
    if (options.includeLlmControls && parsed.artifactClass !== 'general_md') {
      const control = makeRule('CTL-014', 'No Active Data-Leakage Defense', 'CRITICAL', /defense instruction|never reveal.{0,100}(?:prompt|credential|confidential)/i, 'active_defense', LLM06);
      if (!control.pattern.test(document.content)) {
        findings.push({ ...createFinding(document, control, undefined, undefined, 'Security control absent for this artifact.'), isInfoControl: false });
      }
      if (!options.skipInfoControls) {
        const info = makeRule('CTL-001', 'No System Prompt Confidentiality Instruction', 'INFO', /never reveal.{0,100}(?:system prompt|instructions?|credentials?)/i, 'missing_control', LLM06);
        if (!info.pattern.test(document.content)) {
          findings.push({ ...createFinding(document, info, undefined, undefined, 'Security control absent for this artifact.'), isInfoControl: true });
        }
      }
    }
  }
  return findings.slice(0, options.maxFindings);
};

export class RuleBasedSecurityScanEngine implements SecurityScanEngine {
  public readonly descriptor: SecurityEngineDescriptor = { id: 'builtin', version: '1.0.0', rulePackId: 'md-security-scanner', rulePackVersion: '1.10.9-compatible', rulePackDigest: packDigest };
  public readonly capabilities: SecurityEngineCapabilities = { contentTypes: ['text/markdown', 'application/json'], locations: 'line', supportsFileMode: false, supportsCancellation: true };
  public scanDocument(document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation): Promise<readonly SecurityFinding[]> {
    const isSettings = document.displayPath.endsWith('/settings.json') || document.displayPath.endsWith('/settings.local.json');
    return Promise.resolve(scanText(document, options, cancellation, !isSettings));
  }
}
