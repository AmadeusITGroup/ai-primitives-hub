import type {
  TargetCapability,
  TargetLayout,
} from '../../types/target';

export const KIRO_CAPABILITY: TargetCapability = {
  targetType: 'kiro',
  supportedScopes: ['user', 'repository'],
  supportedResources: ['prompt', 'instruction', 'agent', 'skill']
};

export const KIRO_USER_LAYOUT: TargetLayout = {
  targetType: 'kiro',
  scope: 'user',
  basePath: 'user',
  routes: {
    prompt: 'prompts',
    instruction: 'steering',
    agent: 'agents',
    skill: 'skills'
  }
};

export const KIRO_REPOSITORY_LAYOUT: TargetLayout = {
  targetType: 'kiro',
  scope: 'repository',
  basePath: 'repository',
  routes: {
    prompt: '.kiro/prompts',
    instruction: '.kiro/steering',
    agent: '.kiro/agents',
    skill: '.kiro/skills'
  }
};
