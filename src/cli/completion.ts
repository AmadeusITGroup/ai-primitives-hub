/**
 * Shell completion command for prompt-registry CLI.
 * Generates bash and zsh completion scripts that can be sourced.
 *
 * Ported from feat/cli-backup (commit 10ccdc2, author: Waldek Herka).
 * Adapted from clipanion-based to our function-based CLI structure.
 */
import {
  SUPPORTED_CLI_COMMANDS,
} from './cli';

export interface CompletionOptions {
  shell: 'bash' | 'zsh';
}

/**
 * Generate a shell completion script for bash or zsh.
 * @param shell Target shell type.
 * @returns Completion script string.
 */
export function generateCompletion(shell: 'bash' | 'zsh'): string {
  return shell === 'bash' ? generateBashCompletion() : generateZshCompletion();
}

function generateBashCompletion(): string {
  const commands = SUPPORTED_CLI_COMMANDS.join(' ');
  return `# bash completion for prompt-registry
_prompt_registry_completion() {
  local cur words cword
  _init_completion || return

  local commands="${commands}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "\${words[1]}" in
    --help|-h|--output)
      COMPREPLY=( $(compgen -W "--help --output" -- "$cur") )
      return 0
      ;;
  esac

  return 0
}
complete -F _prompt_registry_completion prompt-registry
`;
}

function generateZshCompletion(): string {
  const commands = SUPPORTED_CLI_COMMANDS.map((c) => `"${c}"`).join(' ');
  return `#compdef prompt-registry
# zsh completion for prompt-registry

_prompt_registry() {
  local -a commands
  commands=(
    ${commands}
  )

  if [[ $CURRENT -eq 2 ]]; then
    _describe 'command' commands
    return 0
  fi

  return 0
}

compdef _prompt_registry prompt-registry
`;
}
