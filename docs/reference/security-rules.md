# Security Detection Rules

This catalogue describes the native scanner's detection policy for rule pack
`1.10.9-compatible.2` (engine `1.1.1`). It lists implemented IDs, including
structural checks, rather than assuming every number in a family exists.
Multiple signatures can share an ID and have different severities.

The scanner uses deterministic text patterns, Markdown context and structural
Claude settings checks. These are triage signals, not proof of exploitability
or safety. It does not execute hook commands, tools or artifact instructions.

## Applicability and defaults

- Directory scans select Markdown and supported Claude settings. Explicit
  Markdown files are scanned even when they are README or CHANGELOG files.
- Skill and agent classification enables artifact-specific checks. The
  `description` frontmatter field is matched as a field, not a substring.
- Example headings and fenced code affect applicability. Some contextual rules
  skip them; generic secret matches in examples become MEDIUM, and generic
  prompt-injection matches become INFO. Documentation can also lower severity.
  The base severities below are therefore not guaranteed reported severities.
- Claude settings are parsed as configuration, including nested hook commands.
  Malformed settings produce incomplete coverage, not a clean scan.
- CTL checks and AGT-003 require `--include-llm-controls`. CTL-001 through
  CTL-013 additionally require informational controls to be enabled. Missing
  prompt-level controls are not checks of actual runtime enforcement.
- Secret and MCP argument evidence is redacted. Placeholder exceptions apply
  to the placeholder itself, not unrelated credentials on the same line.

All other checks are enabled, subject to their artifact/context conditions.
`C`, `H`, `M`, `L`, and `I` below mean CRITICAL, HIGH, MEDIUM, LOW, and INFO.

## Secrets and credential exposure

| ID | Trigger | Base |
|---|---|---|
| SEC-001 | OpenAI API key | C |
| SEC-002 | Anthropic API key | C |
| SEC-003 | AWS access key | C |
| SEC-004 | GitHub token | C |
| SEC-005 | Stripe live key | C |
| SEC-006 | Google API key | H |
| SEC-007 | Slack token | H |
| SEC-008 | Database connection credentials | C |
| SEC-009 | Private key | C |
| SEC-010 | Hugging Face token | C |
| SEC-011 | Generic secret assignment | H |
| SEC-012 | SendGrid key | H |
| SEC-013 | High-entropy assigned string | H |
| SEC-014 | Exfiltration/out-of-band URL | C |
| SEC-015 | xAI key | C |
| SEC-016 | Discord bot token | C |
| SEC-017 | npm token | C |
| SEC-018 | Linear key | H |
| SEC-019 | Databricks token | C |
| SEC-020 | DigitalOcean token | C |
| SEC-021 | URL-embedded credentials | H |
| SEC-022 | Sensitive environment variable echoed | H |
| SEC-023 | Cloudflare token | C |
| SEC-024 | Twilio key SID/auth-token indicator | C |
| SEC-025 | JWT | H |
| SEC-026 | Mailchimp key | H |
| SEC-027 | Credential-file reference | H |

## Prompt injection

| ID | Trigger | Base |
|---|---|---|
| INJ-001 | Instruction override, exfiltration, privilege escalation, self-modification | C |
| INJ-001 | Mode unlock, DAN, restriction removal, persona hijack, system-prompt extraction | H |
| INJ-002 | User-input placeholder without a nearby applicable trust boundary | H |
| INJ-003 | Invisible/zero-width characters | H |
| INJ-004 | Injection in an HTML comment | C |
| INJ-005 | LaTeX invisible text | H |
| INJ-006 | Base64 decode call | H |
| INJ-006 | Long Base64 payload (`long-base64`) | M |
| INJ-007 | Misinformation-generation instruction | H |
| INJ-008 | KaTeX/display-math hidden text | H |
| INJ-009 | Agent identity impersonation or layered Base64 (`multi-layer-base64`) | H |

## Markdown, HTML and rendering

| ID | Trigger | Base |
|---|---|---|
| MD-001 | Executable HTML tag | H |
| MD-002 | HTML event handler | H |
| MD-003 | JavaScript URI | C |
| MD-004 | Prototype-pollution frontmatter key | H |
| MD-005 | Data URI | H |
| MD-006 | `srcdoc` attribute | C |
| MD-007 | JavaScript/data URI in an image | C |
| MD-008 | Split blockquote HTML attribute injection | C |
| MD-009 | VBScript URI | C |
| MD-010 | Repetitive image delimiters | M |
| MD-011 | Unsanitized `dangerouslySetInnerHTML` | H |
| MD-012 | `rehype-raw` without a recognized sanitizer in the same pipeline | H |
| MD-013 | Unsanitized `innerHTML` assignment | H |
| MD-014 | HTML escaping disabled | H |
| MD-015 | Meta refresh | H |
| MD-016 | Mixed-quote link-title injection | M |
| MD-017 | Image-URL quote breakout | C |
| MD-018 | Executable CSS/style attribute | H |
| MD-019 | `target=_blank` without `noopener` | M |
| MD-020 | HTTP image source | L |
| MD-021 | iframe inside image syntax | H |
| MD-022 | Hidden input without a substantial fixed value | M |
| MD-023 | Hidden input with hardcoded value | H |
| MD-026 | Style tag | M |
| MD-027 | Unsafe Markdown renderer configuration | H |
| MD-028 | `remark-html` without sanitization | H |
| MD-029 | CSS-invisible prompt text | H |
| MD-030 | Dangerous Windows protocol URI | C |
| MD-031 | Repetitive delimiters/linkify denial-of-service pattern | M |
| MD-032 | HTML/script injection in math | H |
| MD-033 | Obfuscated JavaScript URI | C |
| MD-034 | Unsafe highlight callback | H |
| MD-035 | Media-tag event handler | H |

MD-024 and MD-025 are not implemented. Hidden-input checks recognize either
attribute order; a sanitizer elsewhere in a document does not waive MD-012.

## Hooks and host commands

These signatures apply to Markdown and structurally extracted Claude hook
commands. Markdown example/code guards do not exempt executable settings.

| ID | Trigger | Base |
|---|---|---|
| HKS-001 | Remote script piped to a shell | C |
| HKS-002 | Reverse-shell pattern | C |
| HKS-003 | Credential-store/cloud-metadata access | C |
| HKS-004 | Clipboard utility | H |
| HKS-005 | Log tampering/anti-forensics | H |
| HKS-006 | Privileged container/host namespaces | C |
| HKS-007 | Global/unpinned package installation | H |
| HKS-008 | Security-sensitive error suppression | H |
| HKS-009 | Cron/init persistence | C |
| HKS-010 | Shell-profile modification | C |
| HKS-011 | SSH-key manipulation | C |
| HKS-012 | Network listener | C |
| HKS-013 | Disk wipe/destructive filesystem command | C |
| HKS-014 | Privileged shell | C |
| HKS-015 | User-account manipulation | C |
| HKS-016 | Dangerous Git configuration | H |
| HKS-017 | Loader/interpreter environment override | H |
| HKS-018 | Firewall modification | C |
| HKS-019 | DNS exfiltration | C |
| HKS-020 | Background daemonization | H |
| HKS-021 | Shredding/unrecoverable deletion | H |
| HKS-022 | Source/eval from an environment path | H |
| HKS-023 | Known campaign indicator | C |
| HKS-024 | Agent transcript-path access | I |

## Agent permissions and MCP

Markdown AGT-001 through AGT-007 require skill/agent classification. Claude
settings also have structural allowlist, deny-list and PreToolUse checks.
A hook key or empty array alone does not establish a configured gate.

| ID | Trigger | Base |
|---|---|---|
| AGT-001 | Wildcard/all agent permissions | C |
| AGT-002 | Agent privilege escalation | C |
| AGT-003 | Destructive operations without a human gate (opt-in) | H |
| AGT-004 | Wildcard permission grant | C |
| AGT-005 | Permissive tool allowlist | C/H |
| AGT-006 | Missing deny list | H |
| AGT-007 | Missing PreToolUse hook | M |
| AGT-008 | Directive-precedence override | C |
| AGT-009 | Stealth directive | C |
| MCP-001 | Tool exfiltration/browser-cookie pattern | C |
| MCP-002 | Shell/environment manipulation or Git-hook/config tampering | C |
| MCP-003 | Hidden tool-description instruction | C |
| MCP-004 | High-privilege server category | H |
| MCP-005 | Markdown `npx -y` | H |
| MCP-005 | Auto-approve all project MCP servers in settings | C |
| MCP-006 | MCP args contain `-y`/`--yes` | M |
| MCP-007 | `npx` package lacks an exact version | M |
| MCP-008 | External HTTP(S) transport | H |
| MCP-009 | Dangerous environment override | C |
| MCP-010 | Unrestricted root/home path | H |
| MCP-011 | Hardcoded sensitive MCP environment value | C |
| MCP-012 | Remote script piped to a shell | C |
| MCP-013 | Shell metacharacters in args | H |

AGT-005 Bash wildcard/sudo variants are CRITICAL; Write/Edit wildcard and other
dangerous Bash variants are HIGH. MCP-006 through MCP-011 require parsed
settings. MCP-007 recognizes versionless, floating and range specifications;
it is not package provenance verification. MCP-008 uses the parsed hostname
for loopback/local exemptions, not substrings in paths or queries.

## Skills and other agentic patterns

| ID | Trigger | Base |
|---|---|---|
| SKL-001 | Remote shell pipe or CLI credential extraction | C |
| SKL-001 | Loader-directory write, shell-history access, approval bypass | H |
| SKL-002 | Model endpoint override | C |
| SKL-003 | Permission bypass flag | C |
| SKL-004 | Bidi metadata or confusable name | H |
| SKL-004 | Discovery hijack | M |
| SKL-004 | Brand name | L |
| SKL-005 | Python YAML object tag, pickle family, JavaScript execution | C |
| SKL-005 | Unsafe `yaml.load` | M |
| SKL-005 | XML external entity pattern | H |
| SKL-006 | Host network exposure | H |
| SKL-007 | Unpinned dependency | M |
| SKL-007 | Missing version | I |
| SKL-008 | Scanner evasion | H |
| SKL-008 | Collapsed HTML details | L |
| SKL-010 | Client-specific permissions | M |
| LLM-002 | Insecure output handling | H |
| LLM-004 | Unbounded model work | H |
| LLM-005 | Unpinned package installation | H |
| LLM-008 | Destructive autonomous action | H |
| ASI-003 | Agent identity/privilege abuse | H |
| ASI-004 | Dynamic/unverified tool loading | H |
| ASI-005 | Unexpected code execution | C |
| ASI-006 | Unsafe memory persistence | H |
| ASI-007 | Insecure agent communication | H |
| ASI-008 | Unbounded delegation/cascading failure | M |
| ASI-009 | Human-agent trust exploitation | H |
| ASI-010 | Rogue replication/persistence | C |
| CFG-001 | World-writable agent configuration | H |

SKL-009 is not implemented. SKL-001 writes into `.github/skills/` become
CRITICAL. Skill name/version/platform checks require skill classification;
missing-version is omitted with `--skip-info-controls`. CFG-001 requires
file-mode metadata and a supported configuration filename.

## Opt-in prompt controls

CTL rules apply to classified prompt/skill/agent Markdown with
`--include-llm-controls`. CTL-001 through CTL-013 are omitted with
`--skip-info-controls`; CTL-014 through CTL-019 remain active.

| ID | Missing written control | Base |
|---|---|---|
| CTL-001 | System-prompt confidentiality | I |
| CTL-002 | Input validation/sanitization | I |
| CTL-003 | Output filtering/sanitization | I |
| CTL-004 | Rate limiting | I |
| CTL-005 | Scope/role constraint | I |
| CTL-006 | Bias mitigation | I |
| CTL-007 | Harmful-content safeguard | I |
| CTL-008 | Memory isolation | I |
| CTL-009 | Inter-agent authentication | I |
| CTL-010 | Behavioral monitoring/audit logging | I |
| CTL-011 | Indirect-injection defense | I |
| CTL-012 | Multilingual-bypass defense | I |
| CTL-013 | Context-overflow defense | I |
| CTL-014 | Data-leakage defense | C |
| CTL-015 | Role-boundary defense | H |
| CTL-016 | Social-engineering defense | M |
| CTL-017 | Unicode/encoding defense | M |
| CTL-018 | Output-weaponization defense | M |
| CTL-019 | Abuse prevention | L |

## Configuring the policy

There is no shared scanner policy-file format or per-rule enable/disable
setting. Configure the existing command controls instead:

```bash
# Human-readable gate, without trusting repository suppressions
ai-primitives-hub security scan . --ci --fail-on HIGH

# Structured output; display filtering does not weaken the failure policy
ai-primitives-hub security scan . --severity CRITICAL --fail-on HIGH -o json

# Opt-in prompt controls and a narrower input set
ai-primitives-hub security scan skills/ --include-llm-controls \
  --exclude .git --exclude node_modules --exclude examples
```

`--fail-on` evaluates all unsuppressed findings before display filtering.
Incomplete coverage fails even with `--fail-on none`. Repository ignores are
for local triage; security gates should use `none` or protected baselines.
JSON, YAML and NDJSON are supported alongside text and opt-in saved reports.
See the [scanner reference](security-scanner.md) for option defaults,
suppression caveats, output contracts and exit codes.

## Maintenance

The native rule definitions and structural evaluator are the behavioral source
of truth. This catalogue must be updated with rule changes. Rule-pack metadata
hashes pattern source/flags and rule metadata; evaluator/parser changes also
require a revision bump. A digest identifies the declared pack revision, not
an independent proof of implementation integrity or safety.

## See also

- [Security scanning guide](../user-guide/security-scanning.md)
- [Scanner command and result reference](security-scanner.md)
- [Scanner maintenance](../contributor-guide/security-scanner-maintenance.md)
