import type {
  Target,
  TargetCapability,
  TargetLayout,
  TargetScope,
  TargetType,
} from '../../types/target';
import {
  KIRO_CAPABILITY,
  KIRO_REPOSITORY_LAYOUT,
  KIRO_USER_LAYOUT,
} from './kiro';
import {
  VSCODE_CAPABILITY,
  VSCODE_REPOSITORY_LAYOUT,
  VSCODE_USER_LAYOUT,
} from './vscode';

const LAYOUTS: Partial<Record<TargetType, Partial<Record<TargetScope, TargetLayout>>>> = {
  vscode: {
    user: VSCODE_USER_LAYOUT,
    repository: VSCODE_REPOSITORY_LAYOUT
  },
  'vscode-insiders': {
    user: VSCODE_USER_LAYOUT,
    repository: VSCODE_REPOSITORY_LAYOUT
  },
  kiro: {
    user: KIRO_USER_LAYOUT,
    repository: KIRO_REPOSITORY_LAYOUT
  }
};

const CAPABILITIES: Partial<Record<TargetType, TargetCapability>> = {
  vscode: VSCODE_CAPABILITY,
  'vscode-insiders': VSCODE_CAPABILITY,
  kiro: KIRO_CAPABILITY
};

/**
 * Resolves the filesystem layout for a target and scope.
 * @param target
 */
export function resolveTargetLayout(target: Target): TargetLayout {
  const scopeLayouts = LAYOUTS[target.type];
  if (scopeLayouts) {
    const layout = scopeLayouts[target.scope];
    if (layout) {
      return layout;
    }
  }

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

/**
 * Gets the declared capabilities for a target type.
 * @param targetType
 */
export function getTargetCapability(targetType: TargetType): TargetCapability | undefined {
  return CAPABILITIES[targetType];
}
