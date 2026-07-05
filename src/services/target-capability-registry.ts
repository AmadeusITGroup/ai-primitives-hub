import {
  getTargetCapability as getConfigTargetCapability,
} from '../config/targets';
import {
  ResourceKind,
  TargetScope,
  TargetType,
} from '../types/target';

/**
 * Gets the declared capabilities for a target type.
 * @param targetType
 */
export function getTargetCapability(targetType: TargetType): ReturnType<typeof getConfigTargetCapability> {
  return getConfigTargetCapability(targetType);
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
