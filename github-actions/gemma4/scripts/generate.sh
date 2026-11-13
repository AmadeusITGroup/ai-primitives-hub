#!/usr/bin/env bash
# Sends one chat request to Ollama and publishes the answer as step outputs, a file and a job summary.
# All inputs arrive through environment variables and are passed to jq as data, never evaluated.
set -euo pipefail

: "${BASE_URL:?}" "${INPUT_MODEL:?}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/gemma4-action.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Build the prompt: the instruction text first, then the file content.
prompt_path="${work}/prompt.txt"
printf '%s' "${INPUT_PROMPT:-}" >"$prompt_path"
if [[ -n "${INPUT_PROMPT_FILE:-}" ]]; then
  file="$INPUT_PROMPT_FILE"
  [[ "$file" == /* ]] || file="${GITHUB_WORKSPACE:-$PWD}/${file}"
  if [[ ! -f "$file" ]]; then
    echo "::error::prompt-file not found: ${INPUT_PROMPT_FILE}"
    exit 1
  fi
  [[ -s "$prompt_path" ]] && printf '\n\n' >>"$prompt_path"
  cat "$file" >>"$prompt_path"
fi
if [[ ! -s "$prompt_path" ]]; then
  echo "::error::The prompt is empty; set prompt or prompt-file."
  exit 1
fi

if ! jq -n \
  --arg model "$INPUT_MODEL" \
  --arg system "${INPUT_SYSTEM:-}" \
  --rawfile prompt "$prompt_path" \
  --arg think "${INPUT_THINK:-}" \
  --arg format "${INPUT_FORMAT:-}" \
  --arg temperature "${INPUT_TEMPERATURE:-}" \
  --arg seed "${INPUT_SEED:-}" \
  --arg num_predict "${INPUT_MAX_TOKENS:-}" \
  --arg num_ctx "${INPUT_NUM_CTX:-}" \
  --arg keep_alive "${INPUT_KEEP_ALIVE:-}" '
  def num($name; $v):
    if $v == "" then null
    else ($v | tonumber? // error("\($name) must be a number, got \"\($v)\"")) end;
  {
    model: $model,
    stream: false,
    messages: ((if $system != "" then [{role: "system", content: $system}] else [] end)
               + [{role: "user", content: $prompt}]),
    options: ({
      temperature: num("temperature"; $temperature),
      seed: num("seed"; $seed),
      num_predict: num("max-tokens"; $num_predict),
      num_ctx: num("num-ctx"; $num_ctx)
    } | with_entries(select(.value != null)))
  }
  + (if $think == "" then {}
     elif $think == "true" then {think: true}
     elif $think == "false" then {think: false}
     else {think: $think} end)
  + (if $format == "" then {}
     elif $format == "json" then {format: "json"}
     else {format: ($format | fromjson? // error("format must be \"json\" or a JSON schema"))} end)
  + (if $keep_alive == "" then {} else {keep_alive: $keep_alive} end)
' >"${work}/request.json"; then
  echo "::error::Invalid action inputs (see the jq message above)."
  exit 1
fi

echo "Asking ${INPUT_MODEL} ($(wc -c <"$prompt_path" | tr -d ' ') prompt bytes)"
http_code="$(curl -sS --max-time "${INPUT_REQUEST_TIMEOUT:-900}" -o "${work}/response.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary "@${work}/request.json" "${BASE_URL}/api/chat")" || {
  echo "::error::No answer from Ollama within ${INPUT_REQUEST_TIMEOUT:-900}s (or the connection failed)."
  exit 1
}
if [[ "$http_code" != 200 ]] || jq -e '.error' "${work}/response.json" >/dev/null 2>&1; then
  echo "::error::Ollama returned HTTP ${http_code}: $(jq -r '.error // .' "${work}/response.json" 2>/dev/null || cat "${work}/response.json")"
  if [[ "$http_code" == 501 && -n "${INPUT_FORMAT:-}" ]]; then
    echo "::error::This Ollama build cannot enforce 'format' for ${INPUT_MODEL} (some macOS/MLX builds ship without the grammar library). Use the default Linux install, or drop 'format' and ask for JSON in the prompt."
  fi
  exit 1
fi

response_file="${INPUT_OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/gemma4-response.md}"
mkdir -p "$(dirname "$response_file")"
jq -j '.message.content // ""' "${work}/response.json" >"$response_file"

done_reason="$(jq -r '.done_reason // "unknown"' "${work}/response.json")"
prompt_tokens="$(jq -r '.prompt_eval_count // 0' "${work}/response.json")"
response_tokens="$(jq -r '.eval_count // 0' "${work}/response.json")"
tps="$(jq -r 'if (.eval_duration // 0) > 0 then ((.eval_count / (.eval_duration / 1e9)) * 10 | round / 10) else 0 end' "${work}/response.json")"
total_s="$(jq -r '((.total_duration // 0) / 1e9 * 10 | round / 10)' "${work}/response.json")"

[[ -s "$response_file" ]] || echo "::warning::The model returned an empty answer (done reason: ${done_reason})."
[[ "$done_reason" == length ]] && echo "::warning::The answer was cut off at max-tokens (${INPUT_MAX_TOKENS:-unset}); raise max-tokens if you need more."
if [[ "${INPUT_FORMAT:-}" != "" ]] && ! jq -e . "$response_file" >/dev/null 2>&1; then
  echo "::warning::format was requested but the answer is not valid JSON."
fi

delimiter="GEMMA4_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
{
  echo "response<<${delimiter}"
  cat "$response_file"
  echo
  echo "$delimiter"
  echo "response-file=${response_file}"
  echo "done-reason=${done_reason}"
  echo "prompt-tokens=${prompt_tokens}"
  echo "response-tokens=${response_tokens}"
  echo "tokens-per-second=${tps}"
} >>"$out"

stats="${INPUT_MODEL}: ${prompt_tokens} prompt tokens, ${response_tokens} response tokens, ${tps} tok/s, ${total_s}s total, done: ${done_reason}"
echo "$stats"

if [[ "${INPUT_STEP_SUMMARY:-true}" == true && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Gemma 4 answer"
    echo
    echo "$stats"
    echo
    echo "<details open><summary>Response</summary>"
    echo
    cat "$response_file"
    echo
    echo
    echo "</details>"
  } >>"$GITHUB_STEP_SUMMARY"
fi
