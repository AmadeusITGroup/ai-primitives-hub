/**
 * Template Engine for CLI scaffolding.
 *
 * Adapted from VS Code extension's TemplateEngine but using Node.js fs
 * instead of vscode.workspace.fs for CLI compatibility.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ScaffoldResult,
  TemplateContext,
  TemplateInfo,
  TemplateManifest,
} from '@prompt-registry/core';

/**
 * Escape special regex characters in a string.
 * @param str
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace all occurrences of a literal string in text.
 * @param text
 * @param search
 * @param replacement
 */
function replaceAll(text: string, search: string, replacement: string): string {
  const escapedSearch = escapeRegex(search);
  const regex = new RegExp(escapedSearch, 'g');
  return text.replace(regex, () => replacement);
}

/**
 * Replace template variables in text with values.
 * @param text
 * @param variables
 * @param options
 * @param options.prefix
 * @param options.suffix
 */
function replaceVariables(
  text: string,
  variables: Record<string, string>,
  options: {
    prefix?: string;
    suffix?: string;
  } = {}
): string {
  const { prefix = '{{', suffix = '}}' } = options;
  let result = text;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `${prefix}${key}${suffix}`;
    result = replaceAll(result, placeholder, value);
  }

  return result;
}

/**
 * Sanitize an ID by converting to lowercase and replacing non-alphanumeric chars with hyphens.
 * @param name
 */
function generateSanitizedId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Template Engine for scaffolding files from templates.
 */
export class TemplateEngine {
  private manifestCache?: TemplateManifest;

  constructor(private readonly templateRoot: string) {}

  /**
   * Resolve relative path for a template, handling special cases.
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
      return path.join('.github', relativePath);
    }

    return relativePath;
  }

  /**
   * Enhance context with computed values.
   * @param context
   */
  private enhanceContext(context: TemplateContext): Record<string, string> {
    const enhanced: Record<string, string> = { ...context };

    // Compute packageName from projectName (kebab-case)
    if (context.projectName) {
      enhanced.packageName = generateSanitizedId(context.projectName);
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

    // Format tags as complete YAML section
    if (enhanced.tags) {
      if (Array.isArray(enhanced.tags)) {
        const tagLines = enhanced.tags.map((t: string) => `  - ${t}`).join('\n');
        enhanced.tags_section = `tags:\n${tagLines}`;
      }
    } else {
      enhanced.tags_section = '';
    }

    // Defaults for organization details
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
   * Load template manifest.
   */
  private async loadManifest(): Promise<TemplateManifest> {
    if (this.manifestCache) {
      return this.manifestCache;
    }

    const manifestPath = path.join(this.templateRoot, 'manifest.json');
    try {
      await fs.access(manifestPath);
    } catch {
      throw new Error(`Template manifest not found at: ${manifestPath}`);
    }

    const content = await fs.readFile(manifestPath, 'utf8');
    this.manifestCache = JSON.parse(content) as TemplateManifest;

    return this.manifestCache;
  }

  /**
   * Copy a template to target location with variable substitution.
   * @param name
   * @param targetPath
   * @param context
   */
  private async copyTemplate(
    name: string,
    targetPath: string,
    context: TemplateContext
  ): Promise<void> {
    const content = await this.renderTemplate(name, context);

    // Ensure target directory exists
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });

    // Write file
    await fs.writeFile(targetPath, content, 'utf8');
  }

  /**
   * Render a template with variable substitution.
   * @param name
   * @param context
   */
  public async renderTemplate(name: string, context: TemplateContext): Promise<string> {
    const manifest = await this.loadManifest();
    const template = manifest.templates[name];

    if (!template) {
      throw new Error(`Template '${name}' not found`);
    }

    const templatePath = path.join(this.templateRoot, template.path);
    try {
      await fs.access(templatePath);
    } catch {
      throw new Error(`Template file not found: ${templatePath}`);
    }

    let content = await fs.readFile(templatePath, 'utf8');

    // Enhance context with computed values
    const enhancedContext = this.enhanceContext(context);

    // Substitute variables
    content = replaceVariables(content, enhancedContext);

    return content;
  }

  /**
   * Scaffold a complete project or set of files.
   * @param targetPath
   * @param context
   */
  public async scaffoldProject(
    targetPath: string,
    context: TemplateContext
  ): Promise<ScaffoldResult> {
    const createdFiles: string[] = [];

    try {
      const manifest = await this.loadManifest();

      // Check if this is a skill scaffold (contains SKILL.md template at root)
      const isSkillScaffold = manifest.templates['skill-md']
        && Object.values<TemplateInfo>(manifest.templates).some((t) => t.path === 'SKILL.md.template');

      // For skill scaffolds, create files in a subdirectory named after the project
      const effectiveTargetPath = isSkillScaffold && context.projectName
        ? path.join(targetPath, context.projectName)
        : targetPath;

      for (const [name, template] of Object.entries<TemplateInfo>(manifest.templates)) {
        if (!template.required) {
          continue;
        }

        const relativePath = this.resolveRelativePath(name, template.path);
        const targetFile = path.join(effectiveTargetPath, relativePath);

        await this.copyTemplate(name, targetFile, context);
        createdFiles.push(targetFile);
      }

      return { success: true, createdFiles };
    } catch (error) {
      return {
        success: false,
        createdFiles,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
