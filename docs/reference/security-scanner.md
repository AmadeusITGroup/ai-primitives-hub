# Security Scanner Reference

This page is the stable reference for `ai-primitives-hub security scan` and the shared security result model.

## Command synopsis

```text
ai-primitives-hub security scan [PATH...]
```

With no path, the command scans the current working directory. The native engine is bundled with the CLI and requires no Python or network service.

## Options

| Option | Description |
|---|---|
| `--ext <EXT>` | Directory extensions; repeatable. Defaults to `.md` and `.markdown`. |
| `--no-recursive` | Restrict directory inputs to their immediate level. |
| `--exclude <PATTERN>` | Exclude path components; repeatable. Defaults to `.git` and `node_modules`. |
| `--include-doc-files` | Include README and CHANGELOG files in directory scans. |
| `--severity <LEVEL>` | Report exact severity values; repeatable. |
| `--minimum-severity <LEVEL>` | Report this severity and more severe findings. |
| `--include-llm-controls` | Enable CTL and AGT-003 control checks. |
| `--skip-info-controls` | Omit CTL-001 through CTL-013 when controls are enabled. |
| `--fail-on <POLICY>` | `none`, `any`, or a severity threshold. Defaults to `HIGH`. |
| `--ci` | Use fail-closed CI defaults. |
| `--allow-empty` | Treat an empty candidate set as a successful complete scan. |
| `--ignore-trust <MODE>` | `repository`, `none`, or `baseline`. |
| `--baseline-suppressions <PATH>` | Trusted `.markdown.ignore` file for baseline mode. |
| `--baseline-file-ignore <PATH>` | Trusted `.markdown-file.ignore` file for baseline mode. |
| `--engine <ID>` | Select a registered engine. The default is `builtin`. |
| `--compatibility <ID>` | Select the compatibility profile. Defaults to `md-security-scanner@1.10.9`. |
| `--max-files <N>` | Maximum discovered regular files. Default `10000`. |
| `--max-file-bytes <N>` | Maximum bytes per input file. Default `1048576`. |
| `--max-total-bytes <N>` | Maximum total input bytes. Default `104857600`. |
| `--max-depth <N>` | Maximum directory depth. Default `64`. |
| `--max-findings <N>` | Maximum findings. Default `5000`. |
| `--timeout <DURATION>` | Whole-scan timeout, such as `60s`, `2m`, or `5000ms`. |
| `--report-json <PATH>` | Write a redacted JSON report. |
| `--report-markdown <PATH>` | Write a redacted Markdown report. |
| `--output-directory <DIR>` | Write both reports under this directory. |
| `--output-name <NAME>` | Basename used with `--output-directory`; defaults to `security-report`. |
| `--report-overwrite <MODE>` | `never` or `replace`; defaults to `never`. |
| `--report` | Print the Markdown report; text output only. |
| `-o, --output <FORMAT>` | `text`, `json`, `yaml`, or `ndjson`. |

## Exit codes

The failure policy and display filter are separate. `--severity` and `--minimum-severity` do not weaken `--fail-on`.

| Code | Meaning |
|---:|---|
| `0` | Complete and policy passed |
| `1` | Complete and policy failed |
| `64` | Usage error |
| `65` | Incomplete or missing input |
| `70` | Unexpected software error |
| `74` | Input/report filesystem error |

## Output formats

- `text`: concise human summary;
- `json`: AI Primitives Hub envelope containing a versioned scan result;
- `yaml`: equivalent structured envelope in YAML;
- `ndjson`: `scan.header`, `scan.finding`, coverage-error, and `scan.summary` records.

Finding fields include the rule ID, variant/title, severity, confidence, category, relative location, remediation, mapping, and legacy exact/canonical fingerprints. Secret evidence is `[REDACTED]` unless a future explicitly reviewed evidence mode permits otherwise.

## Rule families

The compatibility profile follows the behavior of **MD Security Scanner `1.10.9`**, an internal Amadeus tool that is not publicly disclosed. This repository does not redistribute that tool, depend on it, or publish internal URLs. The native implementation maintains the approved rule-family vocabulary:

| Family | Purpose |
|---|---|
| `SEC-*` | Secrets, credentials, entropy, and credential-file references |
| `INJ-*` | Prompt injection, hidden text, encoding, and trust-boundary issues |
| `MD-*` | Markdown/HTML/rendering injection |
| `LLM-*` | LLM output, denial-of-service, and supply-chain patterns |
| `AGT-*` | Agent permissions, authority, autonomy, and approval controls |
| `ASI-*` | Agentic security intelligence patterns |
| `MCP-*` | MCP and tool-poisoning patterns |
| `SKL-*` | Agentic skill supply-chain and governance patterns |
| `HKS-*` | Hook, shell, persistence, and host-command patterns |
| `CFG-*` | Agent configuration file safety |
| `CTL-*` | Missing prompt-level controls and active defenses |

Rule IDs are versioned content identifiers, not a promise that every numbered value in a family exists. The rule-pack manifest is the source of truth.

## Ignore files

`.markdown.ignore` suppresses a finding by its exact or canonical 32-character hexadecimal fingerprint. `.markdown-file.ignore` excludes whole files by filename, relative path, or glob. Both formats accept blank lines and comments and are scoped to their directory hierarchy.

Use `--ignore-trust none` for security gates over attacker-controlled changes. Use `baseline` only with files selected by the calling system from a trusted source.

## Safety limits

The default engine limits input to 10,000 files, 1 MiB per file, 100 MiB total, depth 64, 5,000 findings, 64 KiB/1,024 lines per ignore file, 10 MiB per report, and 60 seconds per scan. Symbolic links and special files are not followed. Limit or read failures produce an incomplete result rather than a clean result.

## Remediation

A finding is a signal for triage, not an automatic patch instruction:

1. identify the rule and inspect its location in the artifact;
2. determine whether the content is active configuration, an example, or documentation;
3. apply the recommended secure pattern;
4. rotate any real exposed credential and check history;
5. re-scan;
6. suppress only a reviewed false positive, with a rationale comment.

Prompt delimiters and written security constraints are defense in depth. They do not replace authorization, sandboxing, network controls, or human approval gates.

## API and architecture

The scanner is exposed through `@ai-primitives-hub/app` as a delivery-neutral use case. Core owns the normalized domain contracts, fingerprints, suppression semantics, policy, and pure rules. Infra owns bounded filesystem discovery, atomic report storage, and worker isolation. The CLI and VS Code extension are delivery adapters.

See [Security Scanner Architecture](../contributor-guide/architecture/security-scanner.md) for the component and data-flow diagrams.
