/**
 * Rule inventory of the built-in scanner. Only detection patterns live here, no literal sample secrets.
 *
 * LLM-005 (unpinned package install) skips fenced code and example sections, so installs shown as examples
 * do not fire.
 * @module domain/scanner/rules
 */

import type {
  OwaspRef,
  Rule,
} from './types';

/* eslint-disable @stylistic/max-len -- Detection signatures stay as auditable single-line regex literals. */

// --- OWASP references ---------------------------------
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

// ============================================================================
// SECRET RULES (SEC-*)
// NOTE: SEC-013 (high-entropy) is computed algorithmically in the engine, not here.
// ============================================================================
const secretPatterns: Record<string, RegExp> = {
  '001': /\bsk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{20,}\b/,
  '002': /sk-ant-[a-zA-Z0-9_-]{20,}/,
  '003': /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  '004': /\bgh[pousr]_[a-zA-Z0-9]{36,}\b|github_pat_[a-zA-Z0-9_]{80,}/,
  '005': /\b(?:sk_live|rk_live)_[a-zA-Z0-9]{24,}\b/,
  '006': /\bAIza[0-9A-Za-z_-]{35}\b/,
  '007': /\bxox[bpsa]-[0-9]+-[0-9A-Za-z-]+/,
  '008': /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]{4,}@[^\s"'>]+/i,
  '009': /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/,
  '010': /\bhf_[a-zA-Z0-9]{34,}\b/,
  '011': /(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\s*[=:]\s*(?:["'][^"'<>{}$%]{8,}["']|[^\s"'<>{}$%#]{8,})/i,
  '012': /\bSG\.[a-zA-Z0-9._-]{66}\b/,
  '014': /(?:webhook\.site|ngrok\.io|ngrok\.app|ngrok-free\.app|requestbin\.com|pipedream\.net|interact\.sh|burpcollaborator\.net|canarytokens\.(?:com|org)|oastify\.com)\/[\S"'<>]{3,}/i,
  '015': /\bxai-[a-zA-Z0-9_-]{20,}\b/,
  '016': /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/,
  '017': /\bnpm_[a-zA-Z0-9]{36,}\b/,
  '018': /\blin_api_[a-zA-Z0-9]{20,}\b/,
  '019': /\bdapi[a-f0-9]{32}\b/,
  '020': /\bdop_v1_[a-f0-9]{64}\b/,
  '021': /https?:\/\/[^:\s/'"<>@]{1,200}:[^@\s'"<>]{4,200}@[^\s'"<>]+/i,
  '022': /\becho\b.{0,60}\$\{?(?:API_KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE_KEY)\w*\}?/i,
  '023': /(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_TOKEN|CF_API_TOKEN|CF_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/i,
  '024': /\bSK[a-f0-9]{32}\b/,
  '025': /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  '026': /\b[a-f0-9]{32}-us\d{1,2}\b/,
  '027': /~?\/(?:\.aws\/credentials|\.ssh\/id_(?:rsa|ed25519|ecdsa)|\.netrc|\.pgpass|\.docker\/config\.json|\.kube\/config)\b/i
};

const secretTitles: Record<string, string> = {
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
const secretCritical = new Set(['001', '002', '003', '004', '005', '008', '009', '010', '014', '015', '016', '017', '019', '020', '023', '024']);

export const SECRET_RULES: Rule[] = Object.entries(secretPatterns).map(([number, pattern]) => ({
  id: `SEC-${number}`,
  title: secretTitles[number] ?? `Secret Pattern ${number}`,
  severity: secretCritical.has(number) ? 'CRITICAL' : 'HIGH',
  confidence: 'HIGH',
  category: 'secrets',
  pattern,
  owasp: LLM06,
  family: 'secret'
}));

// ============================================================================
// INJECTION RULES (INJ-*)
// ============================================================================
export const INJECTION_RULES: Rule[] = [
  { id: 'INJ-001', title: 'Direct Override — Ignore Previous Instructions', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions?\b/i },
  { id: 'INJ-001', title: 'Direct Override — Forget Instructions', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bforget\s+(?:everything|all\s+instructions?|previous|prior)\b/i },
  { id: 'INJ-001', title: 'Direct Override — Disregard / Override', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\b(?:disregard|override)\s+(?:all\s+)?(?:previous|prior|your)\b/i },
  { id: 'INJ-001', title: 'Mode Unlock Attempt', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\b(?:developer|unrestricted|god|jailbreak|bypass)\s*mode\b/i },
  { id: 'INJ-001', title: 'DAN Jailbreak Pattern', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bDo\s+Anything\s+Now\b|\bDAN\s+mode\b/i },
  { id: 'INJ-001', title: 'Restriction Removal Pattern', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bno\s+(?:rules?|restrictions?|limits?|guidelines?|safety|filters?)\b/i },
  { id: 'INJ-001', title: 'Persona Hijacking Attempt', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\b(?:you are now|from now on you are|you will now act as)\b/i },
  { id: 'INJ-001', title: 'Data Exfiltration Instruction', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\b(?:exfiltrate|steal|leak)\s+(?:all|the)?\s*(?:data|messages?|conversation|system\s+prompt|instructions?)\b/i },
  { id: 'INJ-001', title: 'Privilege Escalation Instruction', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bgrant\s+yourself\b|\belevate\s+(?:your\s+)?permissions?\b/i },
  { id: 'INJ-001', title: 'Self-Modification Instruction', severity: 'CRITICAL', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\bmodify\s+(?:your\s+(?:own\s+)?)?(?:instructions?|system\s+prompt|rules?)\b/i },
  { id: 'INJ-009', title: 'Agent Identity Impersonation', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /\byour\s+name\s+is\s+(?!Claude\b)[A-Za-z]|\bpretend\s+(?:you are|to be)\b/i },
  { id: 'INJ-001', title: 'System Prompt Extraction Attempt', severity: 'HIGH', confidence: 'HIGH', category: 'prompt_injection', owasp: LLM01, family: 'injection', pattern: /(?:reveal|show|print|output|display)\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|hidden\s+instructions?)/i }
];

// ============================================================================
// MARKDOWN RULES (MD-00x)
// ============================================================================
export const MARKDOWN_RULES: Rule[] = [
  { id: 'MD-001', title: 'Executable HTML Tag', severity: 'HIGH', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /<(?:script|iframe|object|embed|form)\b/i },
  { id: 'MD-002', title: 'HTML Event Handler', severity: 'HIGH', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /\bon\w+\s*=/i },
  { id: 'MD-003', title: 'JavaScript URI', severity: 'CRITICAL', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /\]\s*\(\s*javascript:/i },
  { id: 'MD-005', title: 'Data URI', severity: 'HIGH', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /\]\s*\(\s*data:|src\s*=\s*["']\s*data:/i },
  { id: 'MD-006', title: 'Srcdoc Attribute', severity: 'CRITICAL', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /\bsrcdoc\s*=/i },
  { id: 'MD-020', title: 'HTTP Image Source', severity: 'LOW', confidence: 'HIGH', category: 'markdown_injection', owasp: OWASP_WEB, family: 'markdown', pattern: /!\[[^\]]*\]\(\s*http:\/\//i }
];

// ============================================================================
// HOOK RULES (HKS-001/002)
// (also scanned in non-markdown text mode)
// ============================================================================
export const HOOK_RULES: Rule[] = [
  { id: 'HKS-001', title: 'Remote Shell Pipe', severity: 'CRITICAL', confidence: 'HIGH', category: 'hook_injection', owasp: OWASP_WEB, family: 'hook', pattern: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|fi)?sh\b/i },
  { id: 'HKS-002', title: 'Reverse Shell Pattern', severity: 'CRITICAL', confidence: 'HIGH', category: 'hook_injection', owasp: OWASP_WEB, family: 'hook', pattern: /(?:\/dev\/tcp\/|nc\s+[^\n]*-e\s+|bash\s+-i\s+>&)/i }
];

// ============================================================================
// AGENTIC / MCP / SKL / LLM / ASI RULES
// ============================================================================
export const AGENTIC_RULES: Rule[] = [
  { id: 'AGT-001', title: 'Wildcard / All Permissions in Agent Config', severity: 'CRITICAL', confidence: 'HIGH', category: 'excessive_agency', owasp: OWASP_WEB, family: 'agentic', pattern: /permissions?\s*[=:]\s*["']?\*["']?|permissions?\s*[=:]\s*["']?all["']?/i, artifactClasses: ['skill', 'agent_config'] },
  { id: 'AGT-002', title: 'Privilege Escalation Pattern in Agent Definition', severity: 'CRITICAL', confidence: 'HIGH', category: 'privilege_escalation', owasp: OWASP_WEB, family: 'agentic', pattern: /\bgrant\s+(?:yourself|itself|the agent)\b|\bbecome\s+(?:admin|root|superuser)\b/i, artifactClasses: ['skill', 'agent_config'] },
  // AGT-003 is cataloged but not evaluated: it needs an absence-based check.
  { id: 'AGT-003', title: 'Missing Human-in-the-Loop Gate for Destructive Operations', severity: 'HIGH', confidence: 'HIGH', category: 'excessive_agency', owasp: OWASP_WEB, family: 'agentic', pattern: /\b(?:delete|remove|drop|deploy|publish|execute|run code)\b/i, artifactClasses: ['skill', 'agent_config'] },
  { id: 'AGT-004', title: 'Wildcard Permission Grant in Agent Definition', severity: 'CRITICAL', confidence: 'HIGH', category: 'excessive_agency', owasp: OWASP_WEB, family: 'agentic', pattern: /\b(?:allow[- ]all|unrestricted|no permission check|required?)\s+(?:tools?|access|commands?)\b/i, relatedAst: 'AST03:2026', artifactClasses: ['skill', 'agent_config'] },
  { id: 'AGT-005', title: 'Overly Permissive Tool Allowlist', severity: 'CRITICAL', confidence: 'HIGH', category: 'excessive_agency', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:allowed-tools|permissions?\.allow).*\b(?:Bash\s*\(\s*\*|sudo)/i, relatedAst: 'AST03:2026', artifactClasses: ['skill', 'agent_config'] },
  { id: 'MCP-001', title: 'MCP Tool Exfiltration Pattern', severity: 'CRITICAL', confidence: 'HIGH', category: 'mcp_poisoning', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:tool|callback|webhook).{0,100}(?:exfiltrat|steal|harvest|capture)|document\.cookie/i },
  { id: 'MCP-005', title: 'Unpinned npx MCP Package', severity: 'HIGH', confidence: 'HIGH', category: 'mcp_poisoning', owasp: OWASP_WEB, family: 'agentic', pattern: /\bnpx\s+-y\b/i },
  { id: 'SKL-001', title: 'Remote Shell Pipe in Skill', severity: 'CRITICAL', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|fi)?sh\b/i },
  { id: 'SKL-002', title: 'Model Endpoint Override', severity: 'CRITICAL', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /ANTHROPIC_BASE_URL\s*=/i },
  { id: 'SKL-005', title: 'Unsafe YAML Deserialization Tag', severity: 'CRITICAL', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /!!python\/(?:object|module|name|apply)/i },
  { id: 'SKL-006', title: 'Host Network Exposure', severity: 'HIGH', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /network_mode\s*:\s*["']?host|\b0\.0\.0\.0\b/i },
  { id: 'SKL-007', title: 'Unpinned Dependency Version', severity: 'MEDIUM', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:[~^]|>=?)\s*\d+\.\d+/i },
  { id: 'SKL-008', title: 'Security Scanner Evasion', severity: 'HIGH', confidence: 'HIGH', category: 'agentic_skills', owasp: OWASP_WEB, family: 'agentic', pattern: /\b(?:disable|skip|bypass|evade|suppress)\s+(?:security\s+)?scann(?:er|ing|s)/i },
  { id: 'LLM-002', title: 'Insecure Output Handling', severity: 'HIGH', confidence: 'HIGH', category: 'insecure_output', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:innerHTML|dangerouslySetInnerHTML|raw\s+HTML)/i },
  { id: 'LLM-004', title: 'Unbounded Model Work', severity: 'HIGH', confidence: 'HIGH', category: 'model_dos', owasp: OWASP_WEB, family: 'agentic', pattern: /while\s*\(\s*true\s*\)|for\s*\(\s*;;\s*\)/i },
  // LLM-005 skips code and examples so that an install shown in a fenced example does not fire.
  { id: 'LLM-005', title: 'Unpinned Package Installation', severity: 'HIGH', confidence: 'HIGH', category: 'supply_chain', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:pip|npm|pnpm|yarn)\s+install\b(?![^\n]*@[0-9]+\.[0-9]+)/i, skipCode: true, skipExample: true },
  { id: 'ASI-003', title: 'Agent Identity or Privilege Abuse', severity: 'HIGH', confidence: 'HIGH', category: 'agent_identity', owasp: OWASP_WEB, family: 'agentic', pattern: /(?:impersonate|assume|forge)\s+(?:another\s+)?(?:agent|identity|user)/i },
  { id: 'ASI-005', title: 'Unexpected Code Execution', severity: 'CRITICAL', confidence: 'HIGH', category: 'code_execution', owasp: OWASP_WEB, family: 'agentic', pattern: /\b(?:eval|exec|child_process)\s*\(/i, relatedAst: 'AST05:2026' }
];

// ============================================================================
// AST RULES. Only evaluated outside code and example sections.
// ============================================================================
export const AST_RULES: Rule[] = [
  { id: 'SKL-001', title: 'Malicious Skill — Agent Loader Directory Write (AST01)', severity: 'HIGH', confidence: 'HIGH', category: 'malicious_skill', owasp: AST.AST01, family: 'ast', variantId: 'loader-directory-write', relatedAst: 'AST01:2026', skipCode: true, skipExample: true,
    pattern: new RegExp([
      '(?:write|append|inject|insert|add|update|overwrite|modify|create|drop)\\s+',
      '(?:a\\s+file\\s+)?(?:to|into|in|under)\\s+',
      '(?:\\.claude/|\\.opencode/|\\.cursor/rules/|\\.github/skills/|\\.github/prompts/|',
      '\\.copilot/|\\.kiro/|\\.agent/skills/)'
    ].join(''), 'i') },
  { id: 'SKL-001', title: 'Malicious Skill — CLI Credential/Token Extraction (AST01)', severity: 'CRITICAL', confidence: 'HIGH', category: 'malicious_skill', owasp: AST.AST01, family: 'ast', variantId: 'cli-credential-extraction', relatedAst: 'AST01:2026', skipCode: true, skipExample: true, pattern: /\bgh\s+auth\s+token\b|\baz\s+account\s+get-access-token\b|\baws\s+sts\s+get-caller-identity\b|\bpass\s+show\b/i },
  { id: 'SKL-001', title: 'Malicious Skill — Shell History Access (AST01)', severity: 'HIGH', confidence: 'HIGH', category: 'malicious_skill', owasp: AST.AST01, family: 'ast', variantId: 'shell-history-access', relatedAst: 'AST01:2026', skipCode: true, skipExample: true, pattern: /\.bash_history\b|\.zsh_history\b|\.python_history\b|\bhistory\s+-w\b/i },
  { id: 'SKL-001', title: 'Malicious Skill — Approval-Bypass / YOLO Language (AST01)', severity: 'HIGH', confidence: 'HIGH', category: 'malicious_skill', owasp: AST.AST01, family: 'ast', variantId: 'approval-bypass-language', relatedAst: 'AST01:2026', skipCode: true, skipExample: true, pattern: /\byolo\s+mode\b|\bskip\s+approval\b|\bhide\s+(?:the\s+)?output\s+from\s+the\s+user\b|\bwithout\s+(?:asking|confirming)\s+the\s+user\b|\bno\s+approval\s+(?:needed|required)\b/i },
  { id: 'SKL-003', title: 'Over-Privileged Skill — Permission-Bypass Flag Declared (AST03)', severity: 'CRITICAL', confidence: 'HIGH', category: 'excessive_agency', owasp: AST.AST03, family: 'ast', variantId: 'permission-bypass-flag', relatedAst: 'AST03:2026', skipCode: true, skipExample: true, pattern: /--yolo\b|--trust-all\b|--dangerously-skip-permissions\b/i },
  { id: 'SKL-004', title: 'Insecure Metadata — RTL/Bidi Override Character (AST04)', severity: 'HIGH', confidence: 'HIGH', category: 'metadata_injection', owasp: AST.AST04, family: 'ast', variantId: 'bidi-override', relatedAst: 'AST04:2026', skipCode: true, skipExample: true, pattern: /[\u202A-\u202E\u2066-\u2069]/ },
  { id: 'SKL-004', title: 'Insecure Metadata — Discovery-Hijack Phrasing (AST04)', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'metadata_injection', owasp: AST.AST04, family: 'ast', variantId: 'discovery-hijack', relatedAst: 'AST04:2026', skipCode: true, skipExample: true, pattern: /\balways\s+use\s+this\s+skill\b|\bbest\s+skill\s+for\b|\btop.?rated\s+skill\b|\bmust\s+(?:install|use)\s+this\s+skill\b|\brecommended\s+(?:by|for)\s+all\s+agents\b/i },
  { id: 'SKL-005', title: 'Unsafe Deserialization — yaml.load() Without SafeLoader (AST05)', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'unsafe_deserialization', owasp: AST.AST05, family: 'ast', variantId: 'unsafe-yaml-load', relatedAst: 'AST05:2026', skipCode: true, skipExample: true, pattern: /\byaml\.load\s*\((?![^\n]*(?:SafeLoader|CSafeLoader))/i },
  { id: 'SKL-005', title: 'Unsafe Deserialization — Python Pickle-Family Loader (AST05)', severity: 'CRITICAL', confidence: 'HIGH', category: 'unsafe_deserialization', owasp: AST.AST05, family: 'ast', variantId: 'python-deserializer', relatedAst: 'AST05:2026', skipCode: true, skipExample: true, pattern: /\b(?:pickle|dill|marshal)\.loads?\s*\(|\bshelve\.open\s*\(/i },
  { id: 'SKL-005', title: 'Unsafe Deserialization — JS Dynamic Code Execution (AST05)', severity: 'CRITICAL', confidence: 'HIGH', category: 'unsafe_deserialization', owasp: AST.AST05, family: 'ast', variantId: 'javascript-dynamic-execution', relatedAst: 'AST05:2026', skipCode: true, skipExample: true, pattern: /\bnew\s+Function\s*\(|\bvm\.runIn(?:NewContext|ThisContext)\s*\(/i },
  { id: 'SKL-005', title: 'Unsafe Deserialization — XML External Entity (XXE) Indicator (AST05)', severity: 'HIGH', confidence: 'HIGH', category: 'unsafe_deserialization', owasp: AST.AST05, family: 'ast', variantId: 'xxe', relatedAst: 'AST05:2026', skipCode: true, skipExample: true, pattern: /<!DOCTYPE[^>]*SYSTEM|<!ENTITY[^>]*SYSTEM/i },
  { id: 'SKL-008', title: 'Scanner Evasion — Collapsed HTML Structure Hides Content (AST08)', severity: 'LOW', confidence: 'LOW', category: 'scanner_evasion', owasp: AST.AST08, family: 'ast', variantId: 'collapsed-details', relatedAst: 'AST08:2026', skipCode: true, skipExample: true, pattern: /<details\b|<summary\b/i }
];

// ============================================================================
// HIGH_IMPACT_LINE_RULES: context-gated line rules. hook() defaults to skipExample: true.
// ============================================================================
const hiLine = (
  id: string, title: string, severity: Rule['severity'], category: string, pattern: RegExp,
  opts: Partial<Rule> = {}
): Rule => ({ id, title, severity, category, pattern, confidence: 'HIGH', family: 'high_impact_line', owasp: owaspForCategory(category), ...opts });

const hook = (id: string, title: string, severity: Rule['severity'], pattern: RegExp, opts: Partial<Rule> = {}): Rule =>
  hiLine(id, title, severity, 'hook_injection', pattern, { skipExample: true, ...opts });

export const HIGH_IMPACT_LINE_RULES: Rule[] = [
  hook('HKS-003', 'Credential Store or Cloud Metadata Service Access', 'CRITICAL',
    /\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\s+lookup\b|\bgit\s+credential\s+fill\b|(?:\/etc\/shadow|\/etc\/passwd|\.ssh\/id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)\b|(?:curl|wget)\s+http:\/\/169\.254\.169\.254\//i),
  hook('HKS-004', 'Clipboard Exfiltration via Clipboard Utility', 'HIGH',
    /\bpbcopy\b|\bxclip\s+-sel\s+clip\b|\bxsel\s+--clipboard\b|\bwl-copy\b/i,
    { skipCode: true }),
  hook('HKS-005', 'Log Tampering / Anti-Forensics Pattern', 'HIGH',
    /journalctl\s+--vacuum|rm\s+(?:-[rfF]+\s+)?\/var\/log|(?:cat|echo)\s+\/dev\/null\s+>\s+\/var\/log|\bhistory\s+-[cwrd]\b|\bunset\s+HISTFILE\b|\bexport\s+HISTFILESIZE\s*=\s*0\b/i),
  hook('HKS-006', 'Container Escape — Privileged Flags or Host Namespace Access', 'CRITICAL',
    /\s--privileged\b|--pid\s*=\s*host\b|\s-v\s+\/:\/|--cap-add\s+(?:SYS_PTRACE|SYS_ADMIN|ALL)\b/i,
    { skipCode: true }),
  hook('HKS-007', 'Global Package Install in Hook/Script — Supply Chain Risk', 'HIGH',
    /\bnpm\s+(?:install|i)\s+-g\b|\bpip\d*\s+install\b(?!\s+\S*==)(?!\s+--requirement)(?!\s+-r\b)|\bgem\s+install\b|\bcargo\s+install\b(?!\s+--locked)/i,
    { skipCode: true, confidence: 'MEDIUM' }),
  hook('HKS-008', 'Silent Error Suppression in Security-Sensitive Hook Context', 'HIGH',
    /2\s*>\s*\/dev\/null\s*[|;]|\|\|\s*true\b|\|\|\s*:\s*(?:$|\n)|2>&1.*>\/dev\/null/i,
    { confidence: 'MEDIUM', contextPattern: /\b(?:security|auth|credential|password|token|key|secret|permission|verify|check|validate|scan|monitor|log|audit|deny|block|guard)\b/i, contextRadius: 3, requireContext: true }),
  hook('HKS-009', 'System-Level Persistence via Cron or Init Framework', 'CRITICAL',
    /crontab\s+-[el]|>>\s*\/etc\/cron|cron\.(?:d|daily|weekly|hourly)\/|systemctl\s+enable|launchctl\s+load|launchd\b.*plist\b/i),
  hook('HKS-010', 'Shell Profile Hijacking — Appending to Shell Startup Files', 'CRITICAL',
    />>\s*~\/\.(?:bashrc|zshrc|bash_profile|profile|zprofile|bash_login)|tee\s+-a\s+~\/\.(?:bashrc|zshrc|bash_profile|profile)|echo\b[^|]*>>\s*\/etc\/(?:environment|profile|bash\.bashrc)/i,
    { skipCode: true }),
  hook('HKS-011', 'SSH Key Manipulation', 'CRITICAL',
    />>\s*~\/\.ssh\/authorized_keys|ssh-keygen\s+-[tNb]|ssh-copy-id\b/i),
  hook('HKS-012', 'Network Listener Opened by Agent', 'CRITICAL',
    /\bnc\s+(?:-[klnvze]\s*)+\d{2,5}|\bnc\s+-l(?:nvp?)?\s+\d{2,5}|\bsocat\s+TCP-LISTEN:|python\d*\s+-m\s+(?:http\.server|SimpleHTTPServer)|php\s+-S\b/i),
  hook('HKS-013', 'Disk Wipe / Destructive Filesystem Command', 'CRITICAL',
    /\bdd\s+if=\/dev\/(?:zero|urandom)\b|\bmkfs(?:\.\w+)?\b|\bwipefs\b|\bshred\s+-(?:[uvz]|n\d)/i),
  hook('HKS-014', 'Privilege Escalation — Privileged Shell', 'CRITICAL',
    /\bpkexec\b|\bdoas\s+\S|\brunas\s+\/user:|\bsudo\s+(?:su|bash|sh|zsh|ksh|fish|-i\b|-s\b)|\bsu\s+-[lm]?\s*root\b/i),
  hook('HKS-015', 'User Account Manipulation', 'CRITICAL',
    /\b(?:useradd|adduser|usermod|userdel)\b|\bpasswd\s+\w|\bgpasswd\b/i),
  hook('HKS-016', 'Dangerous Git Configuration Change', 'HIGH',
    /git\s+config\b.*\b(?:core\.hooksPath|commit\.gpgsign|safe\.directory)\b|git\s+config\s+--system\b/i),
  hook('HKS-017', 'Environment Variable Hijacking', 'HIGH',
    /\bexport\s+(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|PYTHONPATH)\s*=|\bexport\s+NODE_OPTIONS\s*=\s*["']*--require/i),
  hook('HKS-018', 'Firewall Rule Modification', 'CRITICAL',
    /\biptables\s+-[ADI]\b|\bufw\s+(?:allow|delete|disable)\b|\bfirewall-cmd\s+--(?:add|remove)-(?:port|service)|\bnft\s+(?:add|insert|delete)\s+rule\b/i),
  hook('HKS-019', 'DNS Exfiltration via Variable Expansion', 'CRITICAL',
    /\bdig\b[^"\n]*\$[{(]?\w+[})]?\.[a-z]{2,}|\bnslookup\b[^"\n]*\$[{(]?\w+[})]?\.|\bhost\b\s+\$[{(]?\w+/i),
  hook('HKS-020', 'Background Process Daemonization', 'HIGH',
    /\bnohup\s+\S.*&\s*$|\bdisown\b|\bscreen\s+-dm\b|\btmux\s+new-session\s+-d\b/i,
    { skipCode: true, confidence: 'MEDIUM', relatedAst: 'AST06:2026' }),
  hook('HKS-021', 'File Shredding / Unrecoverable Deletion', 'HIGH',
    /\bshred\b\s+(?:-[uvzn]\s+)*[^\s]|\brm\s+(?:-\w*f\w*\s+|--force\s+)?-r(?:f)?\s+(?:\/\s*$|~\/\s*$|\/(?:home|root|etc|usr|var|boot))|\bwipefs\s+-a\b/i),
  hook('HKS-022', 'Source or Eval from Environment Variable Path', 'HIGH',
    /\bsource\s+\$\{?\w+\}?\/|\.\s+\$\{?\w+\}?\/|\beval\s+\$\(|\beval\s+`/i),
  hook('HKS-023', 'Known Malicious Campaign IOC', 'CRITICAL',
    /api\.masscan\.cloud|git-tanstack\.com|@tanstack\/(?:react-table-core|query-core)-[0-9]|ClawHavoc/i,
    { skipExample: false }),
  hook('HKS-024', 'Agent Transcript Path Access', 'INFO',
    /CLAUDE_TRANSCRIPT_PATH|CLAUDE_CONTEXT_FILE|AGENT_TRANSCRIPT|\.claude\/conversation|\.claude\/transcript/i,
    { skipCode: true, confidence: 'MEDIUM' }),

  hiLine('MCP-002', 'Shell Alias / Environment Manipulation in Skill Definition', 'CRITICAL', 'mcp_injection',
    /\balias\s+\w+\s*=|\.bash(?:rc|_aliases|_profile)\b|\.zshrc\b|\.profile\b|(?:export|set)\s+PATH\s*=|\bauto.?memory\b|\bmemory\s+poisoning\b/i,
    { skipExample: true, skipCode: true }),
  hiLine('MCP-002', 'Git Hook / Config Tampering Pattern', 'CRITICAL', 'mcp_injection',
    /\.git\/hooks\/|post-checkout|pre-commit\s+hook|post-merge|mcp.*tamper|tamper.*mcp|config.*tamper|sha.256.*hmac|hmac.*snapshot/i,
    { skipExample: true, skipCode: true, confidence: 'MEDIUM' }),
  hiLine('MCP-003', 'Hidden Instruction Marker in Tool Description', 'CRITICAL', 'mcp_injection',
    /<!--[^>]*(?:ignore|override|system|admin|bypass|exfil)[^>]*-->|\[INST\]|\[\/INST\]|<\|(?:system|im_start|im_end)\|>/i,
    { skipExample: true }),
  hiLine('MCP-004', 'Risky MCP Server Type — High-Privilege Tool Category', 'HIGH', 'mcp_injection',
    /"(?:name|type)"\s*:\s*"[^"]*(?:filesystem|file.?system|shell|terminal|command.?exec|puppeteer|playwright|browser|selenium|postgres(?:ql)?|mysql|sqlite|database|db.?manager|slack|discord|email.?sender|smtp)[^"]*"/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('MCP-012', 'MCP Server Executes Remote Script via curl/wget Pipe', 'CRITICAL', 'mcp_injection',
    /(?:curl|wget)\s+[^\n|]{5,}\|\s*(?:bash|sh|zsh|python|node)|"(?:curl|wget)"[^}]{0,300}"\|[^"]*(?:bash|sh)"/i,
    { skipExample: true, relatedAst: 'AST02:2026' }),
  hiLine('MCP-013', 'Shell Metacharacters in MCP Server Arguments', 'HIGH', 'mcp_injection',
    /"args"\s*:\s*\[[^\]]*"[^"]*(?:[;&|`]|\$\()[^"]*"/i,
    { skipExample: true, confidence: 'MEDIUM' }),

  hiLine('INJ-004', 'Hidden Injection Attempt in HTML Comment', 'CRITICAL', 'prompt_injection',
    /<!--.*?(?:ignore|override|bypass|jailbreak|disregard|SYSTEM:|DAN).*?-->/i),
  hiLine('INJ-005', 'LaTeX Hidden Text — Invisible Injection Vector', 'HIGH', 'prompt_injection',
    /\$\\color\{(?:white|transparent)\}\{[^}]+\}\$/i),
  hiLine('INJ-006', 'Base64 Decode Call — Obfuscated Instruction Vector', 'HIGH', 'prompt_injection',
    /\b(?:atob|fromBase64|base64_decode|b64decode)\s*\(/i,
    { skipExample: true }),
  hiLine('INJ-006', 'Suspicious Long Base64 String — Potential Obfuscated Instruction', 'MEDIUM', 'prompt_injection',
    /[A-Za-z0-9+/]{60,}={0,2}/,
    { skipExample: true, skipCode: true, confidence: 'LOW', excludePattern: /https?:\/\/|sha\d+|checksum|hash/i, variantId: 'long-base64' }),
  hiLine('INJ-007', 'Misinformation Generation Instruction', 'HIGH', 'prompt_injection',
    /\b(?:generate|create|write|produce)\s+(?:fake|false|fabricated|misleading|disinformation|misinformation|made.up)\b|\bpretend\s+(?:that|it\s+is\s+true|the\s+following\s+is\s+real)\b|\bspread\s+(?:false|fake|misleading)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('INJ-008', 'KaTeX / Display-Math Hidden Text', 'HIGH', 'prompt_injection',
    /\$\$[^$]*\\(?:color|colorbox|pagecolor|textcolor)\s*\{(?:white|transparent|#fff)[^}]*\}|\\(?:colorbox|pagecolor)\s*\{(?:white|transparent|#fff)[^}]*\}/i,
    { skipExample: true }),
  hiLine('INJ-009', 'Multi-Layer Base64 Obfuscation', 'HIGH', 'prompt_injection',
    /\bVm0wd[A-Za-z0-9+/]/,
    { skipExample: true, skipCode: true, variantId: 'multi-layer-base64' }),

  hiLine('MD-007', 'Image Tag with javascript: or data: URI', 'CRITICAL', 'markdown_injection',
    /!\[.*?\]\s*\(\s*(?:javascript:|data:)|<img\b[^>]+src\s*=\s*["']\s*(?:javascript:|data:)/i),
  hiLine('MD-009', 'vbscript: URI in Markdown Link or Attribute', 'CRITICAL', 'markdown_injection',
    /\]\s*\(\s*vbscript:|href\s*=\s*["']\s*vbscript:|src\s*=\s*["']\s*vbscript:/i),
  hiLine('MD-010', 'Repetitive Image Syntax — Potential ReDoS / DoS Trigger', 'MEDIUM', 'markdown_injection',
    /(?:!\[){20,}/),
  hiLine('MD-011', 'dangerouslySetInnerHTML Without Sanitization', 'HIGH', 'markdown_injection',
    /dangerouslySetInnerHTML/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /DOMPurify|sanitize|rehype-sanitize|xss/i, contextRadius: 5 }),
  hiLine('MD-013', '.innerHTML Assignment Without Sanitization', 'HIGH', 'markdown_injection',
    /\.innerHTML\s*=/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /DOMPurify|sanitize|rehype-sanitize|xss/i, contextRadius: 5 }),
  hiLine('MD-014', 'HTML Escaping Disabled in Markdown Config', 'HIGH', 'markdown_injection',
    /(?:escape[_-]?html|sanitize|escapeHtml)\s*[:=]\s*(?:false|0|no|off)\b|html\s*:\s*true\b/i),
  hiLine('MD-015', 'Meta Refresh Tag — Redirect / Content Exfiltration', 'HIGH', 'markdown_injection',
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i,
    { skipCode: true }),
  hiLine('MD-016', 'Mixed-Quote Link Title — HTML Attribute Injection', 'MEDIUM', 'markdown_injection',
    /\[[^\]]+\]\([^\s)]+\s+"[^"]*'[^"]*"\)/i,
    { confidence: 'MEDIUM' }),
  hiLine('MD-017', 'Image URL Quote Breakout — Event Handler Injection', 'CRITICAL', 'markdown_injection',
    /!\[[^\]]*\]\([^)]*"\s*on\w+\s*=|<img\b[^>]*src\s*=\s*[^>]*"\s*on\w+\s*=/i),
  hiLine('MD-018', 'CSS expression() / Style Attribute XSS', 'HIGH', 'markdown_injection',
    /style\s*=\s*["'][^"']*(?:expression\s*\(|javascript\s*:|url\s*\()/i,
    { skipCode: true }),
  hiLine('MD-019', 'target="_blank" Without rel="noopener noreferrer"', 'MEDIUM', 'markdown_injection',
    /target\s*=\s*["']_blank["']/i,
    { excludePattern: /noopener/i }),
  hiLine('MD-021', 'iframe Embedded in Image Syntax', 'HIGH', 'markdown_injection',
    /!\[[^\]]*\]\s*\([^)]*<\s*iframe/i),
  hiLine('MD-023', 'Hidden Form Field With Hardcoded Value', 'HIGH', 'markdown_injection',
    /<input\b[^>]*type\s*=\s*["']?hidden[^>]*value\s*=\s*["'][^"']{4,}/i,
    { skipCode: true }),
  hiLine('MD-022', 'Hidden Input Field in Markdown', 'MEDIUM', 'markdown_injection',
    /<input\b[^>]*type\s*=\s*["']?hidden/i,
    { skipCode: true, confidence: 'MEDIUM', excludePattern: /<input\b[^>]*type\s*=\s*["']?hidden[^>]*value\s*=\s*["'][^"']{4,}/i }),
  hiLine('MD-026', '<style> Tag — CSS Injection', 'MEDIUM', 'markdown_injection',
    /<style\b/i,
    { skipCode: true }),
  hiLine('MD-029', 'CSS Hidden Text — Invisible LLM Prompt Injection', 'HIGH', 'prompt_injection',
    /style\s*=\s*["'][^"']*(?:color\s*:\s*(?:white|#fff(?:fff)?|transparent|rgba?\([^)]*,\s*0\s*\))|opacity\s*:\s*0(?:\.\d+)?(?:\s|;|")|visibility\s*:\s*hidden|display\s*:\s*none)/i,
    { skipCode: true }),
  hiLine('MD-030', 'Windows Notepad RCE — Malicious Protocol URI', 'CRITICAL', 'markdown_injection',
    /(?:<|\[[^\]]+\]\()(?:file:(?:\/|\\\\){4}|ms-appinstaller:(?:\/|\\\\){2})/i),
  hiLine('MD-031', 'Repetitive Delimiter Run — markdown-it linkify ReDoS', 'MEDIUM', 'markdown_injection',
    /\*{15,}|_{15,}/,
    { skipCode: true }),
  hiLine('MD-033', 'Obfuscated JavaScript URI — Encoding/Whitespace Bypass', 'CRITICAL', 'markdown_injection',
    /\]\s*\(\s*(?:(?:j|&#[xX]?[0-9a-fA-F]+;)(?:&#[xX]?[0-9a-fA-F]+;|%[0-9a-fA-F]{2})+[a-z]*script\s*:|j\s+a\s+v\s+a\s+s\s+c\s+r\s+i\s+p\s+t\s*:)/i),
  hiLine('MD-034', 'markdown-it Unsafe highlight Callback', 'HIGH', 'markdown_injection',
    /\bhighlight\s*:\s*(?:function\b|\(|\w+\s*=>)/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /escapeHtml|DOMPurify|sanitize/i, contextRadius: 5 }),
  hiLine('MD-035', 'Media Tag with Event Handler — XSS / Electron RCE', 'HIGH', 'markdown_injection',
    /<(?:audio|video|source|track)\b[^>]*\bon\w+\s*=/i,
    { skipCode: true }),

  hiLine('ASI-004', 'Dynamic or Unverified Tool / Plugin Loading', 'HIGH', 'agentic_supply_chain',
    /\bdynamic(?:ally)?\s+(?:load|import|register|install)\s+(?:tool|plugin|agent|extension|skill)\b|\btrust\s+(?:all|any)\s+(?:agents?|tools?|plugins?|mcp\s+servers?)\b|\bopen\s+(?:agent\s+)?registry\b|\bno\s+(?:tool|agent|plugin)\s+(?:verification|validation|allowlist|whitelist)\b|\baccept\s+(?:any|all)\s+(?:mcp|tool|agent)\s+(?:connections?|registrations?|descriptors?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('ASI-006', 'Unsafe Memory or Context Persistence Pattern', 'HIGH', 'memory_poisoning',
    /\bauto(?:matically)?\s+(?:store|save|memorize|ingest|add)\s+(?:all\s+)?(?:output|response|result|generated\s+content)\b|\bno\s+(?:memory|context)\s+(?:validation|sanitization|isolation|segmentation)\b|\breuse\s+(?:memory|context|session|embeddings?)\s+across\s+(?:users?|sessions?|tenants?|agents?)\b|\bpersist\s+(?:all\s+)?(?:user\s+)?(?:data|inputs?|messages?|outputs?)\s+(?:to|in)\s+(?:memory|store|database|rag)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('ASI-007', 'Insecure Inter-Agent Communication Pattern', 'HIGH', 'insecure_agent_comm',
    /(?:communicate|connect|send|receive)\s+(?:with\s+)?(?:other\s+)?agents?\s+(?:via|over|using)\s+http:\/\/|\btrust\s+(?:all\s+)?(?:internal|inbound)\s+(?:agent|inter.?agent)\s+(?:messages?|requests?|commands?)\b|\bno\s+(?:authentication|verification|signature|validation)\s+(?:for|on|of)\s+(?:agent|inter.?agent|internal)\s+(?:messages?|comms?|requests?)\b|\baccept\s+(?:all|any)\s+(?:agent|mcp|a2a)\s+(?:messages?|requests?|instructions?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('ASI-008', 'Cascading Failure Risk — Unbounded Delegation or Broadcast', 'MEDIUM', 'cascading_failure',
    /\bbroadcast\s+(?:to\s+all|across\s+all)\s+(?:agents?|instances?|nodes?)\b|\bpropagate\s+(?:errors?|failures?|changes?|results?)\s+(?:to\s+all|automatically|across\s+all)\b|\bno\s+circuit\s+breaker\b|\bunlimited\s+(?:delegation|recursion|depth)\s*(?:\s+of\s+)?(?:agent|task|call)?\b|\bautomatically\s+(?:delegate|forward|escalate)\s+(?:all|any)\s+(?:tasks?|requests?|failures?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('ASI-009', 'Human-Agent Trust Exploitation Pattern', 'HIGH', 'trust_exploitation',
    /\b(?:urgent|critical|emergency)\s+action\s+required\b|\byou\s+(?:must|need\s+to|have\s+to)\s+(?:act|approve|trust|comply)\s+(?:now|immediately|right\s+away)\b|\bno\s+need\s+to\s+(?:verify|check|review|confirm)\b|\byou\s+can\s+(?:fully\s+)?trust\s+(?:this|me|the\s+(?:agent|system|assistant))\b|\bdon['’]?t\s+(?:question|doubt|verify)\s+(?:the\s+)?(?:agent|system|assistant|results?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('ASI-010', 'Rogue Agent Behavior Pattern — Self-Replication or Persistence', 'CRITICAL', 'rogue_agent',
    /\bspawn\s+(?:new|additional|extra|more)\s+(?:agents?|instances?|copies?|replicas?)\b|\bcreate\s+(?:a\s+)?(?:copy|replica|clone)\s+of\s+(?:yourself|itself|this\s+agent|the\s+agent)\b|\bself.?replicate?\b|\bpropagate\s+(?:yourself|itself|this\s+agent|this\s+skill)\b|\bpersist\s+(?:across|after|beyond)\s+(?:shutdown|restart|termination)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  hiLine('LLM-008', 'Excessive Agency — Destructive Action Without Human Approval', 'HIGH', 'excessive_agency',
    /without\s+(?:asking|confirmation|approval|review|permission)|(?:automatically|autonomously|silently)\s+(?:delete|remove|overwrite|execute|send|deploy|publish)/i,
    { skipExample: true, confidence: 'MEDIUM' })
];

// ============================================================================
// HIGH_IMPACT_DOCUMENT_RULES. Evaluated once per file.
// ============================================================================
const hiDoc = (id: string, title: string, severity: Rule['severity'], category: string, pattern: RegExp, opts: Partial<Rule> = {}): Rule =>
  ({ id, title, severity, category, pattern, confidence: 'HIGH', family: 'high_impact_document', scope: 'document', owasp: owaspForCategory(category), ...opts });

export const HIGH_IMPACT_DOCUMENT_RULES: Rule[] = [
  hiDoc('MD-012', 'rehype-raw Without rehype-sanitize', 'HIGH', 'markdown_injection', /rehype-raw/i, { confidence: 'MEDIUM', excludePattern: /rehype-sanitize/i }),
  hiDoc('MD-027', 'Markdown Renderer Unsafe HTML Config', 'HIGH', 'markdown_injection', /unsafe\s*:\s*true|ignoreLogs\s*=.*warning-goldmark-raw-html/i),
  hiDoc('MD-028', 'remark-html Without Sanitization', 'HIGH', 'markdown_injection', /\bremark-html\b|remarkHtml/i, { confidence: 'MEDIUM', excludePattern: /sanitize|DOMPurify|rehype-sanitize/i }),
  hiDoc('MD-032', 'Math Block HTML/Script Injection', 'HIGH', 'markdown_injection', /\$\$[^$]*?(?:<(?:script|iframe|img|svg|object|embed)\b|on\w+\s*=|javascript:|data:text\/html)[^$]*?\$\$/i)
];

// ============================================================================
// INFORMATIONAL_CONTROL_RULES (CTL-002..013): absence-based, so they would fire when the pattern is NOT
// present. They are cataloged here but not executed by the engine.
// ============================================================================
export const INFORMATIONAL_CONTROL_RULES: Rule[] = [
  hiLine('CTL-002', 'No Input Validation / Sanitization Instruction', 'INFO', 'missing_control', /(?:sanitiz|validat|filter|clean)\s+(?:all\s+)?(?:user\s+)?input/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-003', 'No Output Filtering / Sanitization Instruction', 'INFO', 'missing_control', /(?:sanitiz|filter|escap|encod)\s+(?:all\s+)?(?:output|response)|output\s+(?:filtering|sanitization|validation)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-004', 'No Rate Limiting Instruction', 'INFO', 'missing_control', /rate\s*limit|throttl|max\s+requests?|requests?\s+per\s+(?:second|minute|hour)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-005', 'No Explicit Scope / Role Constraint', 'INFO', 'missing_control', /(?:only|must)\s+(?:operate|respond|act)\s+(?:within|on)\s+.{0,40}|scope\s*[=:]\s*|restrict(?:ed)?\s+to\s+/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-006', 'No Bias Mitigation Instruction', 'INFO', 'missing_control', /(?:avoid|prevent|mitigat)\s+bias|(?:gender|racial|cultural|socioeconomic)\s+(?:neutral|inclusive|fair)|do\s+not\s+(?:assume|stereotype|discriminate)|treat\s+all\s+(?:users?|people|individuals)\s+equally/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-007', 'No Harmful Content Safeguard', 'INFO', 'missing_control', /(?:refuse|reject|do\s+not\s+(?:generate|produce|create))\s+.{0,30}(?:harmful|dangerous|violent|illegal|inappropriate)\s+content|safety\s+(?:guideline|constraint|filter)|responsible\s+AI|content\s+policy/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-008', 'No Memory Segmentation / Isolation Instruction', 'INFO', 'missing_control', /memory\s+(?:segm|isolat|partition|scope)|(?:isolat|segm|partition)\w*\s+memory|per.?(?:session|user|tenant)\s+memory|memory\s+(?:clear|wipe|flush)\s+(?:between|after|per)|separate\s+memory\s+(?:per|by|for)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-009', 'No Inter-Agent Authentication Instruction', 'INFO', 'missing_control', /(?:mutual|bidirectional)\s+auth|mTLS|client\s+certificate|sign(?:ed)?\s+(?:messages?|requests?|tokens?|agent\s+card)|authenticat\w*\s+(?:agent|inter.?agent|peer)\s+(?:messages?|requests?|calls?)|agent\s+(?:identity|credential)\s+(?:verification|validation|attestation)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-010', 'No Behavioral Monitoring / Audit Logging Instruction', 'INFO', 'missing_control', /behav(?:ior(?:al)?|iour(?:al)?)\s+(?:monitor|detect|log|audit|baseline)|audit\s+(?:log|trail|record)|immutable\s+log|anomaly\s+detect|(?:log|record|monitor)\s+(?:all\s+)?(?:agent\s+)?(?:actions?|tool\s+(?:calls?|invocations?)|decisions?)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-011', 'No Indirect Injection Defense', 'INFO', 'missing_control', /(?:external|fetched|retrieved|third.?party|tool.?output|document|web|url)\s+.{0,30}(?:untrusted|unverified|potentially\s+(?:malicious|adversarial))|indirect\s+.{0,10}(?:inject|prompt)|treat\s+.{0,30}(?:external|fetched|retrieved)\s+.{0,20}(?:as\s+(?:untrusted|data))/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-012', 'No Multi-Language Bypass Defense', 'INFO', 'missing_control', /(?:regardless\s+of\s+(?:the\s+)?language|in\s+(?:any|all|every)\s+language|translat\w+\s+.{0,30}(?:rule|instruction|safety|restrict)|language\s+.{0,20}(?:bypass|circumvent|evade)|apply\s+.{0,20}(?:rules?|restrictions?|safeguards?)\s+.{0,20}language)/i, { confidence: 'MEDIUM', scope: 'document' }),
  hiLine('CTL-013', 'No Context Overflow / Token Window Defense', 'INFO', 'missing_control', /(?:context|token|input)\s+.{0,20}(?:limit|overflow|window|length|maximum|exceed|truncat)|too\s+(?:long|large|many)\s+.{0,20}(?:input|token|message)|reject\s+.{0,30}(?:oversized|long|large)\s+(?:input|message|request)/i, { confidence: 'MEDIUM', scope: 'document' })
];

/** Rules executed by the deterministic engine (positive-match, line + document). */
export const EXECUTED_LINE_RULES: Rule[] = [
  ...SECRET_RULES,
  ...INJECTION_RULES,
  ...MARKDOWN_RULES,
  ...HOOK_RULES,
  ...AGENTIC_RULES
];

/** All rules, for inventory reporting. */
export const ALL_RULES: Rule[] = [
  ...SECRET_RULES,
  ...INJECTION_RULES,
  ...MARKDOWN_RULES,
  ...HOOK_RULES,
  ...AGENTIC_RULES,
  ...AST_RULES,
  ...HIGH_IMPACT_LINE_RULES,
  ...HIGH_IMPACT_DOCUMENT_RULES,
  ...INFORMATIONAL_CONTROL_RULES
];

/** Placeholder/boundary helpers used by special algorithmic detectors (INJ-002/003, SEC-013). */
export const INVISIBLE_CHARS = /[\u200B-\u200F\uFEFF\u2060-\u2064\u202A-\u202E\u2066-\u2069]/;
export const PLACEHOLDER = /\{\{[^}]+\}\}|\{[^}]+\}|<(?:user_input|user_message|input|query|prompt)>|\[[A-Z_]{3,}\]/;
export const BOUNDARY = /DATA_START|DATA_END|CONTENT_START|CONTENT_END|\[DATA\]|\[INSTRUCTIONS\]|<data>|<user_data>|is\s+(?:NOT\s+instructions?|data\s+only)/i;
export const ASSIGNMENT = /[=:]\s*["']([A-Za-z0-9+/=_-]{25,})["']/g;
export const SAFE_SECRET_PLACEHOLDER = /\b(?:YOUR|EXAMPLE|DUMMY|TEST)_[A-Z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_-]*\b|\b(?:CHANGEME|REPLACE_ME|INSERT_HERE|REDACTED)\b|<[^>]*(?:KEY|TOKEN|SECRET|PASSWORD)[^>]*>|\$\{[^}]+\}/i;
export const DOCUMENTATION_ONLY = /^(?:readme|changelog|changes|history|contributing|licen[cs]e|authors|notice)(?:\.md)?$/i;
export { LLM01, LLM06, OWASP_WEB };
