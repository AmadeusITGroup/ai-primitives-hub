import {
  ResourceKind,
  TargetCapability,
  TargetScope,
  TargetType,
} from '../types/target';

const CAPABILITIES: TargetCapability[] = [
  {
    targetType: 'vscode',
    supportedScopes: ['user', 'repository'],
    supportedResources: ['prompt', 'instruction', 'agent', 'skill']
  },
  {
    targetType: 'vscode-insiders',
    supportedScopes: ['user', 'repository'],
    supportedResources: ['prompt', 'instruction', 'agent', 'skill']
  },
  {
    targetType: 'kiro',
    supportedScopes: ['user', 'repository'],
    supportedResources: ['prompt', 'skill']
  }
];

/**
 * Gets the declared capabilities for a target type.
 * @param targetType
 */
export function getTargetCapability(targetType: TargetType): TargetCapability | undefined {
  return CAPABILITIES.find((capability) => capability.targetType === targetType);
}

/**
 * Checks whether a target supports a resource kind in the requested scope.
 * @param targetType
 * @param scope
 * @param resourceKind
 */
export function supportsTargetResource(targetType: TargetType, scope: TargetScope, resourceKind: ResourceKind): boolean {
  const capability = getTargetCapability(targetType);

  return Boolean(capability?.supportedScopes.includes(scope) && capability.supportedResources.includes(resourceKind));
}
