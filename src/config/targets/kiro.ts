import type {
  TargetCapability,
  TargetLayout,
} from '../../types/target';

export const KIRO_CAPABILITY: TargetCapability = {
  targetType: 'kiro',
  supportedScopes: ['user', 'repository'],
  supportedResources: ['prompt', 'skill']
};

export const KIRO_USER_LAYOUT: TargetLayout = {
  targetType: 'kiro',
  scope: 'user',
  basePath: 'user',
  routes: {
    prompt: 'prompts',
    skill: 'skills'
  }
};

export const KIRO_REPOSITORY_LAYOUT: TargetLayout = {
  targetType: 'kiro',
  scope: 'repository',
  basePath: 'repository',
  routes: {
    prompt: '.github/prompts',
    skill: '.github/skills'
  }
};
