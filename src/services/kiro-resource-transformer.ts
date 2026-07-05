import type {
  Resource,
  ResourceTransformer,
  ResourceTransformResult,
  Target,
} from '../types/target';

/**
 * Kiro-specific resource transformer that adjusts prompt content
 * without affecting VS Code output.
 */
export const kiroResourceTransformer: ResourceTransformer = {
  transform: (resource: Resource, target: Target): Promise<ResourceTransformResult> => {
    if (target.type !== 'kiro') {
      return Promise.resolve({ resource, diagnostics: [] });
    }

    if (resource.kind === 'prompt') {
      return Promise.resolve({
        resource: {
          ...resource,
          content: normalizeKiroPrompt(resource.content ?? '')
        },
        diagnostics: []
      });
    }

    return Promise.resolve({ resource, diagnostics: [] });
  }
};

function normalizeKiroPrompt(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd() + '\n';
}
