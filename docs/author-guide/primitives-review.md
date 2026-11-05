# Reviewing Primitives with Gemma 4

The `github-actions/primitives-review` action reviews AI primitives against a quality rubric and reports a score, a grade, risk indications, and a concrete suggestion for each one. You give it a path; it finds the prompts, instructions, agents, and skills under that path and reviews each one with Google Gemma 4 (default `gemma4:e2b`) running on the GitHub runner.

The review is advisory unless you set `fail-below`. It complements, and does not replace, the deterministic [security scanner](../user-guide/security-scanning.md), which stays the security gate.

## Quick start

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v4
  - uses: AmadeusITGroup/ai-primitives-hub/github-actions/primitives-review@<commit-sha>
    with:
      path: skills/ prompts/code-review.prompt.md
```

Pin the action to a full commit SHA. The report appears in the job summary and is uploaded as the `primitives-review` artifact (`report.md` and `report.json`).

A complete workflow that reviews the primitives changed in a pull request, or any path entered from the Actions tab, is in [`github-actions/primitives-review/examples`](https://github.com/AmadeusITGroup/ai-primitives-hub/tree/main/github-actions/primitives-review/examples).

## What gets reviewed

| File | Type |
|---|---|
| `*.prompt.md` | prompt |
| `*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md`, `.kiro/steering/*.md` | instruction |
| `*.agent.md`, `*.chatmode.md` | agent |
| `SKILL.md` | skill |

Directories are searched recursively. In a Git checkout, files excluded by `.gitignore` are skipped. Other files named explicitly in `path` are skipped with a warning.

## The rubric

Each criterion comes from the existing author guides and the security scanner's rule catalogue. Every primitive is scored from 1 to 5 on the criteria that apply to its type.

| ID | Criterion | Weight | Based on |
|---|---|---|---|
| R1 | Purpose and scope | 2 | [Primitive types](agentic-primitives-guide.md#primitive-types-comparison), [single responsibility](creating-skills.md#best-practices), CTL-005 |
| R2 | Structure and metadata | 1 | [Detailed guide](agentic-primitives-guide.md#detailed-guide), [naming conventions](agentic-primitives-guide.md#2-naming-conventions), [required skill frontmatter](creating-skills.md#required-frontmatter-fields), SKL-004, SKL-007 |
| R3 | Clarity of instructions | 2 | [Content quality](agentic-primitives-guide.md#3-content-quality), AGT-008, AGT-009, INJ-007 |
| R4 | Examples, edge cases and limitations | 1 | [Content quality](agentic-primitives-guide.md#3-content-quality), [clear documentation](creating-skills.md#best-practices) |
| R5 | Least privilege and tools | 2 | [Allowed tools](creating-skills.md#allowed-tools), tool minimization, AGT-\*, MCP-\*, SKL-003, SKL-010 |
| R6 | Safe execution and human control | 2 | HKS-\*, ASI-\*, AGT-003, SKL-001, SKL-005, LLM-004, LLM-008 |
| R7 | Untrusted input and data protection | 2 | INJ-\*, SEC-\*, MD-\*, LLM-002, CTL-011, CTL-014, CTL-015 |

Rule IDs refer to the [security detection rules](../reference/security-rules.md). The score is the weighted average scaled to 0–100, and the grade is A (85+), B (70+), C (55+), D (40+), or E.

The rubric lives in [`rubric.json`](https://github.com/AmadeusITGroup/ai-primitives-hub/blob/main/github-actions/primitives-review/rubric.json). To use your own criteria, weights, or grade boundaries, copy it into your repository and pass it with `rubric-file`.

## How scores stay grounded

A small model can be wrong, so the action limits what the model decides:

- **Checked facts.** Frontmatter, title, sections, naming, and wildcard tool permissions are checked by script and given to the model. They can cap a score (for example, a wildcard in `allowed-tools` caps R5 at 1) or raise one (a primitive with a title and sections scores at least 3 on R2).
- **Static scanner caps.** When `cli-version` (or `scanner-command`) is set, the security scanner runs first. A CRITICAL finding caps the matching criterion at 1, HIGH at 2, and MEDIUM at 3. The cap and its rule are shown in the report.
- **Evidence check.** The model must quote the file. A risk indication whose quote is not in the file is discarded, and the report says how many were dropped.
- **Untrusted content.** The primitive is sent as data. Instructions inside it are reported as `INJ` risks, not followed.

## Inputs

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Space- or newline-separated files or directories. |
| `rubric-file` | bundled `rubric.json` | Custom rubric. |
| `model` | `gemma4:e2b` | Ollama model tag; larger models need bigger or self-hosted runners. |
| `cli-version` | | Exact `@ai-primitives-hub/cli` version with `security scan`, to add static findings and caps. Empty skips the static scan. |
| `include-llm-controls` | `false` | Pass `--include-llm-controls` to the scanner. |
| `scanner-command` | | Run a CLI built in your repository instead of `cli-version`. |
| `fail-below` | | Fail when any primitive grades below this letter. Empty keeps the review advisory. |
| `max-files` | `20` | Maximum primitives reviewed. |
| `max-file-bytes` | `12000` | Bytes per primitive sent to the model; longer files are truncated and flagged. |
| `num-ctx`, `max-tokens`, `request-timeout` | `16384`, `2048`, `600` | Model limits per review. |
| `report-dir` | `$RUNNER_TEMP/primitives-review` | Where reports are written. |
| `step-summary`, `upload-artifact` | `true`, `true` | Report destinations. |
| `ollama-version`, `ollama-host`, `cache` | `v0.40.13`, `127.0.0.1:11434`, `true` | Same as the [Gemma 4 action](../user-guide/gemma4-action.md). |

Outputs: `reviewed`, `average-score`, `lowest-grade`, `report-json`, `report-markdown`.

## Performance

Each primitive takes about 5 to 15 seconds on a laptop with `gemma4:e2b`; hosted runners are slower because they run on CPU. The first run also downloads about 4.6 GB, which is cached afterwards. On pull requests, review only the changed primitives, as the example workflow does.

## Limitations

- Scores from `gemma4:e2b` are a first-pass signal. Use them to focus human review, not to replace it.
- Without schema enforcement (some macOS Ollama builds), the model is asked for plain JSON; an answer that does not parse is retried once and then reported as an error.
- Collections (`*.collection.yml`), hooks, and MCP configuration are not reviewed by the rubric; the static scanner still covers Claude settings files.

## See also

- [Agentic Primitives Guide](agentic-primitives-guide.md)
- [Creating Skills](creating-skills.md)
- [Security Scanning](../user-guide/security-scanning.md)
- [Security Detection Rules](../reference/security-rules.md)
- [Gemma 4 in GitHub Actions](../user-guide/gemma4-action.md)
