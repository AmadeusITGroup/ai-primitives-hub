#!/usr/bin/env bash
# Runs the AI Primitives Hub static security scanner on the discovered primitives and writes
# its findings as JSON lines keyed by workspace-relative path. Advisory: never fails the job.
#
# Inputs (environment):
#   PRIMITIVES_FILE      JSON lines from discover.sh
#   INPUT_CLI_VERSION    exact @ai-primitives-hub/cli version that includes `security scan`
#   INPUT_INCLUDE_LLM_CONTROLS  'true' to add --include-llm-controls
#   SCANNER_CMD          optional scanner command (for local testing); overrides the npx install
#   OUT_FILE             where the findings JSON lines are written
set -uo pipefail

: "${PRIMITIVES_FILE:?}" "${OUT_FILE:?}"
workspace="${GITHUB_WORKSPACE:-$PWD}"
: >"$OUT_FILE"

if [[ -n "${SCANNER_CMD:-}" ]]; then
  read -r -a scanner <<<"$SCANNER_CMD"
elif [[ -n "${INPUT_CLI_VERSION:-}" ]]; then
  scanner=(npx --yes "@ai-primitives-hub/cli@${INPUT_CLI_VERSION}")
else
  echo "Static scan skipped (set cli-version to include scanner findings)."
  exit 0
fi

files=()
while IFS= read -r p; do files+=("$p"); done < <(jq -r '.path' "$PRIMITIVES_FILE")
[[ ${#files[@]} -gt 0 ]] || exit 0

args=(security scan --ci --ignore-trust none --fail-on none -o json)
[[ "${INPUT_INCLUDE_LLM_CONTROLS:-false}" == true ]] && args+=(--include-llm-controls)

raw="$(mktemp)"
trap 'rm -f "$raw"' EXIT
(cd "$workspace" && "${scanner[@]}" "${args[@]}" -- "${files[@]}") >"$raw" 2>"${raw}.err"
status=$?
if ! jq -e '.data.findings' "$raw" >/dev/null 2>&1; then
  echo "::warning::The static scanner produced no JSON report (exit ${status}); continuing without its findings. $(head -c 300 "${raw}.err")"
  rm -f "${raw}.err"
  exit 0
fi
rm -f "${raw}.err"

# Finding paths are relative to the scan root; turn them into workspace-relative paths.
real_workspace="$(cd "$workspace" && pwd -P)"
jq -c --arg ws "$real_workspace" '
  .data.findings[]
  | . as $f
  | (($f.rootId // "") | if . == "" then $ws else . end) as $root
  | (if ($root | endswith(".md")) then $root else ($root + "/" + $f.file) end) as $abs
  | {
      path: ($abs | ltrimstr($ws + "/")),
      ruleId: $f.ruleId,
      severity: $f.severity,
      line: $f.line,
      title: $f.title,
      fix: ($f.recommendedFix // "")
    }
' "$raw" >"$OUT_FILE"

echo "Static findings: $(wc -l <"$OUT_FILE" | tr -d ' ') (scanner exit ${status})"
