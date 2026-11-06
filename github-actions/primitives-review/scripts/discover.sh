#!/usr/bin/env bash
# Finds the AI primitives under the requested paths and writes them as JSON lines:
#   {"path": "<workspace-relative path>", "type": "prompt|instruction|agent|skill"}
#
# Inputs (environment):
#   INPUT_PATH     space- or newline-separated files or directories (default ".")
#   INPUT_MAX_FILES  maximum primitives to review (default 20)
#   OUT_FILE       where the JSON lines are written
set -euo pipefail

: "${OUT_FILE:?}"
workspace="${GITHUB_WORKSPACE:-$PWD}"
max_files="${INPUT_MAX_FILES:-20}"
[[ "$max_files" =~ ^[0-9]+$ ]] || { echo "::error::max-files must be a whole number, got '${max_files}'"; exit 1; }

# Prints the primitive type for a path, or nothing when the file is not a primitive.
primitive_type() {
  local p="$1" name
  name="$(basename "$p")"
  case "$name" in
    *.prompt.md) echo prompt ;;
    *.instructions.md | AGENTS.md | CLAUDE.md | GEMINI.md | copilot-instructions.md) echo instruction ;;
    *.agent.md | *.chatmode.md) echo agent ;;
    SKILL.md) echo skill ;;
    *.md) [[ "$p" == */.kiro/steering/* || "$p" == .kiro/steering/* ]] && echo instruction ;;
  esac
  return 0
}

candidates="$(mktemp)"
trap 'rm -f "$candidates"' EXIT
cd "$workspace"

read -r -a requested <<<"$(tr '\n' ' ' <<<"${INPUT_PATH:-.}")"
[[ ${#requested[@]} -gt 0 ]] || requested=(.)
for target in "${requested[@]}"; do
  target="${target#./}"
  [[ -n "$target" ]] || target=.
  if [[ -f "$target" ]]; then
    if [[ -z "$(primitive_type "$target")" ]]; then
      echo "::warning::${target} is not a recognised primitive (*.prompt.md, *.instructions.md, *.agent.md, *.chatmode.md, SKILL.md, AGENTS.md, CLAUDE.md); skipping it."
      continue
    fi
    printf '%s\n' "$target" >>"$candidates"
  elif [[ -d "$target" ]]; then
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      # Tracked and untracked files, minus anything .gitignore excludes (build output, downloads).
      git ls-files -co --exclude-standard -- "$target" >>"$candidates"
    else
      find "$target" \( -name .git -o -name node_modules \) -prune -o -type f -print | sed 's|^\./||' >>"$candidates"
    fi
  else
    echo "::error::path not found: ${target}"
    exit 1
  fi
done

: >"$OUT_FILE"
total=0
while IFS= read -r p; do
  type="$(primitive_type "$p")"
  [[ -n "$type" ]] || continue
  total=$((total + 1))
  if ((total <= max_files)); then
    jq -cn --arg path "$p" --arg type "$type" '{path: $path, type: $type}' >>"$OUT_FILE"
  fi
done < <(sort -u "$candidates")

found="$(wc -l <"$OUT_FILE" | tr -d ' ')"
if ((total > max_files)); then
  echo "::warning::Found ${total} primitives; reviewing the first ${max_files} (raise max-files to review more)."
fi
echo "Primitives to review: ${found}"
