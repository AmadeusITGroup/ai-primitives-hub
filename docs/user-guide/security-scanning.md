# Security Scanning

AI Primitives Hub includes a native static security scanner for Markdown-based AI artifacts such as prompts, instructions, agents, skills, hooks, and supported Claude configuration files.

The scanner looks for suspicious content and unsafe configuration patterns. It does not execute files, call an LLM, access the network, or replace human security review.

## Quick start

From an AI Primitives Hub or primitive source repository:

```bash
ai-primitives-hub security scan
```

Scan selected files or directories:

```bash
ai-primitives-hub security scan skills/ agents/reviewer/SKILL.md
```

The default directory scan:

- recursively considers `.md` and `.markdown` files;
- skips `.git` and `node_modules`;
- skips `README.md` and `CHANGELOG.md` unless `--include-doc-files` is used;
- discovers `.claude/settings.json` and `.claude/settings.local.json`;
- does not follow symbolic links;
- prints a summary without creating report files.

## Reading results

Each finding has a rule ID, severity, confidence, location, risk explanation, recommended fix, and stable fingerprints.

| Severity | Meaning |
|---|---|
| `CRITICAL` | Immediate security concern, such as exposed credentials, code execution, or direct exfiltration |
| `HIGH` | Serious weakness that should be addressed before publication or deployment |
| `MEDIUM` | Suspicious or context-dependent behavior requiring review |
| `LOW` | Lower-impact hygiene or transport concern |
| `INFO` | Missing prompt-level control or informational guidance |

Secret evidence is shown as `[REDACTED]` by default. Do not paste credentials into reports or issue comments. If a credential was real, rotate it and audit repository history.

Limit displayed findings:

```bash
ai-primitives-hub security scan . --minimum-severity HIGH
ai-primitives-hub security scan . --severity CRITICAL HIGH
```

The severity filter controls the reported findings. The failure policy is independent:

```bash
ai-primitives-hub security scan . --fail-on HIGH
```

`--fail-on HIGH` fails when an unsuppressed `HIGH` or `CRITICAL` finding exists, even if the displayed report was narrowed with a severity filter.

## Prompt-control checks

Missing LLM controls are disabled by default because they can be noisy for general documentation. Enable them explicitly for prompts, agents, and skills:

```bash
ai-primitives-hub security scan . --include-llm-controls
```

To omit the informational `CTL-001`–`CTL-013` checks while retaining active controls:

```bash
ai-primitives-hub security scan . --include-llm-controls --skip-info-controls
```

These checks assess instructions written in an artifact. They do not enforce runtime IAM, sandboxing, rate limits, authentication, or output filtering.

## False positives and ignored files

Use `.markdown.ignore` for a triaged finding. Put one fingerprint on each line:

```text
# Exact occurrence in one file
0123456789abcdef0123456789abcdef # explain the accepted false positive
```

A finding's **fingerprint** suppresses one occurrence. Its **canonical fingerprint** suppresses the same rule/content pattern across files. The report provides copyable values.

Use `.markdown-file.ignore` to exclude complete files:

```text
# Simple filename
examples.md

# Relative path or glob
references/*.md
docs/**
```

Both files support blank lines and `#` comments. They apply to their directory subtree and applicable ancestors. Ignore files are bounded and malformed entries are reported.

### CI trust modes

Repository-controlled ignore files can hide findings introduced by a pull request. CI should use:

```bash
ai-primitives-hub security scan . --ci
```

`--ci` uses fail-closed defaults, including `--ignore-trust none`. The explicit modes are:

- `repository` — honor repository ignore files; suitable for local triage;
- `none` — honor neither repository suppression nor whole-file ignore files;
- `baseline` — use only caller-supplied, trusted baseline files.

For baseline mode, provide files from a protected source rather than from the pull request under test:

```bash
ai-primitives-hub security scan . \
  --ci --ignore-trust baseline \
  --baseline-suppressions /protected/baseline/.markdown.ignore \
  --baseline-file-ignore /protected/baseline/.markdown-file.ignore
```

## Reports and automation

Reports are opt-in:

```bash
ai-primitives-hub security scan . \
  --report-json artifacts/security.json \
  --report-markdown artifacts/security.md
```

The files are written atomically. Secret evidence remains redacted. JSON, YAML, and NDJSON are intended for automation; Markdown is intended for review.

The CLI exits with:

| Code | Meaning |
|---:|---|
| `0` | Complete scan and failure policy passed |
| `1` | Complete scan but the failure policy was not met |
| `64` | Invalid command usage |
| `65` | Incomplete scan, missing input, limit, or cancellation outcome |
| `70` | Unexpected software failure |
| `74` | Report or input filesystem failure |

A GitHub Actions job should invoke the released CLI with `--ci`, `--ignore-trust none`, and an explicit `--fail-on` policy. Keep workflow permissions at `contents: read` unless a separate, reviewed reporting job needs more access.

## VS Code

The AI Primitives Hub extension provides:

- **Security Scan Current File**;
- **Security Scan Workspace**;
- **Show Last Security Report**;
- **Clear Security Diagnostics**.

Automatic save scans are enabled by default only for trusted local `file:` workspaces. They are disabled for untrusted or virtual workspaces. Save events are debounced and a newer scan supersedes an older scan for the same file or workspace.

Configure the extension under `promptregistry.security.*`. See the [Settings Reference](../reference/settings.md). The extension uses the shared scanner and does not require Python.

## Limitations

Static scanning cannot determine runtime behavior or prove that an artifact is safe. It can miss context-specific attacks and can report examples or intentionally educational text. Use confidence, review the surrounding artifact, remediate real findings, and suppress only after triage.

The scanner does not modify source files automatically. It should be combined with repository review, least-privilege tool configuration, secret management, sandboxing, dynamic testing, and an appropriate security approval process.

## See also

- [Command Reference](../reference/commands.md)
- [Security Scanner Reference](../reference/security-scanner.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Vulnerability remediation guidance](../reference/security-scanner.md#remediation)
