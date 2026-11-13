#!/usr/bin/env bash
# Installs Ollama when needed (checksum verified), starts it on loopback, and pulls the model.
set -euo pipefail

: "${INPUT_MODEL:?}" "${RESOLVED_BASE_URL:?}" "${RESOLVED_HOST:?}" "${RESOLVED_MODELS_DIR:?}"
base_url="$RESOLVED_BASE_URL"
out="${GITHUB_OUTPUT:-/dev/stdout}"

install_ollama() {
  local dir="$RESOLVED_INSTALL_DIR"
  if [[ -x "${dir}/bin/ollama" ]]; then
    echo "Using cached Ollama ${INPUT_OLLAMA_VERSION} from ${dir}"
    return
  fi
  command -v zstd >/dev/null 2>&1 || { echo "::error::zstd is required to unpack Ollama; install it on the runner."; exit 1; }

  local asset="ollama-${RESOLVED_OS}-${RESOLVED_ARCH}.tar.zst"
  local url="https://github.com/ollama/ollama/releases/download/${INPUT_OLLAMA_VERSION}"
  local tmp
  tmp="$(mktemp -d)"
  echo "Downloading ${asset} (${INPUT_OLLAMA_VERSION})"
  curl -fsSL --retry 3 --retry-delay 5 -o "${tmp}/${asset}" "${url}/${asset}"
  curl -fsSL --retry 3 --retry-delay 5 -o "${tmp}/sha256sum.txt" "${url}/sha256sum.txt"

  local expected actual
  expected="$(awk -v f="$asset" '{ n = $2; sub(/^[*]/, "", n); sub(/^\.\//, "", n); if (n == f) print $1 }' "${tmp}/sha256sum.txt")"
  actual="$(sha256sum "${tmp}/${asset}" | cut -d' ' -f1)"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "::error::Checksum mismatch for ${asset} (expected '${expected:-missing}', got '${actual}')."
    exit 1
  fi

  mkdir -p "$dir"
  zstd -dc "${tmp}/${asset}" | tar -xf - -C "$dir"
  rm -rf "$tmp"
  [[ -x "${dir}/bin/ollama" ]] || { echo "::error::${asset} did not contain bin/ollama."; exit 1; }
}

if [[ "${RESOLVED_SERVER_RUNNING}" == true ]]; then
  echo "Reusing the Ollama server at ${base_url}"
else
  if [[ "${RESOLVED_INSTALL}" == true ]]; then
    install_ollama
    ollama_bin="${RESOLVED_INSTALL_DIR}/bin/ollama"
    [[ -n "${GITHUB_PATH:-}" ]] && echo "${RESOLVED_INSTALL_DIR}/bin" >>"$GITHUB_PATH"
  else
    ollama_bin="$(command -v ollama)"
    echo "Using Ollama already on PATH: ${ollama_bin}"
  fi

  mkdir -p "$RESOLVED_MODELS_DIR"
  log="${RUNNER_TEMP:-/tmp}/ollama-serve.log"
  OLLAMA_HOST="$RESOLVED_HOST" OLLAMA_MODELS="$RESOLVED_MODELS_DIR" OLLAMA_KEEP_ALIVE="${INPUT_KEEP_ALIVE:-30m}" \
    nohup "$ollama_bin" serve >"$log" 2>&1 &

  for _ in $(seq 1 90); do
    curl -fsS --max-time 2 "${base_url}/api/version" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS --max-time 2 "${base_url}/api/version" >/dev/null 2>&1; then
    echo "::error::Ollama did not start within 90 seconds. Server log:"
    cat "$log" || true
    exit 1
  fi
  # Later steps in the job can call `ollama` or the API directly.
  [[ -n "${GITHUB_ENV:-}" ]] && echo "OLLAMA_HOST=${RESOLVED_HOST}" >>"$GITHUB_ENV"
fi

version="$(curl -fsS --max-time 5 "${base_url}/api/version" | jq -r '.version')"
echo "ollama-version=${version}" >>"$out"
echo "Ollama ${version} is up at ${base_url}"

echo "Pulling ${INPUT_MODEL} (no-op when it is already present and current)"
start=$(date +%s)
pull_body="$(jq -n --arg m "$INPUT_MODEL" '{model: $m, stream: false}')"
if ! pull_result="$(curl -sS --fail-with-body --max-time 1800 -H 'Content-Type: application/json' \
  --data-binary "$pull_body" "${base_url}/api/pull")"; then
  echo "::error::Pulling ${INPUT_MODEL} failed: ${pull_result}"
  exit 1
fi
if [[ "$(jq -r '.status // empty' <<<"$pull_result")" != success ]]; then
  echo "::error::Pulling ${INPUT_MODEL} failed: ${pull_result}"
  exit 1
fi
echo "Model ${INPUT_MODEL} ready in $(($(date +%s) - start))s"
