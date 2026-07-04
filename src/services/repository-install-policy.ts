import {
  RepositoryCommitMode,
} from '../types/registry';
import {
  Resource,
} from '../types/target';

export interface RepositoryInstallPolicyRequest {
  commitMode: RepositoryCommitMode;
  resources: Resource[];
}

export interface RepositoryInstallPolicyDiagnostic {
  severity: 'error' | 'warning';
  code: 'secret-like-content' | 'local-only-reference';
  resourceId: string;
  message: string;
  remediation: string;
}

export interface RepositoryInstallPolicyRouteDecision {
  action: 'route-local-only';
  commitMode: 'local-only';
}

export interface RepositoryInstallPolicyResult {
  allowed: boolean;
  diagnostics: RepositoryInstallPolicyDiagnostic[];
  routeDecision?: RepositoryInstallPolicyRouteDecision;
}

/**
 * Validates whether resources are safe for repository-scope installation.
 * @param request
 */
export function validateRepositoryInstallPolicy(request: RepositoryInstallPolicyRequest): RepositoryInstallPolicyResult {
  if (request.commitMode === 'local-only') {
    return { allowed: true, diagnostics: [] };
  }

  const diagnostics: RepositoryInstallPolicyDiagnostic[] = [];
  let routeDecision: RepositoryInstallPolicyRouteDecision | undefined;

  for (const resource of request.resources) {
    const content = resource.content ?? '';

    if (containsSecretLikeContent(content)) {
      diagnostics.push({
        severity: 'error',
        code: 'secret-like-content',
        resourceId: resource.id,
        message: `Repository install rejected because ${resource.kind} ${resource.id} contains [REDACTED].`,
        remediation: 'Install to user scope or remove the secret-like content before committing.'
      });
      continue;
    }

    if (containsLocalOnlyReference(content)) {
      routeDecision = {
        action: 'route-local-only',
        commitMode: 'local-only'
      };
      diagnostics.push({
        severity: 'warning',
        code: 'local-only-reference',
        resourceId: resource.id,
        message: 'Repository install should not commit local-only reference [REDACTED].',
        remediation: 'Use local-only repository mode or user scope for machine-specific resources.'
      });
    }
  }

  return {
    allowed: diagnostics.length === 0,
    diagnostics,
    ...(routeDecision ? { routeDecision } : {})
  };
}

function containsSecretLikeContent(content: string): boolean {
  return /(?:token|api_key|password|secret|client_secret|private_key)\s*[:=]/i.test(content)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
}

function containsLocalOnlyReference(content: string): boolean {
  return /(?:^|\s)(?:\/Users\/[^\s]+|~\/[^\s]+|\.ssh\/[^\s]+)/.test(content);
}
