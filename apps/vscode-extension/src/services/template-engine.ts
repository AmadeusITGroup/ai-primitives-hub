import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  generateSanitizedId,
} from '../utils/bundle-name-utils';
import {
  Logger,
} from '../utils/logger';
import {
  replaceVariables,
} from '../utils/regex-utils';

export interface TemplateContext {
  projectName: string;
  collectionId: string;
  [key: string]: any;
}

export interface TemplateInfo {
  path: string;
  description: string;
  required: boolean;
  variables: string[];
}

export interface TemplateManifest {
  version: string;
  description: string;
  templates: {
    [key: string]: TemplateInfo;
  };
}

/**
 * Service for loading and rendering scaffold templates
 */
export class TemplateEngine {
  private readonly logger = Logger.getInstance();
  private manifestCache?: TemplateManifest;

  constructor(private readonly templateRoot: string) {}

  /**
   * Resolve relative path for a template, handling special cases
   * Replaces getTargetPath by returning the relative path component
   * @param name
   * @param templatePath
   */
  private resolveRelativePath(name: string, templatePath: string): string {
    let relativePath = templatePath;

    // Handle README.template.md -> README.md
    switch (templatePath) {
      case 'README.template.md': {
        relativePath = 'README.md';

        break;
      }
      case 'package.template.json': {
        relativePath = 'package.json';

        break;
      }
      case '.gitignore.template': {
        relativePath = '.gitignore';

        break;
      }
      default: {
        if (templatePath.endsWith('.template')) {
          relativePath = templatePath.slice(0, -9);
        } else if (templatePath.includes('.template.')) {
          // Handle .template. in the middle (e.g., file.template.yml -> file.yml)
          relativePath = templatePath.replace('.template.', '.');
        }
      }
    }

    // Handle workflows -> .github/workflows
    if (relativePath.startsWith('workflows/')) {
      const filename = path.basename(relativePath);
      return path.join('.github', 'workflows', filename);
    }

    // Handle actions -> .github/actions
    if (relativePath.startsWith('actions/')) {
      // Preserve the full path under actions (e.g., actions/publish-common/action.yml)
      return path.join('.github', relativePath);
    }

    // Handle validation script -> scripts/ (Legacy support for Awesome Copilot)
    if (name === 'validation-script' && relativePath.includes('validate-collections.js')) {
      const filename = path.basename(relativePath);
      return path.join('scripts', filename);
    }

    return relativePath;
  }

  /**
   * Enhance context with computed values
   * @param context
   */
  private enhanceContext(context: TemplateContext): Record<string, any> {
    const enhanced: Record<string, string> = { ...context };

    // Compute packageName from projectName (kebab-case)
    if (context.projectName) {
      enhanced.packageName = generateSanitizedId(context.projectName);
      // Also map to 'name' if not present
      if (!enhanced.name) {
        enhanced.name = enhanced.packageName;
      }
    }

    // Ensure defaults for required fields
    if (!enhanced.description) {
      enhanced.description = 'A new package';
    }
    if (!enhanced.author) {
      enhanced.author = process.env.USER || 'Your Name';
    }
    if (!enhanced.githubOrg) {
      enhanced.githubOrg = 'YOUR_ORG';
    }

    // Format tags
    if (enhanced.tags) {
      if (Array.isArray(enhanced.tags)) {
        enhanced.tags = enhanced.tags.map((t: string) => `"${t}"`).join(', ');
      }
    } else {
      enhanced.tags = '"apm", "prompt-registry"';
    }

    // Defaults for organization details (InnerSource LICENSE)
    if (!enhanced.organizationName) {
      enhanced.organizationName = '[Your Organization]';
    }
    if (!enhanced.internalContact) {
      enhanced.internalContact = '[internal-contact@yourorg.com]';
    }
    if (!enhanced.legalContact) {
      enhanced.legalContact = '[legal@yourorg.com]';
    }
    if (!enhanced.organizationPolicyLink) {
      enhanced.organizationPolicyLink = '[Link to organization policy]';
    }

    return enhanced;
  }

  /**
   * Load template manifest
   */
  private async loadManifest(): Promise<TemplateManifest> {
    if (this.manifestCache) {
      return this.manifestCache;
    }

    const manifestUri = vscode.Uri.file(path.join(this.templateRoot, 'manifest.json'));
    try {
      await vscode.workspace.fs.stat(manifestUri);
    } catch (error: any) {
      if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
        throw new Error(`Template manifest not found at: ${manifestUri.fsPath}`);
      }
      throw new Error(`Failed to access template manifest at ${manifestUri.fsPath}: ${error?.message || error}`);
    }

    const contentBytes = await vscode.workspace.fs.readFile(manifestUri);
    const content = Buffer.from(contentBytes).toString('utf8');
    this.manifestCache = JSON.parse(content);

    this.logger.debug(`Loaded template manifest v${this.manifestCache!.version}`);
    return this.manifestCache!;
  }

  /**
   * Copy a template to target location with variable substitution
   * @param name
   * @param targetPath
   * @param context
   */
  private async copyTemplate(name: string, targetPath: string | vscode.Uri, context: TemplateContext): Promise<void> {
    const content = await this.renderTemplate(name, context);

    // Resolve target URI
    const targetUri = typeof targetPath === 'string' ? vscode.Uri.file(targetPath) : targetPath;

    // Ensure target directory exists
    const targetDir = vscode.Uri.joinPath(targetUri, '..');
    try {
      await vscode.workspace.fs.createDirectory(targetDir);
    } catch {
      // Ignore error if directory already exists
    }

    // Write file using workspace filesystem (supports remote)
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
    this.logger.debug(`Copied template '${name}' to: ${targetUri.fsPath}`);
  }

  /**
   * Render a template with variable substitution
   * @param name
   * @param context
   */
  public async renderTemplate(name: string, context: TemplateContext): Promise<string> {
    const manifest = await this.loadManifest();
    const template = manifest.templates[name];

    if (!template) {
      throw new Error(`Template '${name}' not found`);
    }

    const templateUri = vscode.Uri.file(path.join(this.templateRoot, template.path));
    try {
      await vscode.workspace.fs.stat(templateUri);
    } catch (error: any) {
      if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
        throw new Error(`Template file not found: ${templateUri.fsPath}`);
      }
      throw new Error(`Failed to access template file at ${templateUri.fsPath}: ${error?.message || error}`);
    }

    const contentBytes = await vscode.workspace.fs.readFile(templateUri);
    let content = Buffer.from(contentBytes).toString('utf8');

    // Enhance context with computed values
    const enhancedContext = this.enhanceContext(context);

    // Substitute variables using safe regex utility
    content = replaceVariables(content, enhancedContext);

    return content;
  }

  /**
   * Scaffold a complete project
   * @param targetPath
   * @param context
   */
  public async scaffoldProject(targetPath: string | vscode.Uri, context: TemplateContext): Promise<void> {
    const targetUri = typeof targetPath === 'string' ? vscode.Uri.file(targetPath) : targetPath;
    this.logger.info(`Scaffolding project at: ${targetUri.fsPath}`);

    // Copy all templates
    const manifest = await this.loadManifest();

    // Check if this is a skill scaffold (contains SKILL.md template)
    // Check if this is a dedicated skill scaffold (not a project scaffold with skill examples)
    // A dedicated skill scaffold has SKILL.md.template at the root level
    const isSkillScaffold = manifest.templates['skill-md'] && Object.values(manifest.templates).some(
      (t) => t.path === 'SKILL.md.template'
    );

    // For skill scaffolds, create files in a subdirectory named after the project
    const effectiveTargetUri = isSkillScaffold && context.projectName
      ? vscode.Uri.joinPath(targetUri, context.projectName)
      : targetUri;
    for (const [name, template] of Object.entries(manifest.templates)) {
      if (!template.required) {
        continue;
      }

      const relativePath = this.resolveRelativePath(name, template.path);
      const targetFile = vscode.Uri.joinPath(effectiveTargetUri, relativePath);

      await this.copyTemplate(name, targetFile, context);
    }

    this.logger.info('Scaffold completed successfully');
  }
}
