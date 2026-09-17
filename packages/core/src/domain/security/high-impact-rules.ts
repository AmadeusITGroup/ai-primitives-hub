import type {
  SecurityArtifactClass,
  SecurityConfidence,
  SecuritySeverity,
} from './types';

/* eslint-disable @stylistic/max-len -- Keep security signatures as auditable regex literals. */

export interface ContextualSecurityRule {
  id: string;
  title: string;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  category: string;
  pattern: RegExp;
  skipExample?: boolean;
  skipCode?: boolean;
  excludePattern?: RegExp;
  contextPattern?: RegExp;
  contextRadius?: number;
  requireContext?: boolean;
  artifactClasses?: readonly SecurityArtifactClass[];
  variantId?: string;
  relatedAst?: string;
}

const rule = (
  id: string,
  title: string,
  severity: SecuritySeverity,
  category: string,
  pattern: RegExp,
  options: Partial<Omit<ContextualSecurityRule, 'id' | 'title' | 'severity' | 'category' | 'pattern'>> = {}
): ContextualSecurityRule => ({
  id,
  title,
  severity,
  category,
  pattern,
  confidence: 'HIGH',
  ...options
});

const hook = (
  id: string,
  title: string,
  severity: SecuritySeverity,
  pattern: RegExp,
  options: Partial<ContextualSecurityRule> = {}
): ContextualSecurityRule => rule(id, title, severity, 'hook_injection', pattern, {
  skipExample: true,
  ...options
});

export const HIGH_IMPACT_LINE_RULES: readonly ContextualSecurityRule[] = [
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
    {
      confidence: 'MEDIUM',
      contextPattern: /\b(?:security|auth|credential|password|token|key|secret|permission|verify|check|validate|scan|monitor|log|audit|deny|block|guard)\b/i,
      contextRadius: 3,
      requireContext: true
    }),
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

  rule('MCP-002', 'Shell Alias / Environment Manipulation in Skill Definition', 'CRITICAL', 'mcp_injection',
    /\balias\s+\w+\s*=|\.bash(?:rc|_aliases|_profile)\b|\.zshrc\b|\.profile\b|(?:export|set)\s+PATH\s*=|\bauto.?memory\b|\bmemory\s+poisoning\b/i,
    { skipExample: true, skipCode: true }),
  rule('MCP-002', 'Git Hook / Config Tampering Pattern', 'CRITICAL', 'mcp_injection',
    /\.git\/hooks\/|post-checkout|pre-commit\s+hook|post-merge|mcp.*tamper|tamper.*mcp|config.*tamper|sha.256.*hmac|hmac.*snapshot/i,
    { skipExample: true, skipCode: true, confidence: 'MEDIUM' }),
  rule('MCP-003', 'Hidden Instruction Marker in Tool Description', 'CRITICAL', 'mcp_injection',
    /<!--[^>]*(?:ignore|override|system|admin|bypass|exfil)[^>]*-->|\[INST\]|\[\/INST\]|<\|(?:system|im_start|im_end)\|>/i,
    { skipExample: true }),
  rule('MCP-004', 'Risky MCP Server Type — High-Privilege Tool Category', 'HIGH', 'mcp_injection',
    /"(?:name|type)"\s*:\s*"[^"]*(?:filesystem|file.?system|shell|terminal|command.?exec|puppeteer|playwright|browser|selenium|postgres(?:ql)?|mysql|sqlite|database|db.?manager|slack|discord|email.?sender|smtp)[^"]*"/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('MCP-012', 'MCP Server Executes Remote Script via curl/wget Pipe', 'CRITICAL', 'mcp_injection',
    /(?:curl|wget)\s+[^\n|]{5,}\|\s*(?:bash|sh|zsh|python|node)|"(?:curl|wget)"[^}]{0,300}"\|[^"]*(?:bash|sh)"/i,
    { skipExample: true, relatedAst: 'AST02:2026' }),
  rule('MCP-013', 'Shell Metacharacters in MCP Server Arguments', 'HIGH', 'mcp_injection',
    /"args"\s*:\s*\[[^\]]*"[^"]*(?:[;&|`]|\$\()[^"]*"/i,
    { skipExample: true, confidence: 'MEDIUM' }),

  rule('INJ-004', 'Hidden Injection Attempt in HTML Comment', 'CRITICAL', 'prompt_injection',
    /<!--.*?(?:ignore|override|bypass|jailbreak|disregard|SYSTEM:|DAN).*?-->/i),
  rule('INJ-005', 'LaTeX Hidden Text — Invisible Injection Vector', 'HIGH', 'prompt_injection',
    /\$\\color\{(?:white|transparent)\}\{[^}]+\}\$/i),
  rule('INJ-006', 'Base64 Decode Call — Obfuscated Instruction Vector', 'HIGH', 'prompt_injection',
    /\b(?:atob|fromBase64|base64_decode|b64decode)\s*\(/i,
    { skipExample: true }),
  rule('INJ-006', 'Suspicious Long Base64 String — Potential Obfuscated Instruction', 'MEDIUM', 'prompt_injection',
    /[A-Za-z0-9+/]{60,}={0,2}/,
    {
      skipExample: true,
      skipCode: true,
      confidence: 'LOW',
      excludePattern: /https?:\/\/|sha\d+|checksum|hash/i,
      variantId: 'long-base64'
    }),
  rule('INJ-007', 'Misinformation Generation Instruction', 'HIGH', 'prompt_injection',
    /\b(?:generate|create|write|produce)\s+(?:fake|false|fabricated|misleading|disinformation|misinformation|made.up)\b|\bpretend\s+(?:that|it\s+is\s+true|the\s+following\s+is\s+real)\b|\bspread\s+(?:false|fake|misleading)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('INJ-008', 'KaTeX / Display-Math Hidden Text', 'HIGH', 'prompt_injection',
    /\$\$[^$]*\\(?:color|colorbox|pagecolor|textcolor)\s*\{(?:white|transparent|#fff)[^}]*\}|\\(?:colorbox|pagecolor)\s*\{(?:white|transparent|#fff)[^}]*\}/i,
    { skipExample: true }),
  rule('INJ-009', 'Multi-Layer Base64 Obfuscation', 'HIGH', 'prompt_injection',
    /\bVm0wd[A-Za-z0-9+/]/,
    { skipExample: true, skipCode: true, variantId: 'multi-layer-base64' }),

  rule('MD-007', 'Image Tag with javascript: or data: URI', 'CRITICAL', 'markdown_injection',
    /!\[.*?\]\s*\(\s*(?:javascript:|data:)|<img\b[^>]+src\s*=\s*["']\s*(?:javascript:|data:)/i),
  rule('MD-009', 'vbscript: URI in Markdown Link or Attribute', 'CRITICAL', 'markdown_injection',
    /\]\s*\(\s*vbscript:|href\s*=\s*["']\s*vbscript:|src\s*=\s*["']\s*vbscript:/i),
  rule('MD-010', 'Repetitive Image Syntax — Potential ReDoS / DoS Trigger', 'MEDIUM', 'markdown_injection',
    /(?:!\[){20,}/),
  rule('MD-011', 'dangerouslySetInnerHTML Without Sanitization', 'HIGH', 'markdown_injection',
    /dangerouslySetInnerHTML/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /DOMPurify|sanitize|rehype-sanitize|xss/i, contextRadius: 5 }),
  rule('MD-013', '.innerHTML Assignment Without Sanitization', 'HIGH', 'markdown_injection',
    /\.innerHTML\s*=/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /DOMPurify|sanitize|rehype-sanitize|xss/i, contextRadius: 5 }),
  rule('MD-014', 'HTML Escaping Disabled in Markdown Config', 'HIGH', 'markdown_injection',
    /(?:escape[_-]?html|sanitize|escapeHtml)\s*[:=]\s*(?:false|0|no|off)\b|html\s*:\s*true\b/i),
  rule('MD-015', 'Meta Refresh Tag — Redirect / Content Exfiltration', 'HIGH', 'markdown_injection',
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i,
    { skipCode: true }),
  rule('MD-016', 'Mixed-Quote Link Title — HTML Attribute Injection', 'MEDIUM', 'markdown_injection',
    /\[[^\]]+\]\([^\s)]+\s+"[^"]*'[^"]*"\)/i,
    { confidence: 'MEDIUM' }),
  rule('MD-017', 'Image URL Quote Breakout — Event Handler Injection', 'CRITICAL', 'markdown_injection',
    /!\[[^\]]*\]\([^)]*"\s*on\w+\s*=|<img\b[^>]*src\s*=\s*[^>]*"\s*on\w+\s*=/i),
  rule('MD-018', 'CSS expression() / Style Attribute XSS', 'HIGH', 'markdown_injection',
    /style\s*=\s*["'][^"']*(?:expression\s*\(|javascript\s*:|url\s*\()/i,
    { skipCode: true }),
  rule('MD-019', 'target="_blank" Without rel="noopener noreferrer"', 'MEDIUM', 'markdown_injection',
    /target\s*=\s*["']_blank["']/i,
    { excludePattern: /noopener/i }),
  rule('MD-021', 'iframe Embedded in Image Syntax', 'HIGH', 'markdown_injection',
    /!\[[^\]]*\]\s*\([^)]*<\s*iframe/i),
  rule('MD-023', 'Hidden Form Field With Hardcoded Value', 'HIGH', 'markdown_injection',
    /<input\b[^>]*type\s*=\s*["']?hidden[^>]*value\s*=\s*["'][^"']{4,}/i,
    { skipCode: true }),
  rule('MD-022', 'Hidden Input Field in Markdown', 'MEDIUM', 'markdown_injection',
    /<input\b[^>]*type\s*=\s*["']?hidden/i,
    {
      skipCode: true,
      confidence: 'MEDIUM',
      excludePattern: /<input\b[^>]*type\s*=\s*["']?hidden[^>]*value\s*=\s*["'][^"']{4,}/i
    }),
  rule('MD-026', '<style> Tag — CSS Injection', 'MEDIUM', 'markdown_injection',
    /<style\b/i,
    { skipCode: true }),
  rule('MD-029', 'CSS Hidden Text — Invisible LLM Prompt Injection', 'HIGH', 'prompt_injection',
    /style\s*=\s*["'][^"']*(?:color\s*:\s*(?:white|#fff(?:fff)?|transparent|rgba?\([^)]*,\s*0\s*\))|opacity\s*:\s*0(?:\.\d+)?(?:\s|;|")|visibility\s*:\s*hidden|display\s*:\s*none)/i,
    { skipCode: true }),
  rule('MD-030', 'Windows Notepad RCE — Malicious Protocol URI', 'CRITICAL', 'markdown_injection',
    /(?:<|\[[^\]]+\]\()(?:file:(?:\/|\\\\){4}|ms-appinstaller:(?:\/|\\\\){2})/i),
  rule('MD-031', 'Repetitive Delimiter Run — markdown-it linkify ReDoS', 'MEDIUM', 'markdown_injection',
    /\*{15,}|_{15,}/,
    { skipCode: true }),
  rule('MD-033', 'Obfuscated JavaScript URI — Encoding/Whitespace Bypass', 'CRITICAL', 'markdown_injection',
    /\]\s*\(\s*(?:(?:j|&#[xX]?[0-9a-fA-F]+;)(?:&#[xX]?[0-9a-fA-F]+;|%[0-9a-fA-F]{2})+[a-z]*script\s*:|j\s+a\s+v\s+a\s+s\s+c\s+r\s+i\s+p\s+t\s*:)/i),
  rule('MD-034', 'markdown-it Unsafe highlight Callback', 'HIGH', 'markdown_injection',
    /\bhighlight\s*:\s*(?:function\b|\(|\w+\s*=>)/i,
    { skipCode: true, confidence: 'MEDIUM', contextPattern: /escapeHtml|DOMPurify|sanitize/i, contextRadius: 5 }),
  rule('MD-035', 'Media Tag with Event Handler — XSS / Electron RCE', 'HIGH', 'markdown_injection',
    /<(?:audio|video|source|track)\b[^>]*\bon\w+\s*=/i,
    { skipCode: true }),

  rule('ASI-004', 'Dynamic or Unverified Tool / Plugin Loading', 'HIGH', 'agentic_supply_chain',
    /\bdynamic(?:ally)?\s+(?:load|import|register|install)\s+(?:tool|plugin|agent|extension|skill)\b|\btrust\s+(?:all|any)\s+(?:agents?|tools?|plugins?|mcp\s+servers?)\b|\bopen\s+(?:agent\s+)?registry\b|\bno\s+(?:tool|agent|plugin)\s+(?:verification|validation|allowlist|whitelist)\b|\baccept\s+(?:any|all)\s+(?:mcp|tool|agent)\s+(?:connections?|registrations?|descriptors?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('ASI-006', 'Unsafe Memory or Context Persistence Pattern', 'HIGH', 'memory_poisoning',
    /\bauto(?:matically)?\s+(?:store|save|memorize|ingest|add)\s+(?:all\s+)?(?:output|response|result|generated\s+content)\b|\bno\s+(?:memory|context)\s+(?:validation|sanitization|isolation|segmentation)\b|\breuse\s+(?:memory|context|session|embeddings?)\s+across\s+(?:users?|sessions?|tenants?|agents?)\b|\bpersist\s+(?:all\s+)?(?:user\s+)?(?:data|inputs?|messages?|outputs?)\s+(?:to|in)\s+(?:memory|store|database|rag)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('ASI-007', 'Insecure Inter-Agent Communication Pattern', 'HIGH', 'insecure_agent_comm',
    /(?:communicate|connect|send|receive)\s+(?:with\s+)?(?:other\s+)?agents?\s+(?:via|over|using)\s+http:\/\/|\btrust\s+(?:all\s+)?(?:internal|inbound)\s+(?:agent|inter.?agent)\s+(?:messages?|requests?|commands?)\b|\bno\s+(?:authentication|verification|signature|validation)\s+(?:for|on|of)\s+(?:agent|inter.?agent|internal)\s+(?:messages?|comms?|requests?)\b|\baccept\s+(?:all|any)\s+(?:agent|mcp|a2a)\s+(?:messages?|requests?|instructions?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('ASI-008', 'Cascading Failure Risk — Unbounded Delegation or Broadcast', 'MEDIUM', 'cascading_failure',
    /\bbroadcast\s+(?:to\s+all|across\s+all)\s+(?:agents?|instances?|nodes?)\b|\bpropagate\s+(?:errors?|failures?|changes?|results?)\s+(?:to\s+all|automatically|across\s+all)\b|\bno\s+circuit\s+breaker\b|\bunlimited\s+(?:delegation|recursion|depth)\s*(?:\s+of\s+)?(?:agent|task|call)?\b|\bautomatically\s+(?:delegate|forward|escalate)\s+(?:all|any)\s+(?:tasks?|requests?|failures?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('ASI-009', 'Human-Agent Trust Exploitation Pattern', 'HIGH', 'trust_exploitation',
    /\b(?:urgent|critical|emergency)\s+action\s+required\b|\byou\s+(?:must|need\s+to|have\s+to)\s+(?:act|approve|trust|comply)\s+(?:now|immediately|right\s+away)\b|\bno\s+need\s+to\s+(?:verify|check|review|confirm)\b|\byou\s+can\s+(?:fully\s+)?trust\s+(?:this|me|the\s+(?:agent|system|assistant))\b|\bdon['’]?t\s+(?:question|doubt|verify)\s+(?:the\s+)?(?:agent|system|assistant|results?)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('ASI-010', 'Rogue Agent Behavior Pattern — Self-Replication or Persistence', 'CRITICAL', 'rogue_agent',
    /\bspawn\s+(?:new|additional|extra|more)\s+(?:agents?|instances?|copies?|replicas?)\b|\bcreate\s+(?:a\s+)?(?:copy|replica|clone)\s+of\s+(?:yourself|itself|this\s+agent|the\s+agent)\b|\bself.?replicate?\b|\bpropagate\s+(?:yourself|itself|this\s+agent|this\s+skill)\b|\bpersist\s+(?:across|after|beyond)\s+(?:shutdown|restart|termination)\b/i,
    { skipExample: true, confidence: 'MEDIUM' }),
  rule('LLM-008', 'Excessive Agency — Destructive Action Without Human Approval', 'HIGH', 'excessive_agency',
    /without\s+(?:asking|confirmation|approval|review|permission)|(?:automatically|autonomously|silently)\s+(?:delete|remove|overwrite|execute|send|deploy|publish)/i,
    { skipExample: true, confidence: 'MEDIUM' })
];

export const HIGH_IMPACT_DOCUMENT_RULES: readonly ContextualSecurityRule[] = [
  rule('MD-012', 'rehype-raw Without rehype-sanitize', 'HIGH', 'markdown_injection',
    /rehype-raw/i,
    { confidence: 'MEDIUM', excludePattern: /rehype-sanitize/i }),
  rule('MD-027', 'Markdown Renderer Unsafe HTML Config', 'HIGH', 'markdown_injection',
    /unsafe\s*:\s*true|ignoreLogs\s*=.*warning-goldmark-raw-html/i),
  rule('MD-028', 'remark-html Without Sanitization', 'HIGH', 'markdown_injection',
    /\bremark-html\b|remarkHtml/i,
    { confidence: 'MEDIUM', excludePattern: /sanitize|DOMPurify|rehype-sanitize/i }),
  rule('MD-032', 'Math Block HTML/Script Injection', 'HIGH', 'markdown_injection',
    /\$\$[^$]*?(?:<(?:script|iframe|img|svg|object|embed)\b|on\w+\s*=|javascript:|data:text\/html)[^$]*?\$\$/i)
];

export const INFORMATIONAL_CONTROL_RULES: readonly ContextualSecurityRule[] = [
  rule('CTL-002', 'No Input Validation / Sanitization Instruction', 'INFO', 'missing_control',
    /(?:sanitiz|validat|filter|clean)\s+(?:all\s+)?(?:user\s+)?input/i),
  rule('CTL-003', 'No Output Filtering / Sanitization Instruction', 'INFO', 'missing_control',
    /(?:sanitiz|filter|escap|encod)\s+(?:all\s+)?(?:output|response)|output\s+(?:filtering|sanitization|validation)/i),
  rule('CTL-004', 'No Rate Limiting Instruction', 'INFO', 'missing_control',
    /rate\s*limit|throttl|max\s+requests?|requests?\s+per\s+(?:second|minute|hour)/i),
  rule('CTL-005', 'No Explicit Scope / Role Constraint', 'INFO', 'missing_control',
    /(?:only|must)\s+(?:operate|respond|act)\s+(?:within|on)\s+.{0,40}|scope\s*[=:]\s*|restrict(?:ed)?\s+to\s+/i),
  rule('CTL-006', 'No Bias Mitigation Instruction', 'INFO', 'missing_control',
    /(?:avoid|prevent|mitigat)\s+bias|(?:gender|racial|cultural|socioeconomic)\s+(?:neutral|inclusive|fair)|do\s+not\s+(?:assume|stereotype|discriminate)|treat\s+all\s+(?:users?|people|individuals)\s+equally/i),
  rule('CTL-007', 'No Harmful Content Safeguard', 'INFO', 'missing_control',
    /(?:refuse|reject|do\s+not\s+(?:generate|produce|create))\s+.{0,30}(?:harmful|dangerous|violent|illegal|inappropriate)\s+content|safety\s+(?:guideline|constraint|filter)|responsible\s+AI|content\s+policy/i),
  rule('CTL-008', 'No Memory Segmentation / Isolation Instruction', 'INFO', 'missing_control',
    /memory\s+(?:segm|isolat|partition|scope)|(?:isolat|segm|partition)\w*\s+memory|per.?(?:session|user|tenant)\s+memory|memory\s+(?:clear|wipe|flush)\s+(?:between|after|per)|separate\s+memory\s+(?:per|by|for)/i),
  rule('CTL-009', 'No Inter-Agent Authentication Instruction', 'INFO', 'missing_control',
    /(?:mutual|bidirectional)\s+auth|mTLS|client\s+certificate|sign(?:ed)?\s+(?:messages?|requests?|tokens?|agent\s+card)|authenticat\w*\s+(?:agent|inter.?agent|peer)\s+(?:messages?|requests?|calls?)|agent\s+(?:identity|credential)\s+(?:verification|validation|attestation)/i),
  rule('CTL-010', 'No Behavioral Monitoring / Audit Logging Instruction', 'INFO', 'missing_control',
    /behav(?:ior(?:al)?|iour(?:al)?)\s+(?:monitor|detect|log|audit|baseline)|audit\s+(?:log|trail|record)|immutable\s+log|anomaly\s+detect|(?:log|record|monitor)\s+(?:all\s+)?(?:agent\s+)?(?:actions?|tool\s+(?:calls?|invocations?)|decisions?)/i),
  rule('CTL-011', 'No Indirect Injection Defense', 'INFO', 'missing_control',
    /(?:external|fetched|retrieved|third.?party|tool.?output|document|web|url)\s+.{0,30}(?:untrusted|unverified|potentially\s+(?:malicious|adversarial))|indirect\s+.{0,10}(?:inject|prompt)|treat\s+.{0,30}(?:external|fetched|retrieved)\s+.{0,20}(?:as\s+(?:untrusted|data))/i),
  rule('CTL-012', 'No Multi-Language Bypass Defense', 'INFO', 'missing_control',
    /(?:regardless\s+of\s+(?:the\s+)?language|in\s+(?:any|all|every)\s+language|translat\w+\s+.{0,30}(?:rule|instruction|safety|restrict)|language\s+.{0,20}(?:bypass|circumvent|evade)|apply\s+.{0,20}(?:rules?|restrictions?|safeguards?)\s+.{0,20}language)/i),
  rule('CTL-013', 'No Context Overflow / Token Window Defense', 'INFO', 'missing_control',
    /(?:context|token|input)\s+.{0,20}(?:limit|overflow|window|length|maximum|exceed|truncat)|too\s+(?:long|large|many)\s+.{0,20}(?:input|token|message)|reject\s+.{0,30}(?:oversized|long|large)\s+(?:input|message|request)/i)
];
