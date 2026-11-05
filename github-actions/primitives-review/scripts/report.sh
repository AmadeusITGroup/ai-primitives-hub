#!/usr/bin/env bash
# Turns the review JSON lines into report.json and report.md, sets the step outputs, writes the
# job summary, and applies the optional fail-below grade.
#
# Inputs (environment):
#   RESULTS_FILE, RUBRIC_FILE, REPORT_DIR, INPUT_MODEL
#   INPUT_FAIL_BELOW   grade letter; fail when any primitive scores below it (empty = advisory)
#   INPUT_STEP_SUMMARY 'true' to append report.md to the job summary
set -euo pipefail

: "${RESULTS_FILE:?}" "${RUBRIC_FILE:?}" "${REPORT_DIR:?}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
mkdir -p "$REPORT_DIR"
json="${REPORT_DIR}/report.json"
md="${REPORT_DIR}/report.md"

jq -s --slurpfile rubric "$RUBRIC_FILE" --arg model "${INPUT_MODEL:-}" '{
  model: $model,
  rubric_version: $rubric[0].version,
  reviewed: length,
  average_score: (if length == 0 then null else ([.[].score | select(. != null)] | if length == 0 then null else (add / length | round) end) end),
  lowest_grade: ([.[].grade | select(. != "?")] | sort | last // null),
  primitives: .
}' "$RESULTS_FILE" >"$json"

# Markdown table cells: one line, no pipes.
jq -r '
  def cell: tostring | gsub("[\r\n]+"; " ") | gsub("\\|"; "\\|") | if length > 220 then .[0:217] + "..." else . end;
  def code: if . == "" or . == null then "" else "`" + (tostring | gsub("`"; "'\''") | cell) + "`" end;
  def icon: if . == "A" then "🟢" elif . == "B" then "🟢" elif . == "C" then "🟡" elif . == "D" then "🟠" elif . == "E" then "🔴" else "⚪" end;
  def sev: if . == "CRITICAL" then "🔴 CRITICAL" elif . == "HIGH" then "🟠 HIGH" elif . == "MEDIUM" then "🟡 MEDIUM" elif . == "LOW" then "🟢 LOW" else "⚪ \(.)" end;
  "## 🧭 AI primitives quality review",
  "",
  "Reviewed **\(.reviewed)** primitive(s) with `\(.model)` against rubric v\(.rubric_version)" + (if .average_score != null then " · average score **\(.average_score)/100**" else "" end) + ".",
  "",
  (if .reviewed == 0 then "No primitives were found under the given path." else
    "| Primitive | Type | Score | Grade | Static findings | Main improvement |",
    "|---|---|---|---|---|---|",
    (.primitives[] |
      ([.criteria[] | select(.score != null and (.raised_by // null) == null and ((.suggestion // "") != "" or .score < 5))] | sort_by(.score, -.weight) | first) as $worst
      | "| `\(.path | cell)` | \(.type) | \(.score // "n/a") | \(.grade | icon) \(.grade) | \(.static_findings | length) | \(if $worst == null then (.error // "" | cell) else "\($worst.id) \($worst.name): \(($worst.suggestion // "") | if . == "" then ($worst.finding // "") else . end | cell)" end) |"),
    "",
    (.primitives[] |
      "<details><summary><b>\(.path | cell)</b> — \(.grade | icon) \(.grade) (\(.score // "n/a")/100)</summary>",
      "",
      (if .summary != "" then (.summary | cell), "" else empty end),
      (if .error != null then "> ⚠️ \(.error)", "" else empty end),
      "| Criterion | Score | Evidence | Finding | Suggestion |",
      "|---|---|---|---|---|",
      (.criteria[] | "| \(.id) \(.name) (×\(.weight)) | \(.score // "n/a")\(if .capped_by != null then " ⛔ capped: \(.capped_by | cell)" elif (.raised_by // null) != null then " ⬆️ checked: \(.raised_by | cell)" else "" end) | \(.evidence | code) | \(.finding | cell) | \(.suggestion | cell) |"),
      "",
      (if (.risks | length) > 0 then
        "**Risk indications (AI, evidence verified)**", "",
        "| Severity | Family | Evidence | Why | Mitigation |", "|---|---|---|---|---|",
        (.risks[] | "| \(.severity | sev) | \(.family) | \(.evidence | code) | \(.why | cell) | \(.mitigation | cell) |"), ""
       else empty end),
      (if (.static_findings | length) > 0 then
        "**Static scanner findings**", "",
        "| Severity | Rule | Line | Title |", "|---|---|---|---|",
        (.static_findings | sort_by({"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}[.severity] // 5, .line // 0)[] | "| \(.severity | sev) | \(.ruleId) | \(.line // "-") | \(.title | cell) |"), ""
       else empty end),
      (if .risks_dropped > 0 then "_\(.risks_dropped) AI risk indication(s) dropped because their quoted evidence is not in the file._", "" else empty end),
      (if .truncated then "_The file was truncated for review._", "" else empty end),
      "</details>", ""
    )
  end),
  "_Scores are AI-assisted and advisory. Caps come from deterministic checks and the static scanner; evidence that does not appear in the file is discarded. Verify before acting._"
' "$json" >"$md"

reviewed="$(jq -r '.reviewed' "$json")"
average="$(jq -r '.average_score // ""' "$json")"
lowest="$(jq -r '.lowest_grade // ""' "$json")"
{
  echo "report-json=${json}"
  echo "report-markdown=${md}"
  echo "reviewed=${reviewed}"
  echo "average-score=${average}"
  echo "lowest-grade=${lowest}"
} >>"$out"

if [[ "${INPUT_STEP_SUMMARY:-true}" == true && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$md" >>"$GITHUB_STEP_SUMMARY"
fi
echo "Reviewed ${reviewed}; average ${average:-n/a}; lowest grade ${lowest:-n/a}. Report: ${md}"

threshold="${INPUT_FAIL_BELOW:-}"
if [[ -n "$threshold" ]]; then
  threshold="$(tr '[:lower:]' '[:upper:]' <<<"$threshold")"
  jq -e --arg g "$threshold" '[.grades[].grade] | index($g) != null' "$RUBRIC_FILE" >/dev/null ||
    { echo "::error::fail-below must be one of $(jq -r '[.grades[].grade] | join(", ")' "$RUBRIC_FILE"), got '${threshold}'"; exit 1; }
  failing="$(jq -r --arg g "$threshold" '.primitives[] | select(.grade != "?" and .grade > $g) | "\(.path) (\(.grade))"' "$json")"
  if [[ -n "$failing" ]]; then
    echo "::error::Primitives graded below ${threshold}: $(paste -sd ',' - <<<"$failing" | sed 's/,/, /g')"
    exit 1
  fi
fi
