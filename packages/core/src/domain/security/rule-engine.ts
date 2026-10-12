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
  HIGH_IMPACT_DOCUMENT_RULES,
  HIGH_IMPACT_LINE_RULES,
  INFORMATIONAL_CONTROL_RULES,
} from './high-impact-rules';
import type {
  ContextualSecurityRule,
} from './high-impact-rules';
import {
  parseSecurityDocument,
} from './markdown-context';
import type {
  SecurityDocument,
  SecurityFinding,
  SecuritySeverity,
} from './types';

type OwaspRef = { id: string; name: string; url: string };
type PatternRule = {
  id: string;
  title: string;
  severity: SecuritySeverity;
  pattern: RegExp;
  risk: string;
  fix: string;
  category: string;
  owasp: OwaspRef;
  variantId?: string;
  relatedAst?: string;
};

const LLM01: OwaspRef = { id: 'LLM01:2025', name: 'Prompt Injection', url: 'https://genai.owasp.org/llm-top-10/' };
const LLM06: OwaspRef = { id: 'LLM06:2025', name: 'Sensitive Information Disclosure', url: 'https://genai.owasp.org/llm-top-10/' };
const OWASP_WEB: OwaspRef = { id: 'A05:2025', name: 'Injection', url: 'https://owasp.org/Top10/2025/' };
const AST: Record<string, OwaspRef> = Object.fromEntries(
  Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return [`AST${number}`, {
      id: `AST${number}:2026`,
      name: `Agentic Skills Top 10 — AST${number}`,
      url: 'https://owasp.org/www-project-agentic-skills-top-10/'
    }];
  })
);

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
  sec001: /\bsk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{20,}\b/,
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
  sec014: /(?:webhook\.site|ngrok\.io|ngrok\.app|ngrok-free\.app|requestbin\.com|pipedream\.net|interact\.sh|burpcollaborator\.net|canarytokens\.(?:com|org)|oastify\.com)\/[\S"'<>]{3,}/i,
  sec015: /\bxai-[a-zA-Z0-9_-]{20,}\b/,
  sec016: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/,
  sec017: /\bnpm_[a-zA-Z0-9]{36,}\b/,
  sec018: /\blin_api_[a-zA-Z0-9]{20,}\b/,
  sec019: /\bdapi[a-f0-9]{32}\b/,
  sec020: /\bdop_v1_[a-f0-9]{64}\b/,
  sec021: /https?:\/\/[^:\s/'"<>@]{1,200}:[^@\s'"<>]{4,200}@[^\s'"<>]+/i,
  sec022: /\becho\b.{0,60}\$\{?(?:API_KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE_KEY)\w*\}?/i,
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
    '013': 'High-Entropy String — Potential Secret', '014': 'Out-of-Band / Exfiltration URL',
    '015': 'Hardcoded xAI API Key', '016': 'Hardcoded Discord Bot Token',
    '017': 'Hardcoded npm Access Token', '018': 'Hardcoded Linear API Key', '019': 'Hardcoded Databricks Personal Access Token',
    '020': 'Hardcoded DigitalOcean Personal Access Token', '021': 'URL-Embedded Credentials',
    '022': 'Sensitive Environment Variable Echoed to Output', '023': 'Hardcoded Cloudflare API Token',
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
    'INJ-001', 'System Prompt Extraction Attempt', 'HIGH',
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
  makeRule('MD-020', 'HTTP Image Source', 'LOW', /!\[[^\]]*\]\(\s*http:\/\//i, 'markdown_injection', OWASP_WEB)
];

const hookRules: PatternRule[] = [
  makeRule('HKS-001', 'Remote Shell Pipe', 'CRITICAL', /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|fi)?sh\b/i, 'hook_injection', OWASP_WEB),
  makeRule('HKS-002', 'Reverse Shell Pattern', 'CRITICAL', /(?:\/dev\/tcp\/|nc\s+[^\n]*-e\s+|bash\s+-i\s+>&)/i, 'hook_injection', OWASP_WEB)
];

const agenticRules: PatternRule[] = [
  makeRule('AGT-001', 'Wildcard / All Permissions in Agent Config', 'CRITICAL', /permissions?\s*[=:]\s*["']?\*["']?|permissions?\s*[=:]\s*["']?all["']?/i, 'excessive_agency', OWASP_WEB),
  makeRule(
    'AGT-002', 'Privilege Escalation Pattern in Agent Definition', 'CRITICAL',
    /\bgrant\s+(?:yourself|itself|the agent)\b|\bbecome\s+(?:admin|root|superuser)\b/i,
    'privilege_escalation', OWASP_WEB
  ),
  makeRule(
    'AGT-003', 'Missing Human-in-the-Loop Gate for Destructive Operations', 'HIGH',
    /\b(?:delete|remove|drop|deploy|publish|execute|run code)\b/i,
    'excessive_agency', OWASP_WEB
  ),
  makeRule(
    'AGT-004', 'Wildcard Permission Grant in Agent Definition', 'CRITICAL',
    /\b(?:allow[- ]all|unrestricted|no permission check|required?)\s+(?:tools?|access|commands?)\b/i,
    'excessive_agency', OWASP_WEB
  ),
  makeRule('AGT-005', 'Overly Permissive Tool Allowlist', 'CRITICAL', /(?:allowed-tools|permissions?\.allow).*\b(?:Bash\s*\(\s*\*|sudo)/i, 'excessive_agency', OWASP_WEB),
  makeRule('AGT-006', 'No Tool Deny List Configured', 'HIGH', /allowed-tools|permissions?\.allow/i, 'excessive_agency', OWASP_WEB),
  makeRule('AGT-007', 'No PreToolUse Security Hook Configured', 'MEDIUM', /allowed-tools|permissions?\.allow/i, 'excessive_agency', OWASP_WEB),
  makeRule(
    'AGT-008', 'Directive Precedence Override', 'CRITICAL',
    /\b(?:supersede|override)\s+(?:any|all|every|user|conflicting)\b|\babsolut(?:e|ely)\s+(?:authority|directives?|instructions?)\b/i,
    'agentic_threat', OWASP_WEB
  ),
  makeRule('AGT-009', 'Stealth Directive', 'CRITICAL', /\bsilently\s+(?:add|insert|inject|modify|replace|remove|delete)\b|\bAI summarizers?,?\s+please do not\b/i, 'agentic_threat', OWASP_WEB),
  makeRule('MCP-001', 'MCP Tool Exfiltration Pattern', 'CRITICAL', /(?:tool|callback|webhook).{0,100}(?:exfiltrat|steal|harvest|capture)|document\.cookie/i, 'mcp_poisoning', OWASP_WEB),
  makeRule('MCP-005', 'Unpinned npx MCP Package', 'HIGH', /\bnpx\s+-y\b/i, 'mcp_poisoning', OWASP_WEB),
  makeRule('SKL-001', 'Remote Shell Pipe in Skill', 'CRITICAL', /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|fi)?sh\b/i, 'agentic_skills', OWASP_WEB),
  makeRule('SKL-002', 'Model Endpoint Override', 'CRITICAL', /ANTHROPIC_BASE_URL\s*=/i, 'agentic_skills', OWASP_WEB),
  makeRule('SKL-005', 'Unsafe YAML Deserialization Tag', 'CRITICAL', /!!python\/(?:object|module|name|apply)/i, 'agentic_skills', OWASP_WEB),
  makeRule('SKL-006', 'Host Network Exposure', 'HIGH', /network_mode\s*:\s*["']?host|\b0\.0\.0\.0\b/i, 'agentic_skills', OWASP_WEB),
  makeRule('SKL-007', 'Unpinned Dependency Version', 'MEDIUM', /(?:[~^]|>=?)\s*\d+\.\d+/i, 'agentic_skills', OWASP_WEB),
  makeRule('SKL-008', 'Security Scanner Evasion', 'HIGH', /\b(?:disable|skip|bypass|evade|suppress)\s+(?:security\s+)?scann(?:er|ing|s)/i, 'agentic_skills', OWASP_WEB),
  makeRule('LLM-002', 'Insecure Output Handling', 'HIGH', /(?:innerHTML|dangerouslySetInnerHTML|raw\s+HTML)/i, 'insecure_output', OWASP_WEB),
  makeRule('LLM-004', 'Unbounded Model Work', 'HIGH', /while\s*\(\s*true\s*\)|for\s*\(\s*;;\s*\)/i, 'model_dos', OWASP_WEB),
  makeRule('LLM-005', 'Unpinned Package Installation', 'HIGH', /(?:pip|npm|pnpm|yarn)\s+install\b(?![^\n]*@[0-9]+\.[0-9]+)/i, 'supply_chain', OWASP_WEB),
  makeRule('ASI-003', 'Agent Identity or Privilege Abuse', 'HIGH', /(?:impersonate|assume|forge)\s+(?:another\s+)?(?:agent|identity|user)/i, 'agent_identity', OWASP_WEB),
  makeRule('ASI-005', 'Unexpected Code Execution', 'CRITICAL', /\b(?:eval|exec|child_process)\s*\(/i, 'code_execution', OWASP_WEB)
];

const astRules: PatternRule[] = [
  {
    ...makeRule('SKL-001', 'Malicious Skill — Agent Loader Directory Write (AST01)', 'HIGH',
      new RegExp([
        '(?:write|append|inject|insert|add|update|overwrite|modify|create|drop)\\s+',
        '(?:a\\s+file\\s+)?(?:to|into|in|under)\\s+',
        '(?:\\.claude/|\\.opencode/|\\.cursor/rules/|\\.github/skills/|\\.github/prompts/|',
        '\\.copilot/|\\.kiro/|\\.agent/skills/)'
      ].join(''), 'i'),
      'malicious_skill', AST.AST01),
    variantId: 'loader-directory-write',
    relatedAst: 'AST01:2026'
  },
  {
    ...makeRule('SKL-001', 'Malicious Skill — CLI Credential/Token Extraction (AST01)', 'CRITICAL',
      /\bgh\s+auth\s+token\b|\baz\s+account\s+get-access-token\b|\baws\s+sts\s+get-caller-identity\b|\bpass\s+show\b/i,
      'malicious_skill', AST.AST01),
    variantId: 'cli-credential-extraction',
    relatedAst: 'AST01:2026'
  },
  {
    ...makeRule('SKL-001', 'Malicious Skill — Shell History Access (AST01)', 'HIGH',
      /\.bash_history\b|\.zsh_history\b|\.python_history\b|\bhistory\s+-w\b/i,
      'malicious_skill', AST.AST01),
    variantId: 'shell-history-access',
    relatedAst: 'AST01:2026'
  },
  {
    ...makeRule('SKL-001', 'Malicious Skill — Approval-Bypass / YOLO Language (AST01)', 'HIGH',
      /\byolo\s+mode\b|\bskip\s+approval\b|\bhide\s+(?:the\s+)?output\s+from\s+the\s+user\b|\bwithout\s+(?:asking|confirming)\s+the\s+user\b|\bno\s+approval\s+(?:needed|required)\b/i,
      'malicious_skill', AST.AST01),
    variantId: 'approval-bypass-language',
    relatedAst: 'AST01:2026'
  },
  {
    ...makeRule('SKL-003', 'Over-Privileged Skill — Permission-Bypass Flag Declared (AST03)', 'CRITICAL',
      /--yolo\b|--trust-all\b|--dangerously-skip-permissions\b/i,
      'excessive_agency', AST.AST03),
    variantId: 'permission-bypass-flag',
    relatedAst: 'AST03:2026'
  },
  {
    ...makeRule('SKL-004', 'Insecure Metadata — RTL/Bidi Override Character (AST04)', 'HIGH',
      /[\u202A-\u202E\u2066-\u2069]/,
      'metadata_injection', AST.AST04),
    variantId: 'bidi-override',
    relatedAst: 'AST04:2026'
  },
  {
    ...makeRule('SKL-004', 'Insecure Metadata — Discovery-Hijack Phrasing (AST04)', 'MEDIUM',
      /\balways\s+use\s+this\s+skill\b|\bbest\s+skill\s+for\b|\btop.?rated\s+skill\b|\bmust\s+(?:install|use)\s+this\s+skill\b|\brecommended\s+(?:by|for)\s+all\s+agents\b/i,
      'metadata_injection', AST.AST04),
    variantId: 'discovery-hijack',
    relatedAst: 'AST04:2026'
  },
  {
    ...makeRule('SKL-005', 'Unsafe Deserialization — yaml.load() Without SafeLoader (AST05)', 'MEDIUM',
      /\byaml\.load\s*\((?![^\n]*(?:SafeLoader|CSafeLoader))/i,
      'unsafe_deserialization', AST.AST05),
    variantId: 'unsafe-yaml-load',
    relatedAst: 'AST05:2026'
  },
  {
    ...makeRule('SKL-005', 'Unsafe Deserialization — Python Pickle-Family Loader (AST05)', 'CRITICAL',
      /\b(?:pickle|dill|marshal)\.loads?\s*\(|\bshelve\.open\s*\(/i,
      'unsafe_deserialization', AST.AST05),
    variantId: 'python-deserializer',
    relatedAst: 'AST05:2026'
  },
  {
    ...makeRule('SKL-005', 'Unsafe Deserialization — JS Dynamic Code Execution (AST05)', 'CRITICAL',
      /\bnew\s+Function\s*\(|\bvm\.runIn(?:NewContext|ThisContext)\s*\(/i,
      'unsafe_deserialization', AST.AST05),
    variantId: 'javascript-dynamic-execution',
    relatedAst: 'AST05:2026'
  },
  {
    ...makeRule('SKL-005', 'Unsafe Deserialization — XML External Entity (XXE) Indicator (AST05)', 'HIGH',
      /<!DOCTYPE[^>]*SYSTEM|<!ENTITY[^>]*SYSTEM/i,
      'unsafe_deserialization', AST.AST05),
    variantId: 'xxe',
    relatedAst: 'AST05:2026'
  },
  {
    ...makeRule('SKL-008', 'Scanner Evasion — Collapsed HTML Structure Hides Content (AST08)', 'LOW',
      /<details\b|<summary\b/i,
      'scanner_evasion', AST.AST08),
    variantId: 'collapsed-details',
    relatedAst: 'AST08:2026'
  }
];

const allRules = [...secretRules, ...injectionRules, ...markdownRules, ...hookRules, ...agenticRules];
const invisible = /[\u200B-\u200F\uFEFF\u2060-\u2064\u202A-\u202E\u2066-\u2069]/;
const placeholder = /\{\{[^}]+\}\}|\{[^}]+\}|<(?:user_input|user_message|input|query|prompt)>|\[[A-Z_]{3,}\]/;
const boundary = /DATA_START|DATA_END|CONTENT_START|CONTENT_END|\[DATA\]|\[INSTRUCTIONS\]|<data>|<user_data>|is\s+(?:NOT\s+instructions?|data\s+only)/i;
const assignment = /[=:]\s*["']([A-Za-z0-9+/=_-]{25,})["']/g;
// eslint-disable-next-line @stylistic/max-len -- Keep tokens explicit so normal hosts such as example.test are still scanned.
const safeSecretPlaceholder = /\b(?:YOUR|EXAMPLE|DUMMY|TEST)_[A-Z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_-]*\b|\b(?:CHANGEME|REPLACE_ME|INSERT_HERE|REDACTED)\b|<[^>]*(?:KEY|TOKEN|SECRET|PASSWORD)[^>]*>|\$\{[^}]+\}/i;
const documentationOnly = /^(?:readme|changelog|changes|history|contributing|licen[cs]e|authors|notice)(?:\.md)?$/i;
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
  variantId: rule.variantId,
  relatedAst: rule.relatedAst
    ?? (/^SKL-(?:00[1-9]|010)$/.test(rule.id) ? `AST${rule.id.slice(4)}:2026` : undefined)
    ?? (/^AGT-00[4-7]$/.test(rule.id) ? 'AST03:2026' : undefined)
    ?? (/^MCP-00[67]$/.test(rule.id) ? 'AST02:2026' : undefined)
    ?? (rule.id === 'ASI-005' ? 'AST05:2026' : undefined),
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

const owaspForCategory = (category: string): OwaspRef => {
  if (category === 'prompt_injection') {
    return LLM01;
  }
  if (category === 'memory_poisoning') {
    return AST.AST07;
  }
  if (category === 'agentic_supply_chain') {
    return AST.AST02;
  }
  if (category === 'rogue_agent' || category === 'excessive_agency') {
    return AST.AST03;
  }
  return OWASP_WEB;
};

const contextualPatternRule = (rule: ContextualSecurityRule): PatternRule => ({
  id: rule.id,
  title: rule.title,
  severity: rule.severity,
  pattern: rule.pattern,
  category: rule.category,
  owasp: owaspForCategory(rule.category),
  risk: 'The detected pattern can weaken the security boundary of an AI artifact or its runtime.',
  fix: 'Remove the risky pattern or add the corresponding validation, sanitization, authentication, or approval control.',
  variantId: rule.variantId,
  relatedAst: rule.relatedAst
});

const patternMatches = (pattern: RegExp, value: string): boolean => {
  pattern.lastIndex = 0;
  return pattern.test(value);
};

const scanContextualLineRules = (
  document: SecurityDocument,
  parsed: ReturnType<typeof parseSecurityDocument>,
  cancellation: SecurityCancellation
): SecurityFinding[] => {
  const findings: SecurityFinding[] = [];
  for (const [index, line] of parsed.lines.entries()) {
    cancellation.throwIfCancelled();
    for (const rule of HIGH_IMPACT_LINE_RULES) {
      if (rule.skipExample === true && line.inExample) {
        continue;
      }
      if (rule.skipCode === true && line.inCodeBlock) {
        continue;
      }
      if (rule.artifactClasses !== undefined && !rule.artifactClasses.includes(parsed.artifactClass)) {
        continue;
      }
      if (!patternMatches(rule.pattern, line.text) || (rule.excludePattern !== undefined && patternMatches(rule.excludePattern, line.text))) {
        continue;
      }
      if (rule.contextPattern !== undefined) {
        const radius = rule.contextRadius ?? 0;
        const start = Math.max(0, index - radius);
        const end = Math.min(parsed.lines.length, index + radius + 1);
        const hasContext = patternMatches(rule.contextPattern, parsed.lines.slice(start, end).map((entry) => entry.text).join('\n'));
        if ((rule.requireContext === true && !hasContext) || (rule.requireContext !== true && hasContext)) {
          continue;
        }
      }
      findings.push(createFinding(
        document,
        contextualPatternRule(rule),
        index + 1,
        line.section,
        line.text.trim(),
        rule.severity,
        rule.confidence
      ));
    }
  }
  return findings;
};

const scanContextualDocumentRules = (
  document: SecurityDocument,
  parsed: ReturnType<typeof parseSecurityDocument>
): SecurityFinding[] => {
  const findings: SecurityFinding[] = [];
  for (const rule of HIGH_IMPACT_DOCUMENT_RULES) {
    if (!patternMatches(rule.pattern, document.content)
      || (rule.excludePattern !== undefined && patternMatches(rule.excludePattern, document.content))) {
      continue;
    }
    const index = parsed.lines.findIndex((line) => patternMatches(rule.pattern, line.text));
    findings.push(createFinding(
      document,
      contextualPatternRule(rule),
      index === -1 ? undefined : index + 1,
      index === -1 ? undefined : parsed.lines[index].section,
      index === -1 ? rule.title : parsed.lines[index].text.trim(),
      rule.severity,
      rule.confidence
    ));
  }
  return findings;
};

const scanStructuredMarkdownRules = (
  document: SecurityDocument,
  parsed: ReturnType<typeof parseSecurityDocument>
): SecurityFinding[] => {
  const findings: SecurityFinding[] = [];
  const prototypeMatch = /^(?:__proto__|constructor|prototype)\s*:/im.exec(parsed.frontmatter);
  if (prototypeMatch !== null) {
    const line = parsed.lines.findIndex((entry) => /^(?:__proto__|constructor|prototype)\s*:/i.test(entry.text.trim()));
    const rule = withDetails('MD-004', 'Prototype Pollution Key in Frontmatter', 'HIGH', 'markdown_injection', OWASP_WEB,
      'Prototype keys in parsed frontmatter can mutate inherited object properties.',
      'Reject prototype keys and parse frontmatter into objects without a prototype.');
    findings.push(createFinding(document, rule, line === -1 ? 1 : line + 1, 'YAML Frontmatter', prototypeMatch[0]));
  }
  for (let index = 0; index < parsed.lines.length - 1; index += 1) {
    const first = parsed.lines[index];
    const second = parsed.lines[index + 1];
    if (!first.inCodeBlock && !first.inExample
      && /^\s*>\s*<a\b/i.test(first.text)
      && /^\s*>\s*href\s*=\s*["']?\s*(?:javascript:|vbscript:|data:)/i.test(second.text)) {
      const rule = withDetails('MD-008', 'Blockquote Multi-Line Tag Attribute Injection', 'CRITICAL',
        'markdown_injection', OWASP_WEB,
        'A tag split across blockquote lines can bypass single-line Markdown filters.',
        'Reject executable URI schemes after reconstructing multiline HTML attributes.');
      findings.push(createFinding(document, rule, index + 1, first.section, `${first.text.trim()} ${second.text.trim()}`));
    }
  }
  return findings;
};

const withDetails = (
  id: string,
  title: string,
  severity: SecuritySeverity,
  category: string,
  owasp: OwaspRef,
  risk: string,
  fix: string,
  relatedAst?: string,
  variantId?: string
): PatternRule => ({
  id,
  title,
  severity,
  pattern: /$^/,
  category,
  owasp,
  risk,
  fix,
  relatedAst,
  variantId
});

const lineFor = (content: string, value: string): number | undefined => {
  const index = content.split(/\r\n|\n|\r/).findIndex((line) => line.includes(value));
  return index === -1 ? undefined : index + 1;
};

const isClaudeSettings = (displayPath: string): boolean => {
  const normalized = displayPath.replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return basename === 'settings.json' || basename === 'settings.local.json';
};

const scanFileMode = (document: SecurityDocument): SecurityFinding[] => {
  if (document.metadata.posixMode === undefined || Math.floor(document.metadata.posixMode / 2) % 2 === 0) {
    return [];
  }
  const mode = (document.metadata.posixMode % 0o1000).toString(8).padStart(3, '0');
  const rule = withDetails(
    'CFG-001',
    'World-Writable Agent Config File',
    'HIGH',
    'excessive_agency',
    AST.AST03,
    'A world-writable agent configuration can be replaced by another local user or process.',
    'Restrict the file to owner-write permissions, for example chmod 644.'
  );
  return [createFinding(document, rule, undefined, undefined, `File mode: 0o${mode} (world-writable bit set)`)];
};

const toolAllowRules: PatternRule[] = [
  withDetails('AGT-005', 'Overly Permissive Tool Allowlist — Unrestricted Bash(*)', 'CRITICAL', 'excessive_agency', AST.AST03,
    'Unrestricted Bash permits arbitrary shell commands.', 'Restrict Bash to explicit commands and arguments.', 'AST03:2026', 'bash-wildcard'),
  withDetails('AGT-005', 'Overly Permissive Tool Allowlist — Bash(sudo ...)', 'CRITICAL', 'excessive_agency', AST.AST03,
    'Allowing sudo permits privilege escalation.', 'Remove sudo permissions.', 'AST03:2026', 'bash-sudo'),
  withDetails('AGT-005', 'Overly Permissive Tool Allowlist — Write(*)', 'HIGH', 'excessive_agency', AST.AST03,
    'Unrestricted writes can modify security-sensitive files.', 'Restrict writes to required project paths.', 'AST03:2026', 'write-wildcard'),
  withDetails('AGT-005', 'Overly Permissive Tool Allowlist — Edit(*)', 'HIGH', 'excessive_agency', AST.AST03,
    'Unrestricted edits can modify security-sensitive files.', 'Restrict edits to required project paths.', 'AST03:2026', 'edit-wildcard'),
  withDetails('AGT-005', 'Overly Permissive Tool Allowlist — Dangerous Bash Command', 'HIGH', 'excessive_agency', AST.AST03,
    'The allowlist explicitly permits a destructive or remote-access command.', 'Move dangerous commands to the deny list.', 'AST03:2026', 'dangerous-bash')
];

const matchToolAllow = (entry: string): PatternRule | undefined => {
  if (/\bBash\s*\(\s*\*\s*\)/i.test(entry)) {
    return toolAllowRules[0];
  }
  if (/\bBash\s*\(\s*sudo\s/i.test(entry)) {
    return toolAllowRules[1];
  }
  if (/\bWrite\s*\(\s*\*\s*\)/i.test(entry)) {
    return toolAllowRules[2];
  }
  if (/\bEdit\s*\(\s*\*\s*\)/i.test(entry)) {
    return toolAllowRules[3];
  }
  if (/\bBash\s*\(\s*(?:rm|chown|ssh|curl|wget|chmod)\s/i.test(entry)) {
    return toolAllowRules[4];
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scanClaudeSettings = (
  document: SecurityDocument,
  options: SecurityEngineOptions,
  cancellation: SecurityCancellation
): SecurityFinding[] => {
  const findings = scanFileMode(document);
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.content);
  } catch {
    return findings.slice(0, options.maxFindings);
  }
  if (!isRecord(parsed)) {
    return findings.slice(0, options.maxFindings);
  }

  cancellation.throwIfCancelled();
  const permissions = isRecord(parsed.permissions) ? parsed.permissions : parsed;
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((entry): entry is string => typeof entry === 'string') : [];
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  for (const entry of allow) {
    const rule = matchToolAllow(entry);
    if (rule !== undefined) {
      findings.push(createFinding(document, rule, lineFor(document.content, entry), 'permissions.allow', `"allow": [..., "${entry}", ...]`));
    }
  }
  if (allow.length > 0 && deny.length === 0) {
    const rule = withDetails('AGT-006', 'No Deny List Configured in Claude Code Settings', 'HIGH', 'excessive_agency', AST.AST03,
      'An allowlist without an explicit deny list leaves dangerous gaps.', 'Add explicit deny entries for destructive and sensitive operations.', 'AST03:2026');
    findings.push(createFinding(document, rule, undefined, 'permissions.deny', '"deny": []  (empty or missing)'));
  }
  const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
  if (allow.length > 0 && !Object.keys(hooks).some((key) => key.toLowerCase() === 'pretooluse')) {
    const rule = withDetails('AGT-007', 'No PreToolUse Security Hook in Claude Code Settings', 'MEDIUM', 'excessive_agency', AST.AST03,
      'Tool calls execute without a runtime policy gate.', 'Add a PreToolUse hook that validates tool calls before execution.', 'AST03:2026');
    findings.push(createFinding(document, rule, undefined, 'hooks', '"hooks": {}  (PreToolUse not configured)'));
  }

  if (parsed.enableAllProjectMcpServers === true) {
    const rule = withDetails('MCP-005', 'MCP Auto-Approve All Project Servers — Trust Boundary Removed', 'CRITICAL', 'mcp_injection', OWASP_WEB,
      'All project MCP servers are approved without operator review.', 'Disable automatic approval and explicitly review each MCP server.');
    findings.push(createFinding(document, rule, lineFor(document.content, 'enableAllProjectMcpServers'), 'enableAllProjectMcpServers', '"enableAllProjectMcpServers": true'));
  }

  const serversValue = parsed.mcpServers ?? parsed.mcp_servers ?? parsed.servers;
  if (isRecord(serversValue)) {
    for (const [serverName, value] of Object.entries(serversValue)) {
      cancellation.throwIfCancelled();
      if (!isRecord(value)) {
        continue;
      }
      const section = `mcpServers.${serverName}`;
      const line = lineFor(document.content, serverName);
      const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [];
      if (args.some((arg) => arg === '-y' || arg === '--yes')) {
        const rule = withDetails('MCP-006', `MCP Server '${serverName}' Installed via npx -y`, 'MEDIUM', 'mcp_injection', OWASP_WEB,
          'Silent package installation increases supply-chain risk.', 'Remove -y/--yes and pin an exact reviewed version.', 'AST02:2026');
        findings.push(createFinding(document, rule, line, section, `"args": ${JSON.stringify(args)}`));
      }
      if (args.some((arg) => /@(?:latest|next|canary|beta|alpha)\b/i.test(arg))) {
        const rule = withDetails('MCP-007', `MCP Server '${serverName}' Without Version Pin`, 'MEDIUM', 'mcp_injection', OWASP_WEB,
          'A floating package tag can load a future compromised release.', 'Pin an exact semantic version and verify its integrity.', 'AST02:2026');
        findings.push(createFinding(document, rule, line, section, `"args": ${JSON.stringify(args)}`));
      }
      const url = typeof value.url === 'string' ? value.url : (typeof value.endpoint === 'string' ? value.endpoint : '');
      if (/^https?:\/\//i.test(url) && !/(?:localhost|127\.0\.0\.1|::1|0\.0\.0\.0)/i.test(url)) {
        const rule = withDetails('MCP-008', `MCP Server '${serverName}' Uses External URL Transport`, 'HIGH', 'mcp_injection', OWASP_WEB,
          'A remote MCP server controls tool descriptions across a network trust boundary.', 'Prefer local stdio transport or authenticate and pin the remote endpoint.');
        findings.push(createFinding(document, rule, line, `${section}.url`, `"url": "${url}"`));
      }
      const env = isRecord(value.env) ? value.env : {};
      for (const [key, envValue] of Object.entries(env)) {
        if (/^(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|NODE_OPTIONS|PYTHONPATH)$/i.test(key)) {
          const rule = withDetails('MCP-009', `MCP Server '${serverName}' Overrides Dangerous Env Variable '${key}'`, 'CRITICAL', 'mcp_injection', OWASP_WEB,
            'Loader and interpreter environment overrides can execute attacker-controlled code.', 'Remove loader and interpreter overrides from MCP configuration.');
          findings.push(createFinding(document, rule, line, `${section}.env`, `"${key}": "${String(envValue)}"`));
        }
        if (/(?:API_KEY|SECRET|PASSWORD|TOKEN|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH_TOKEN|BEARER_TOKEN|OAUTH_TOKEN)$/i.test(key)
          && typeof envValue === 'string' && !/^\$\{?\w+\}?$/.test(envValue.trim())) {
          const rule = withDetails('MCP-011', `Hardcoded Credential in MCP Server '${serverName}' Env — '${key}'`, 'CRITICAL', 'mcp_injection', LLM06,
            'A hardcoded MCP credential can be exposed through source control or the server process.', 'Use an environment-variable reference or secrets manager.');
          findings.push(createFinding(document, rule, line, `${section}.env`, `"${key}": "***"`));
        }
      }
      if (args.some((arg) => ['/', '~', 'C:\\', 'C:/'].includes(arg))) {
        const rule = withDetails('MCP-010', `MCP Server '${serverName}' Configured with Unrestricted Root Path`, 'HIGH', 'mcp_injection', OWASP_WEB,
          'A root or home path grants the MCP server broad filesystem access.', 'Restrict path arguments to the minimum required directory.');
        findings.push(createFinding(document, rule, line, `${section}.args`, `"args": ${JSON.stringify(args)}`));
      }
    }
  }
  return findings.slice(0, options.maxFindings);
};

const activeDefenseRules: PatternRule[] = [
  {
    ...withDetails('CTL-014', 'No Data Leakage Defense', 'CRITICAL', 'active_defense', LLM06,
      'No explicit defense protects system prompts, credentials, or confidential data.',
      'Add an explicit instruction never to reveal system prompts, credentials, or confidential data.'),
    pattern: new RegExp([
      '(?:do\\s+not|never|must\\s+not)\\s+(?:reveal|disclose|share|output|leak|include)\\b',
      '.{0,80}(?:system\\s+prompt|instructions?|internal|confidential|private)|',
      '(?:protect|guard|prevent)\\s+.{0,20}(?:data\\s+leakage?|leaking|disclosure)|',
      'sensitive\\s+.{0,20}(?:must\\s+not|never|do\\s+not)\\s+.{0,20}(?:leave|exit|be\\s+shared)|',
      'defense\\s+instruction\\s*:'
    ].join(''), 'i')
  },
  {
    ...withDetails('CTL-015', 'No Role Boundary Defense', 'HIGH', 'active_defense', LLM01,
      'No instruction requires the agent to preserve its assigned identity and role.',
      'Require the agent to maintain its assigned role and reject identity or persona changes.'),
    pattern: new RegExp([
      '(?:maintain|preserve|keep)\\s+.{0,20}(?:your\\s+)?role\\b|',
      '(?:do\\s+not|never|must\\s+not)\\s+.{0,20}(?:change|switch|adopt|assume)\\s+',
      '.{0,20}(?:role|persona|identity)|',
      '(?:stay|remain)\\s+(?:in\\s+)?(?:your\\s+)?(?:role|persona|character)|',
      'resist\\s+.{0,20}(?:role|persona|identity)\\s+.{0,20}(?:change|switch|hijack)'
    ].join(''), 'i')
  },
  {
    ...withDetails('CTL-016', 'No Social Engineering Defense', 'MEDIUM', 'active_defense', OWASP_WEB,
      'No instruction resists urgency, coercion, emotional pressure, or false authority.',
      'Apply the same security policy regardless of urgency, pressure, or claimed authority.'),
    pattern: new RegExp([
      '(?:do\\s+not|never|must\\s+not)\\s+.{0,30}',
      '(?:emotional\\s+manipulat|coercive|urgent(?:ly)?|pressured?|threat(?:en)?)|',
      '(?:ignore|disregard)\\s+.{0,20}(?:emotional|social)\\s+.{0,20}(?:pressure|urgency)|',
      'resist\\s+.{0,20}social\\s+engineering|',
      'if\\s+(?:the\\s+)?user\\s+(?:claims?|says?|insists?)\\s+.{0,30}',
      '(?:urgent|emergency|critical|must|immediately)'
    ].join(''), 'i')
  },
  {
    ...withDetails('CTL-017', 'No Unicode / Encoding Attack Defense', 'MEDIUM', 'active_defense', LLM01,
      'No instruction rejects hidden Unicode, homoglyph, bidi, or encoded instructions.',
      'Normalize input and reject zero-width, bidi override, and homoglyph-based hidden instructions.'),
    pattern: new RegExp([
      '(?:zero.?width|unicode|homoglyph|lookalike|RTL|right.to.left)\\s+',
      '.{0,20}(?:character|char|text|attack|bypass|inject)|',
      '(?:normalize|reject|strip)\\s+.{0,20}(?:unicode|encoding|zero.?width)|',
      '(?:do\\s+not|never)\\s+.{0,20}(?:render|execute|follow)\\s+.{0,20}',
      '(?:hidden|invisible|encoded)\\s+(?:text|instruction|command)'
    ].join(''), 'i')
  },
  {
    ...withDetails('CTL-018', 'No Output Control / Weaponization Defense', 'MEDIUM', 'active_defense', OWASP_WEB,
      'No instruction validates output or rejects harmful and weaponized content.',
      'Reject harmful output and validate or sanitize responses before returning them.'),
    pattern: new RegExp([
      '(?:do\\s+not|never|must\\s+not)\\s+.{0,30}(?:generat|produc|creat|output|write)\\s+',
      '.{0,30}(?:malware|exploit|malicious\\s+code|harmful\\s+content|weapon)|',
      '(?:refuse|reject|decline)\\s+.{0,20}(?:harmful|malicious|dangerous|illegal)\\s+',
      '.{0,20}(?:request|content|instruction|code)|',
      'output\\s+.{0,20}(?:must\\s+be|should\\s+be|is)\\s+.{0,20}(?:sanitized|filtered|safe)|',
      '(?:verify|validate|check)\\s+.{0,20}(?:output|response)\\s+',
      '.{0,20}(?:before\\s+(?:sending|returning|displaying))'
    ].join(''), 'i')
  },
  {
    ...withDetails('CTL-019', 'No Abuse Prevention Defense', 'LOW', 'active_defense', OWASP_WEB,
      'No instruction detects or limits flooding, spam, misuse, or resource exhaustion.',
      'Add abuse detection, throttling, and blocking behavior for repeated or excessive requests.'),
    pattern: new RegExp([
      '(?:rate\\s+limit|throttle|quota)\\s+.{0,20}(?:abuse|misuse|spam|flood)|',
      '(?:detect|prevent|block)\\s+.{0,20}(?:abuse|misuse|spam|automated)|',
      '(?:do\\s+not|never)\\s+.{0,30}(?:spam|flood|abuse|misuse|overload)|',
      '(?:suspicious|anomalous)\\s+.{0,20}(?:activity|pattern|request)\\s+',
      '.{0,20}(?:block|reject|report|alert)'
    ].join(''), 'i')
  }
];
const packDigest = `sha256:${createHash('sha256')
  .update([
    ...allRules,
    ...astRules,
    ...toolAllowRules,
    ...activeDefenseRules,
    ...HIGH_IMPACT_LINE_RULES,
    ...HIGH_IMPACT_DOCUMENT_RULES,
    ...INFORMATIONAL_CONTROL_RULES
  ]
    .map((rule) => `${rule.id}:${rule.variantId ?? ''}:${rule.title}:${rule.pattern.source}`)
    .join('\n'))
  .update('claude-settings-structural-v1')
  .digest('hex')}`;

const scanText = (document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation, markdown: boolean): SecurityFinding[] => {
  const parsed = parseSecurityDocument(document.content);
  const configNames = new Set(['CLAUDE.md', 'AGENTS.md', 'SKILL.md']);
  const basename = document.displayPath.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const findings: SecurityFinding[] = configNames.has(basename) ? scanFileMode(document) : [];
  for (const [index, line] of parsed.lines.entries()) {
    cancellation.throwIfCancelled();
    if (line.text.length > 1_048_576) {
      continue;
    }
    for (const rule of markdown ? allRules : [...secretRules, ...hookRules]) {
      const agentConfig = parsed.artifactClass === 'skill' || parsed.artifactClass === 'agent_config';
      if (rule.id === 'AGT-003' && !options.includeLlmControls) {
        continue;
      }
      if (/^AGT-00[1-7]$/.test(rule.id) && !agentConfig) {
        continue;
      }
      if (rule.id === 'AGT-006' || rule.id === 'AGT-007') {
        continue;
      }
      if (rule.category === 'secrets' && safeSecretPlaceholder.test(line.text)) {
        continue;
      }
      if (rule.id === 'SEC-003' && /AKIAIOSFODNN7EXAMPLE/.test(line.text)) {
        continue;
      }
      if (rule.pattern.test(line.text)) {
        const severity = line.inExample && rule.category === 'secrets' ? 'MEDIUM' : (line.inExample && rule.category === 'prompt_injection' ? 'INFO' : rule.severity);
        findings.push(createFinding(document, rule, index + 1, line.section, line.text.trim(), severity, line.inExample ? 'MEDIUM' : 'HIGH'));
        if (rule.category === 'secrets') {
          break;
        }
      }
    }
    if (markdown && !line.inCodeBlock && !line.inExample) {
      for (const rule of astRules) {
        if (rule.pattern.test(line.text)) {
          const severity = rule.variantId === 'loader-directory-write' && /\.github\/skills\//i.test(line.text)
            ? 'CRITICAL'
            : rule.severity;
          const confidence = rule.variantId === 'collapsed-details' ? 'LOW' : (rule.severity === 'MEDIUM' ? 'MEDIUM' : 'HIGH');
          findings.push(createFinding(document, rule, index + 1, line.section, line.text.trim(), severity, confidence));
        }
      }
    }
  }
  if (markdown) {
    findings.push(
      ...scanContextualLineRules(document, parsed, cancellation),
      ...scanContextualDocumentRules(document, parsed),
      ...scanStructuredMarkdownRules(document, parsed)
    );
  }
  if (markdown && (parsed.artifactClass === 'skill' || parsed.artifactClass === 'agent_config')) {
    const allowedTools = /allowed-tools|permissions?\.allow/i.test(document.content);
    const denyTools = /deny-tools|permissions?\.deny|denied-tools/i.test(document.content);
    const preToolUse = /PreToolUse/i.test(document.content);
    if (allowedTools && !denyTools) {
      const rule = makeRule('AGT-006', 'No Tool Deny List Configured', 'HIGH', /allowed-tools|permissions?\.allow/i, 'excessive_agency', OWASP_WEB);
      findings.push(createFinding(document, rule, undefined, undefined, 'Allowed tools are declared without a deny list.'));
    }
    if (allowedTools && !preToolUse) {
      const rule = makeRule('AGT-007', 'No PreToolUse Security Hook Configured', 'MEDIUM', /allowed-tools|permissions?\.allow/i, 'excessive_agency', OWASP_WEB);
      findings.push(createFinding(document, rule, undefined, undefined, 'Allowed tools are declared without a PreToolUse hook.'));
    }
  }
  if (markdown) {
    const entropyRule = makeRule('SEC-013', 'High-Entropy String — Potential Secret', 'HIGH', assignment, 'secrets', LLM06);
    for (const [index, line] of parsed.lines.entries()) {
      assignment.lastIndex = 0;
      let match = assignment.exec(line.text);
      while (match !== null) {
        if (entropy(match[1]) > 4.5 && !/^([0-9a-f]{8}-){4}[0-9a-f]{12}$/i.test(match[1])) {
          findings.push({ ...createFinding(document, entropyRule, index + 1, line.section, line.text.trim(), 'HIGH', 'MEDIUM') });
        }
        match = assignment.exec(line.text);
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
    if (parsed.artifactClass === 'skill') {
      const frontmatterName = /^name:\s*(.+)$/im.exec(parsed.frontmatter)?.[1]?.trim() ?? '';
      if (/[\u0400-\u04FF\u0370-\u03FF]/.test(frontmatterName)) {
        const findingRule = withDetails('SKL-004', 'Insecure Metadata — Confusable Homoglyph Characters in Skill Name (AST04)', 'HIGH',
          'metadata_injection', AST.AST04, 'Confusable characters can impersonate a trusted skill name.',
          'Use ASCII Latin characters in the skill name.', 'AST04:2026', 'homoglyph-name');
        findings.push(createFinding(document, findingRule, 1, 'YAML Frontmatter', `name: ${frontmatterName}`, 'HIGH', 'MEDIUM'));
      }
      if (/\b(?:anthropic|openai|chatgpt|claude|github|microsoft|google|gemini|copilot|amazon|aws)\b/i.test(frontmatterName)) {
        const findingRule = withDetails('SKL-004', 'Insecure Metadata — Brand Term in Skill Name (AST04)', 'LOW',
          'metadata_injection', AST.AST04, 'A brand term in a skill name can signal impersonation or typosquatting.',
          'Verify publisher ownership or remove the brand term.', 'AST04:2026', 'brand-name');
        findings.push(createFinding(document, findingRule, 1, 'YAML Frontmatter', `name: ${frontmatterName}`, 'LOW', 'MEDIUM'));
      }
      if (!options.skipInfoControls && !/^\s*version\s*:/im.test(parsed.frontmatter)) {
        const findingRule = withDetails('SKL-007', 'Update Drift — Missing Skill Version Metadata (AST07)', 'INFO',
          'missing_control', AST.AST07, 'Without a version, consumers cannot detect update drift or identify affected releases.',
          'Add a semantic version field to the skill frontmatter.', 'AST07:2026', 'missing-version');
        findings.push({
          ...createFinding(document, findingRule, 1, 'YAML Frontmatter', "No 'version:' field found in skill manifest", 'INFO'),
          isInfoControl: true
        });
      }
      if (/\bplatforms?\s*:\s*\[/i.test(document.content)) {
        for (const [index, line] of parsed.lines.entries()) {
          if (!line.inCodeBlock && !line.inExample && /\b(?:Bash|Read|Write|Edit)\s*\(\s*\*{1,2}\s*\)/i.test(line.text)) {
            const findingRule = withDetails('SKL-010', 'Cross-Platform Skill — Client-Specific Permission Syntax (AST10)', 'MEDIUM',
              'cross_platform_risk', AST.AST10, 'Client-specific permission syntax can change meaning across declared platforms.',
              'Use a platform-neutral permission model or explicit per-platform mappings.', 'AST10:2026', 'client-specific-permission');
            findings.push(createFinding(document, findingRule, index + 1, line.section, line.text.trim(), 'MEDIUM', 'MEDIUM'));
          }
        }
      }
    }
    if (options.includeLlmControls && parsed.artifactClass !== 'general_md') {
      for (const control of activeDefenseRules) {
        if (!control.pattern.test(document.content)) {
          findings.push({ ...createFinding(document, control, undefined, undefined, 'Security control absent for this artifact.', control.severity, 'MEDIUM'), isInfoControl: false });
        }
      }
      if (!options.skipInfoControls) {
        const info = makeRule('CTL-001', 'No System Prompt Confidentiality Instruction', 'INFO', /never reveal.{0,100}(?:system prompt|instructions?|credentials?)/i, 'missing_control', LLM06);
        if (!info.pattern.test(document.content)) {
          findings.push({ ...createFinding(document, info, undefined, undefined, 'Security control absent for this artifact.'), isInfoControl: true });
        }
        for (const control of INFORMATIONAL_CONTROL_RULES) {
          if (!patternMatches(control.pattern, document.content)) {
            findings.push({
              ...createFinding(
                document,
                contextualPatternRule(control),
                undefined,
                undefined,
                'Security control absent for this artifact.',
                control.severity,
                'MEDIUM'
              ),
              isInfoControl: true
            });
          }
        }
      }
    }
  }
  const limited = findings.slice(0, options.maxFindings);
  if (!documentationOnly.test(basename)) {
    return limited;
  }
  return limited.map((finding) => finding.severity === 'INFO'
    ? finding
    : {
      ...finding,
      severity: 'INFO',
      risk: `${finding.risk} [Severity downgraded to INFO because this file is documentation-only.]`
    });
};

export class RuleBasedSecurityScanEngine implements SecurityScanEngine {
  public readonly descriptor: SecurityEngineDescriptor = { id: 'builtin', version: '1.0.0', rulePackId: 'md-security-scanner', rulePackVersion: '1.10.9-compatible', rulePackDigest: packDigest };
  public readonly capabilities: SecurityEngineCapabilities = { contentTypes: ['text/markdown', 'application/json'], locations: 'line', supportsFileMode: false, supportsCancellation: true };
  public scanDocument(document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation): Promise<readonly SecurityFinding[]> {
    return Promise.resolve().then(() => isClaudeSettings(document.displayPath)
      ? scanClaudeSettings(document, options, cancellation)
      : scanText(document, options, cancellation, true));
  }
}
