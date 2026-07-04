import {
  Target,
  TargetLayout,
} from '../types/target';

/**
 * Resolves the filesystem layout for a target and scope.
 * @param target
 */
export function resolveTargetLayout(target: Target): TargetLayout {
  if (target.type !== 'vscode' && target.type !== 'vscode-insiders') {
    return {
      targetType: target.type,
      scope: target.scope,
      basePath: target.scope,
      routes: {
        prompt: 'prompts',
        skill: 'skills'
      }
    };
  }

  if (target.scope === 'user') {
    return {
      targetType: target.type,
      scope: target.scope,
      basePath: 'user',
      routes: {
        prompt: 'prompts',
        instruction: 'prompts',
        agent: 'prompts',
        skill: 'skills'
      }
    };
  }

  return {
    targetType: target.type,
    scope: target.scope,
    basePath: 'repository',
    routes: {
      prompt: '.github/prompts',
      instruction: '.github/instructions',
      agent: '.github/agents',
      skill: '.github/skills'
    }
  };
}
