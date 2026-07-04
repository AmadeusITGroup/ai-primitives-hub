/**
 * Shared target model for installing AI primitives into supported tools.
 */

export const TARGET_TYPES = [
  'vscode',
  'vscode-insiders',
  'copilot-cli',
  'kiro',
  'windsurf',
  'claude-code'
] as const;

export type TargetType = typeof TARGET_TYPES[number];

export const TARGET_SCOPES = ['user', 'repository'] as const;

export type TargetScope = typeof TARGET_SCOPES[number];

export const RESOURCE_KINDS = ['prompt', 'instruction', 'agent', 'skill'] as const;

export type ResourceKind = typeof RESOURCE_KINDS[number];

export interface Target {
  type: TargetType;
  scope: TargetScope;
}

export interface Resource {
  kind: ResourceKind;
  id: string;
  sourcePath: string;
  content?: string;
}

export interface ResourceTransformDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  resourceId?: string;
}

export interface ResourceTransformResult {
  resource: Resource;
  diagnostics: ResourceTransformDiagnostic[];
}

export interface ResourceTransformer {
  transform(resource: Resource, target: Target): Promise<ResourceTransformResult>;
}

export interface TargetCapability {
  targetType: TargetType;
  supportedScopes: TargetScope[];
  supportedResources: ResourceKind[];
}

export interface TargetLayout {
  targetType: TargetType;
  scope: TargetScope;
  basePath: string;
  routes: Partial<Record<ResourceKind, string>>;
}

export interface TargetValidationResult {
  valid: boolean;
  errors: string[];
}

export interface InstallOperation {
  target: Target;
  resources: Resource[];
  layout: TargetLayout;
}

/**
 * Checks whether a value is a supported target type.
 * @param value
 */
export function isTargetType(value: unknown): value is TargetType {
  return typeof value === 'string' && TARGET_TYPES.includes(value as TargetType);
}

/**
 * Checks whether a value is a supported target scope.
 * @param value
 */
export function isTargetScope(value: unknown): value is TargetScope {
  return typeof value === 'string' && TARGET_SCOPES.includes(value as TargetScope);
}

/**
 * Checks whether a value is an installable resource kind.
 * @param value
 */
export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && RESOURCE_KINDS.includes(value as ResourceKind);
}

/**
 * Validates a target capability declaration.
 * @param capability
 */
export function validateTargetCapability(capability: TargetCapability): TargetValidationResult {
  const errors: string[] = [];

  if (capability.supportedScopes.length === 0) {
    errors.push('Target capability must support at least one scope');
  }

  for (const resourceKind of capability.supportedResources) {
    if (!isResourceKind(resourceKind)) {
      errors.push(`Unsupported resource kind: ${String(resourceKind)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates that a target layout can route every resource kind.
 * @param layout
 */
export function validateTargetLayout(layout: TargetLayout): TargetValidationResult {
  const errors: string[] = [];

  for (const resourceKind of RESOURCE_KINDS) {
    if (!layout.routes[resourceKind]) {
      errors.push(`Missing route for resource kind: ${resourceKind}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
