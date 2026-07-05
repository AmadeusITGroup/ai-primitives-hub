import type {
  TargetCapability,
  TargetLayout,
} from '../../types/target';

export const VSCODE_CAPABILITY: TargetCapability = {
  targetType: 'vscode',
  supportedScopes: ['user', 'repository'],
  supportedResources: ['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook']
};

export const VSCODE_USER_LAYOUT: TargetLayout = {
  targetType: 'vscode',
  scope: 'user',
  basePath: 'user',
  routes: {
    prompt: 'prompts',
    instruction: 'prompts',
    agent: 'prompts',
    skill: 'skills',
    plugin: 'plugins',
    hook: 'hooks'
  }
};

export const VSCODE_REPOSITORY_LAYOUT: TargetLayout = {
  targetType: 'vscode',
  scope: 'repository',
  basePath: 'repository',
  routes: {
    prompt: '.github/prompts',
    instruction: '.github/instructions',
    agent: '.github/agents',
    skill: '.github/skills',
    plugin: '.github/plugins',
    hook: '.github/hooks'
  }
};
