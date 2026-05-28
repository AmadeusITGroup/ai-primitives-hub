/**
 * APM Package Mapper
 * Maps APM (Agent Package Manager) manifest format to Prompt Registry Bundle format
 */

import {
  Bundle,
} from '../types/registry';

/**
 * APM manifest structure (apm.yml)
 */
export interface ApmManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  tags?: string[];
  license?: string;
  dependencies?: {
    apm?: string[];
    mcp?: string[];
  };
  scripts?: Record<string, string>;
}

/**
 * Context for package mapping
 */
export interface PackageContext {
  sourceId: string;
  owner: string;
  repo: string;
  path: string;
}

/**
 * Environment tag mapping
 */
const ENV_TAG_MAP: Record<string, string> = {
  azure: 'cloud',
  aws: 'cloud',
  gcp: 'cloud',
  frontend: 'web',
  backend: 'server',
  devops: 'infrastructure',
  testing: 'testing',
  security: 'security'
};

/**
 * Maximum allowed length for generated IDs to prevent abuse
 */
const MAX_ID_LENGTH = 200;

/**
 * Maps APM package manifests to Prompt Registry Bundle format
 */
export class ApmPackageMapper {
  /**
   * Generate a sanitized bundle ID
   * Security: Sanitizes input to prevent injection and limits length
   * @param manifest
   * @param context
   */
  private generateBundleId(manifest: ApmManifest, context: PackageContext): string {
    // Sanitize name: remove special characters, convert to lowercase
    const sanitizedName = manifest.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except space and hyphen
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .trim();

    const id = `${context.owner}-${sanitizedName}`;

    // Limit length to prevent abuse
    return id.substring(0, MAX_ID_LENGTH);
  }

  /**
   * Build package reference string
   * @param context
   */
  private buildPackageRef(context: PackageContext): string {
    return context.path
      ? `${context.owner}/${context.repo}/${context.path}`
      : `${context.owner}/${context.repo}`;
  }

  /**
   * Build tags array, always including 'apm' tag
   * @param manifestTags
   */
  private buildTags(manifestTags?: string[]): string[] {
    const tags = manifestTags ? [...manifestTags] : [];
    if (!tags.includes('apm')) {
      tags.push('apm');
    }
    return tags;
  }

  /**
   * Infer environments from tags
   * @param tags
   */
  private inferEnvironments(tags?: string[]): string[] {
    if (!tags || tags.length === 0) {
      return ['general'];
    }

    const environments = new Set<string>();

    for (const tag of tags) {
      const env = ENV_TAG_MAP[tag.toLowerCase()];
      if (env) {
        environments.add(env);
      }
    }

    return environments.size > 0 ? Array.from(environments) : ['general'];
  }

  /**
   * Map APM dependencies to Bundle dependencies
   * @param apmDeps
   */
  private mapDependencies(apmDeps?: string[]): {
    bundleId: string;
    versionRange: string;
    optional: boolean;
  }[] {
    if (!apmDeps || apmDeps.length === 0) {
      return [];
    }

    return apmDeps.map((dep) => ({
      bundleId: dep,
      versionRange: '*',
      optional: false
    }));
  }

  /**
   * Format dependency count as human-readable string
   * @param deps
   */
  private formatDependencyCount(deps?: string[]): string {
    const count = deps?.length || 0;
    if (count === 0) {
      return 'No dependencies';
    }
    return `${count} dependenc${count === 1 ? 'y' : 'ies'}`;
  }

  /**
   * Build manifest URL for GitHub raw content
   * @param context
   */
  private buildManifestUrl(context: PackageContext): string {
    const pathPrefix = context.path ? `${context.path}/` : '';
    return `https://raw.githubusercontent.com/${context.owner}/${context.repo}/main/${pathPrefix}apm.yml`;
  }

  /**
   * Convert APM manifest to Bundle
   * @param manifest APM manifest object
   * @param context Package context (source, owner, repo, path)
   * @returns Bundle object compatible with Prompt Registry
   */
  public toBundle(manifest: ApmManifest, context: PackageContext): Bundle & { apmPackageRef: string } {
    const packageRef = this.buildPackageRef(context);
    const tags = this.buildTags(manifest.tags);

    return {
      id: this.generateBundleId(manifest, context),
      name: manifest.name,
      version: manifest.version || '1.0.0',
      description: manifest.description || `APM package from ${packageRef}`,
      author: manifest.author || context.owner,
      sourceId: context.sourceId,
      environments: this.inferEnvironments(manifest.tags),
      tags,
      lastUpdated: new Date().toISOString(),
      size: this.formatDependencyCount(manifest.dependencies?.apm),
      dependencies: this.mapDependencies(manifest.dependencies?.apm),
      license: manifest.license || 'MIT',
      manifestUrl: this.buildManifestUrl(context),
      downloadUrl: this.buildManifestUrl(context),
      repository: `https://github.com/${context.owner}/${context.repo}`,
      apmPackageRef: packageRef
    };
  }
}
