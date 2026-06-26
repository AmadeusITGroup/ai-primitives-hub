/**
 * Shell completion command for prompt-registry CLI.
 * Generates bash and zsh completion scripts that can be sourced.
 */
import {
  Command,
  Option,
} from '../framework';
import type {
  Context,
} from '../framework';

type CompletionContext = { ctx: Context };

abstract class BaseCompletionCommand extends Command {
  public commandContext: CompletionContext = { ctx: null as any };
}

export class CompletionCommand extends BaseCompletionCommand {
  public static readonly paths = [['completion']];
  public static readonly usage = Command.Usage({
    description: 'Generate shell completion script for bash or zsh.',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry completion <shell>

      Generates a shell completion script for the specified shell.
      Output the script to a file and source it in your shell configuration.

      Options:
        --shell <shell>          Shell type: bash or zsh (required)

      Examples:
        prompt-registry completion bash > ~/.local/share/bash-completion/completions/prompt-registry
        prompt-registry completion zsh > ~/.zsh/completion/_prompt-registry
        source <(prompt-registry completion bash)
    `
  });

  public shell = Option.String('--shell');

  private generateBashCompletion(): string {
    return `# bash completion for prompt-registry
_prompt_registry_completion() {
  local cur words cword
  _init_completion || return

  # Command list
  local commands="apply config discover doctor explain hub index init install profile plugins skill source status target uninstall update bundle collection version"

  # Index subcommands
  local index_commands="bench build eval export harvest report search shortlist stats"

  # Hub subcommands
  local hub_commands="add create list refresh remove sync use"

  # Profile subcommands
  local profile_commands="activate create deactivate list publish show"

  # Source subcommands
  local source_commands="add list remove"

  # Target subcommands
  local target_commands="add list remove types"

  # Collection subcommands
  local collection_commands="affected create list validate"

  # Config subcommands
  local config_commands="get list"

  # Index shortlist subcommands
  local shortlist_commands="add list new remove"

  case \${words[0]} in
    prompt-registry)
      if [[ \${cword} -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      fi
      ;;
    index)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$index_commands" -- "$cur"))
      fi
      ;;
    hub)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$hub_commands" -- "$cur"))
      fi
      ;;
    profile)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$profile_commands" -- "$cur"))
      fi
      ;;
    source)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$source_commands" -- "$cur"))
      fi
      ;;
    target)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$target_commands" -- "$cur"))
      fi
      ;;
    collection)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$collection_commands" -- "$cur"))
      fi
      ;;
    config)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$config_commands" -- "$cur"))
      fi
      ;;
    shortlist)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$shortlist_commands" -- "$cur"))
      fi
      ;;
    *)
      # File completion for arguments
      COMPREPLY=($(compgen -f -- "$cur"))
      ;;
  esac
}

complete -F _prompt_registry_completion prompt-registry
`;
  }

  private generateZshCompletion(): string {
    return `#compdef prompt-registry

_prompt_registry() {
  local -a commands
  commands=(
    'apply:Idempotent: sync active hub and re-activate profile'
    'config:Read or list config values'
    'discover:Discover relevant Copilot resources'
    'doctor:Run environment self-checks'
    'explain:Print documentation for error codes'
    'hub:Manage hub configuration'
    'index:Index and search primitives'
    'init:Bootstrap a project'
    'install:Install bundles to targets'
    'profile:Manage profiles'
    'plugins:List prompt-registry plugins'
    'skill:Manage agent skills'
    'source:Manage sources'
    'status:Show configuration state'
    'target:Manage install targets'
    'uninstall:Remove bundles from targets'
    'update:Check for bundle updates'
    'bundle:Build and manage bundles'
    'collection:Manage collections'
    'version:Compute collection versions'
  )

  if [[ CURRENT -eq 1 ]]; then
    _describe 'command' commands
    return
  fi

  case $words[1] in
    index)
      local -a index_commands
      index_commands=(
        'bench:Run search microbenchmark'
        'build:Build primitive index'
        'eval:Run relevance eval'
        'export:Export shortlist as profile'
        'harvest:Fetch and write primitive index'
        'report:Render harvest report'
        'search:Search primitive index'
        'shortlist:Manage shortlists'
        'stats:Show index statistics'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'index command' index_commands
      fi
      ;;
    hub)
      local -a hub_commands
      hub_commands=(
        'add:Import a hub'
        'create:Scaffold hub-config.yml'
        'list:List imported hubs'
        'refresh:Sync active hub'
        'remove:Remove a hub'
        'sync:Re-fetch and sync hub'
        'use:Set/clear active hub'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'hub command' hub_commands
      fi
      ;;
    profile)
      local -a profile_commands
      profile_commands=(
        'activate:Activate a profile'
        'create:Create local profile'
        'deactivate:Deactivate profile'
        'list:List profiles'
        'publish:Publish profile to hub'
        'show:Show profile details'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'profile command' profile_commands
      fi
      ;;
    source)
      local -a source_commands
      source_commands=(
        'add:Add detached source'
        'list:List sources'
        'remove:Remove source'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'source command' source_commands
      fi
      ;;
    target)
      local -a target_commands
      target_commands=(
        'add:Register install target'
        'list:List configured targets'
        'remove:Remove target'
        'types:List target types'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'target command' target_commands
      fi
      ;;
    collection)
      local -a collection_commands
      collection_commands=(
        'affected:Print overlapping collections'
        'create:Create collection'
        'list:List collections'
        'validate:Validate collections'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'collection command' collection_commands
      fi
      ;;
    config)
      local -a config_commands
      config_commands=(
        'get:Read config value'
        'list:Print resolved config'
      )
      if [[ CURRENT -eq 2 ]]; then
        _describe 'config command' config_commands
      fi
      ;;
    *)
      # File completion
      _files
      ;;
  esac
}

_prompt_registry
`;
  }

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const shell = this.shell;

    if (!shell) {
      ctx.stderr.write('Error: --shell is required. Use "bash" or "zsh".\n');
      return 1;
    }

    if (shell !== 'bash' && shell !== 'zsh') {
      ctx.stderr.write(`Error: Unsupported shell "${shell}". Use "bash" or "zsh".\n`);
      return 1;
    }

    const script = shell === 'bash' ? this.generateBashCompletion() : this.generateZshCompletion();
    ctx.stdout.write(script);
    return 0;
  }
}
