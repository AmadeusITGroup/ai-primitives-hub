#!/usr/bin/env bash
# Works out where Ollama and the model live on this runner and builds the cache keys.
# Writes step outputs only; installs and starts nothing.
set -euo pipefail

: "${INPUT_MODEL:?the model input is required}"
: "${INPUT_OLLAMA_VERSION:?the ollama-version input is required}"
host="${INPUT_OLLAMA_HOST:-127.0.0.1:11434}"
base_url="http://${host}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) os=unsupported ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) arch=unsupported ;;
esac

# A server already listening (self-hosted runner, or an earlier call in this job) is reused as is.
server_running=false
if curl -fsS --max-time 2 "${base_url}/api/version" >/dev/null 2>&1; then
  server_running=true
fi

# Install the pinned release only when there is neither a server nor an ollama binary.
install=false
if [[ "$server_running" == false ]] && ! command -v ollama >/dev/null 2>&1; then
  if [[ "$os" != linux || "$arch" == unsupported ]]; then
    echo "::error::No Ollama found and automatic install supports Linux amd64/arm64 runners only (got $(uname -s)/$(uname -m)). Install Ollama on this runner or use ubuntu-latest."
    exit 1
  fi
  install=true
fi

install_dir="${RUNNER_TOOL_CACHE:-${RUNNER_TEMP:-/tmp}}/ollama/${INPUT_OLLAMA_VERSION}/${arch}"
models_dir="${OLLAMA_MODELS:-$HOME/.ollama/models}"

# Key the model cache on the registry manifest digest, so a re-published tag busts the cache.
model_ref="$INPUT_MODEL"
if [[ "${model_ref##*/}" == *:* ]]; then
  model_name="${model_ref%:*}"
  model_tag="${model_ref##*:}"
else
  model_name="$model_ref"
  model_tag=latest
fi
digest=unversioned
first_segment="${model_name%%/*}"
if [[ "$first_segment" != *.* ]]; then # skip non-Ollama registries such as hf.co/...
  repo="$model_name"
  [[ "$repo" == */* ]] || repo="library/${repo}"
  if manifest="$(curl -fsSL --max-time 15 \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://registry.ollama.ai/v2/${repo}/manifests/${model_tag}" 2>/dev/null)"; then
    digest="$(printf '%s' "$manifest" | sha256 | cut -c1-16)"
  else
    echo "::warning::Could not read the registry manifest for ${model_ref}; the model cache key will not track tag updates."
  fi
fi
safe_model="$(printf '%s' "$model_ref" | tr '/:' '--')"

{
  echo "os=${os}"
  echo "arch=${arch}"
  echo "host=${host}"
  echo "base-url=${base_url}"
  echo "server-running=${server_running}"
  echo "install=${install}"
  echo "install-dir=${install_dir}"
  echo "models-dir=${models_dir}"
  echo "runtime-cache-key=gemma4-action-ollama-${os}-${arch}-${INPUT_OLLAMA_VERSION}"
  echo "model-cache-key=gemma4-action-model-${os}-${safe_model}-${digest}"
} >>"$out"

echo "Platform ${os}/${arch}; server running: ${server_running}; install Ollama ${INPUT_OLLAMA_VERSION}: ${install}; model digest: ${digest}"
