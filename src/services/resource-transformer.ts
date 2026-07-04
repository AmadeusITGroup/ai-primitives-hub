import {
  Resource,
  ResourceTransformDiagnostic,
  ResourceTransformer,
  ResourceTransformResult,
  Target,
} from '../types/target';

export interface ResourceTransformerPipelineOptions {
  transformers: ResourceTransformer[];
}

export interface ResourceTransformerPipeline {
  transform(resource: Resource, target: Target): Promise<ResourceTransformResult>;
}

/**
 * Creates a deterministic transformer pipeline with fail-safe diagnostics.
 * @param options
 */
export const createResourceTransformerPipeline = (options: ResourceTransformerPipelineOptions): ResourceTransformerPipeline => {
  return {
    transform: async (resource: Resource, target: Target): Promise<ResourceTransformResult> => {
      let current = resource;
      const diagnostics: ResourceTransformDiagnostic[] = [];

      try {
        for (const transformer of options.transformers) {
          const result = await transformer.transform(current, target);
          current = result.resource;
          diagnostics.push(...result.diagnostics);
        }
      } catch (error) {
        return {
          resource,
          diagnostics: [
            {
              severity: 'error',
              message: redactDiagnosticMessage(error instanceof Error ? error.message : String(error)),
              resourceId: resource.id
            }
          ]
        };
      }

      return {
        resource: current,
        diagnostics
      };
    }
  };
};

function redactDiagnosticMessage(message: string): string {
  return message.replace(/\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*\S+/gi, '[REDACTED]');
}
