/**
 * Fix suggestions for findings that come without one, looked up by exact rule id first and then
 * by rule family prefix.
 * @module domain/quality/remediation
 */

const GENERIC = 'Review the finding in context. If it is documentation that only quotes the pattern, move it into a fenced '
  + 'code block or an example section; otherwise rewrite it.';

const BY_RULE: Readonly<Record<string, string>> = {
  'HKS-001': 'Do not pipe a download into a shell. Download a pinned version, verify its checksum, then run it.',
  'SKL-001': 'Do not pipe a download into a shell, write into agent loader directories, or read CLI credentials. Ship the files explicitly and verify downloads by checksum.',
  'MCP-012': 'Do not pipe a remote script into a shell. Pin the package version or vendor the script.',
  'MCP-005': 'Pin the package: `npx -y <package>@<exact-version>` instead of the floating latest.',
  'SKL-007': 'Pin dependencies to exact versions instead of ranges (`~`, `^`, `>=`).',
  'LLM-005': 'Pin installs to an exact version, e.g. `pip install pkg==1.2.3`, `npm install pkg@1.2.3`.',
  'HKS-007': 'Avoid global package installs in hooks or scripts; use a pinned, project-local dependency.',
  'AGT-001': 'Replace wildcard permissions with the specific tools and paths the agent needs.',
  'AGT-004': 'Remove allow-all wording; list the exact tools or commands the agent may use.',
  'AGT-005': 'Narrow the tool allowlist; remove `Bash(*)` and `sudo`.',
  'AGT-003': 'Add an explicit human-approval step before destructive actions (delete, deploy, publish).',
  'LLM-008': 'Require human approval before destructive actions and say so in the instructions.',
  'SKL-008': 'Remove wording that asks to disable or evade security scanning.',
  'INJ-004': 'Remove instructions hidden in HTML comments; keep all instructions visible.',
  'INJ-006': 'Remove base64-encoded instructions; ship the instruction as plain text.',
  'MD-003': 'Remove `javascript:` links; use normal https links.',
  'MD-033': 'Remove obfuscated `javascript:` links; use normal https links.',
  'MD-001': 'Remove raw executable HTML (script, iframe, object, embed, form); use Markdown.',
  'MD-002': 'Remove HTML event handlers such as `onclick=`.',
  'SEC-014': 'Remove the exfiltration or out-of-band URL, or replace it with a documented, trusted endpoint.',
  'SEC-022': 'Do not echo secrets or sensitive environment variables to output or logs.',
  'SEC-027': 'Do not reference credential files from instructions; pass credentials through the environment\'s secret store.'
};

const BY_PREFIX: readonly (readonly [string, string])[] = [
  ['SEC-', 'Treat the secret as exposed: revoke or rotate it now, remove it from the file, and load it from a secret store or environment variable. Rewriting history alone is not enough.'],
  ['INJ-', 'Remove or rewrite text that overrides the agent\'s rules or hides instructions. Keep user data separate from instructions.'],
  ['MD-', 'Remove raw HTML, script-like links and unsafe renderer settings from the Markdown; use plain Markdown.'],
  ['HKS-', 'Remove the dangerous shell behaviour from the hook or script, or replace it with a narrow, pinned and documented command.'],
  ['AGT-', 'Grant the narrowest permissions the agent needs and require human approval for destructive actions.'],
  ['MCP-', 'Check the MCP server definition: pin package versions, avoid shell metacharacters, and do not hide instructions in tool descriptions.'],
  ['SKL-', 'Fix the skill definition: no credential extraction, no approval bypass, pinned dependencies, and no hidden or look-alike characters.'],
  ['LLM-', 'Handle model output as untrusted, avoid unbounded loops, and pin package installs.'],
  ['ASI-', 'Do not let the agent load unverified tools, persist untrusted memory, or delegate without limits.'],
  ['CTL-', 'Informational: consider adding the missing safeguard to the instructions.']
];

/**
 * Suggested fix for a rule.
 * @param ruleId - Scanner rule id, e.g. `HKS-001`
 */
export const recommendedFixFor = (ruleId: string): string =>
  (Object.hasOwn(BY_RULE, ruleId) ? BY_RULE[ruleId] : undefined)
  ?? BY_PREFIX.find(([prefix]) => ruleId.startsWith(prefix))?.[1] ?? GENERIC;
