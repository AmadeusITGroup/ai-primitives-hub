/**
 * `ai-primitives-hub completion` — shell completion script generator.
 *
 * Generates bash and zsh completion scripts that can be sourced. Both
 * scripts derive their command/subcommand candidates from
 * `getCommandPaths(this)` — the same command registry (`commands/registry.ts`)
 * that clipanion dispatches against — so newly registered commands and
 * subcommands are completed automatically, with no separate list to
 * keep in sync.
 * @module commands/completion
 */
import {
  Command,
  getCommandContext,
  getCommandPaths,
  Option,
} from '../framework';

/**
 * Single-quote `text` for safe embedding in POSIX shell source, escaping
 * any embedded single quotes. Applied to every command-path literal
 * before it is written into a generated (and later sourced) completion
 * script — `defineCommand()` is a public framework API, so a path
 * segment can contain arbitrary text and must never be trusted to be
 * shell-safe on its own.
 * @param text Raw text to embed as a shell string literal.
 * @returns `text` wrapped in single quotes, safe to splice into shell source.
 */
const shellQuote = (text: string): string => `'${text.replace(/'/g, String.raw`'\''`)}'`;

/**
 * Render a flat path list as a shell array literal, one quoted,
 * space-joined path per line (e.g. `'index shortlist new'`).
 * @param paths Command paths, e.g. `[['index', 'search'], ['search']]`.
 * @param indent Leading whitespace applied to each literal line.
 */
const renderPathLiterals = (paths: string[][], indent: string): string =>
  paths.map((path) => `${indent}${shellQuote(path.join(' '))}`).join('\n');

/**
 * Completion command class.
 */
export class CompletionCommand extends Command {
  public static readonly paths = [['completion']];

  public static readonly usage = Command.Usage({
    description: 'Generate shell completion script for bash or zsh.',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub completion --shell <shell>

      Generates a shell completion script for the specified shell.
      Output the script to a file and source it in your shell configuration.

      Options:
        --shell <shell>          Shell type: bash or zsh (required)

      Examples:
        ai-primitives-hub completion --shell bash > ~/.local/share/bash-completion/completions/ai-primitives-hub
        ai-primitives-hub completion --shell zsh > ~/.zsh/completion/_ai-primitives-hub
        source <(ai-primitives-hub completion --shell bash)
    `
  });

  public shell = Option.String('--shell');

  /**
   * Generate a bash completion script.
   *
   * The generated script embeds `paths` as a flat array literal and
   * walks it generically at completion time: for the word currently
   * being completed (`cword`), it matches every earlier word against
   * each path's corresponding prefix and offers the next token of any
   * path that matches. This covers every registered command and
   * subcommand at any depth without per-command branches.
   * @param paths Full set of registered command paths.
   */
  private generateBashCompletion(paths: string[][]): string {
    return `# bash completion for ai-primitives-hub
_ai_primitives_hub_completion() {
  local cur words cword
  _init_completion || return

  local -a __aiph_paths=(
${renderPathLiterals(paths, '    ')}
  )

  local -a __aiph_candidates=()
  local __aiph_path_str
  for __aiph_path_str in "\${__aiph_paths[@]}"; do
    local -a __aiph_tokens=($__aiph_path_str)
    if (( \${#__aiph_tokens[@]} >= cword )); then
      local __aiph_match=1
      local __aiph_i
      for (( __aiph_i = 0; __aiph_i < cword - 1; __aiph_i++ )); do
        if [[ "\${__aiph_tokens[__aiph_i]}" != "\${words[__aiph_i + 1]}" ]]; then
          __aiph_match=0
          break
        fi
      done
      if [[ \${__aiph_match} -eq 1 ]]; then
        local __aiph_cand="\${__aiph_tokens[cword - 1]}"
        if [[ " \${__aiph_candidates[*]} " != *" \${__aiph_cand} "* ]]; then
          __aiph_candidates+=("\${__aiph_cand}")
        fi
      fi
    fi
  done

  if (( \${#__aiph_candidates[@]} > 0 )); then
    COMPREPLY=($(compgen -W "\${__aiph_candidates[*]}" -- "$cur"))
  else
    COMPREPLY=($(compgen -f -- "$cur"))
  fi
}

complete -F _ai_primitives_hub_completion ai-primitives-hub
`;
  }

  /**
   * Generate a zsh completion script.
   *
   * Uses the same path-matching algorithm as the bash generator,
   * adapted to zsh's 1-based `$words`/`$CURRENT` completion variables.
   * @param paths Full set of registered command paths.
   */
  private generateZshCompletion(paths: string[][]): string {
    return `#compdef ai-primitives-hub

_ai_primitives_hub() {
  local -a __aiph_paths
  __aiph_paths=(
${renderPathLiterals(paths, '    ')}
  )

  local -a __aiph_candidates
  __aiph_candidates=()
  local __aiph_path_str
  for __aiph_path_str in "\${__aiph_paths[@]}"; do
    local -a __aiph_tokens
    __aiph_tokens=(\${=__aiph_path_str})
    if (( \${#__aiph_tokens} >= CURRENT - 1 )); then
      local __aiph_match=1
      local __aiph_i
      for (( __aiph_i = 1; __aiph_i <= CURRENT - 2; __aiph_i++ )); do
        if [[ "\${__aiph_tokens[__aiph_i]}" != "\${words[__aiph_i + 1]}" ]]; then
          __aiph_match=0
          break
        fi
      done
      if (( __aiph_match )); then
        local __aiph_cand="\${__aiph_tokens[CURRENT - 1]}"
        if [[ " \${(j: :)__aiph_candidates} " != *" \${__aiph_cand} "* ]]; then
          __aiph_candidates+=("\${__aiph_cand}")
        fi
      fi
    fi
  done

  if (( \${#__aiph_candidates} > 0 )); then
    compadd -a __aiph_candidates
  else
    _files
  fi
}

_ai_primitives_hub
`;
  }

  public execute(): Promise<number | void> {
    const ctx = getCommandContext(this);
    const shell = this.shell;

    if (!shell) {
      ctx.stderr.write('Error: --shell is required. Use "bash" or "zsh".\n');
      return Promise.resolve(1);
    }

    if (shell !== 'bash' && shell !== 'zsh') {
      ctx.stderr.write(`Error: Unsupported shell "${shell}". Use "bash" or "zsh".\n`);
      return Promise.resolve(1);
    }

    const paths = getCommandPaths(this);
    const script = shell === 'bash' ? this.generateBashCompletion(paths) : this.generateZshCompletion(paths);
    ctx.stdout.write(script);
    return Promise.resolve(0);
  }
}
