import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  SkillWizard,
} from '../commands/skill-wizard';
import {
  TemplateContext,
  TemplateEngine,
} from '../services/template-engine';
import {
  generateSanitizedId,
} from '../utils/bundle-name-utils';
import {
  Logger,
} from '../utils/logger';
import {
  NpmCliWrapper,
} from '../utils/npm-cli-wrapper';

export enum ScaffoldType {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Skill = 'skill',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  GitHub = 'github',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Apm = 'apm'
}

export interface ScaffoldOptions {
  projectName?: string;
  skipExamples?: boolean;
  type?: ScaffoldType;
  githubRunner?: string;
  description?: string;
  author?: string;
  tags?: string[];
  // Organization details for InnerSource LICENSE and docs
  githubOrg?: string;
  organizationName?: string;
  internalContact?: string;
  legalContact?: string;
  organizationPolicyLink?: string;
}

/**
 * Command to scaffold project structures with different types
 */
export class ScaffoldCommand {
  private readonly logger: Logger;
  private readonly templateEngine: TemplateEngine;
  private readonly scaffoldType: ScaffoldType;

  constructor(extensionPathOrTemplateRoot?: string, scaffoldType: ScaffoldType = ScaffoldType.GitHub) {
    this.logger = Logger.getInstance();
    this.scaffoldType = scaffoldType;

    // Initialize template engine with scaffold templates
    // If path includes 'templates/scaffolds', use it directly (for tests)
    // Otherwise treat as extensionPath and append templates/scaffolds path
    let templatesPath: string;
    if (extensionPathOrTemplateRoot) {
      templatesPath = extensionPathOrTemplateRoot.includes('templates/scaffolds') ? extensionPathOrTemplateRoot : path.join(extensionPathOrTemplateRoot, 'templates/scaffolds', scaffoldType);
    } else {
      templatesPath = path.join(__dirname, '../templates/scaffolds', scaffoldType);
    }
    this.templateEngine = new TemplateEngine(templatesPath);
  }

  /**
   * Execute the scaffold command
   * @param targetPath - Target directory path or URI
   * @param options - Scaffold options
   */
  public async execute(targetPath: string | vscode.Uri, options?: ScaffoldOptions): Promise<void> {
    try {
      const targetUri = typeof targetPath === 'string' ? vscode.Uri.file(targetPath) : targetPath;
      this.logger.info(`Scaffolding ${this.scaffoldType} structure at: ${targetUri.fsPath}`);

      // Resolve project name from path if not provided
      const projectDirName = path.basename(targetUri.fsPath);

      // Prepare template context
      const context: TemplateContext = {
        projectName: options?.projectName || projectDirName || 'github-prompts',
        collectionId: generateSanitizedId(options?.projectName || projectDirName),
        githubRunner: options?.githubRunner || 'ubuntu-latest',
        description: options?.description,
        author: options?.author,
        tags: options?.tags,
        // Organization details for InnerSource LICENSE and docs
        githubOrg: options?.githubOrg,
        organizationName: options?.organizationName,
        internalContact: options?.internalContact,
        legalContact: options?.legalContact,
        organizationPolicyLink: options?.organizationPolicyLink
      };

      // Use template engine to scaffold the entire project
      await this.templateEngine.scaffoldProject(targetUri, context);

      this.logger.info('Scaffold completed successfully');

      // Note: npm install prompt is handled by the caller (extension.ts)
      // to ensure it runs AFTER the progress indicator closes
    } catch (error) {
      this.logger.error('Scaffold failed', error as Error);
      throw error;
    }
  }

  /**
   * Run the scaffold command with full UI flow
   */
  public static async runWithUI(): Promise<void> {
    const logger = Logger.getInstance();

    try {
      // Step 1: Select scaffold type
      const scaffoldType = await ScaffoldCommand.promptForScaffoldType();
      if (!scaffoldType) {
        return;
      }

      // Step 2: Handle skill creation in existing project
      if (scaffoldType.value === ScaffoldType.Skill && await ScaffoldCommand.handleSkillInExistingProject()) {
        return;
      }

      // Step 3: Select target directory
      const targetPath = await ScaffoldCommand.promptForTargetDirectory(scaffoldType.label);
      if (!targetPath) {
        return;
      }

      // Step 4: Collect project details
      const options = await ScaffoldCommand.promptForProjectDetails(scaffoldType.value);
      if (!options) {
        return;
      }

      // Step 5: Execute scaffold with progress
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Scaffolding ${scaffoldType.label}...` },
        async () => {
          const cmd = new ScaffoldCommand(undefined, scaffoldType.value);
          await cmd.execute(targetPath, options);
        }
      );

      // Step 6: Post-scaffold actions
      await ScaffoldCommand.handlePostScaffoldActions(scaffoldType.label, targetPath);
    } catch (error) {
      logger.error('Scaffold failed', error as Error);
      vscode.window.showErrorMessage(`Scaffold failed: ${(error as Error).message}`);
    }
  }

  /**
   * Handle skill creation within existing project
   * @returns true if handled (wizard executed), false to continue normal flow
   */
  private static async handleSkillInExistingProject(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const skillWizard = new SkillWizard();

    if (skillWizard.isAwesomeCopilotProject(workspaceRoot)) {
      await skillWizard.execute(workspaceRoot);
      return true;
    }
    return false;
  }

  /**
   * Prompt user to select scaffold type
   */
  private static async promptForScaffoldType(): Promise<{ label: string; value: ScaffoldType } | undefined> {
    return vscode.window.showQuickPick(
      [
        {
          label: 'GitHub',
          description: 'GitHub-based prompt library with CI/CD workflows',
          value: ScaffoldType.GitHub
        },
        {
          label: 'APM Package',
          description: 'Distributable prompt package (apm.yml)',
          value: ScaffoldType.Apm
        },
        {
          label: 'Agent Skill',
          description: 'Create a new Agent Skill with SKILL.md',
          value: ScaffoldType.Skill
        }
      ],
      {
        placeHolder: 'Select project type',
        title: 'Scaffold Project',
        ignoreFocusOut: true
      }
    );
  }

  /**
   * Prompt user to select target directory
   * @param typeLabel
   */
  private static async promptForTargetDirectory(typeLabel: string): Promise<vscode.Uri | undefined> {
    // Default to first workspace folder if available
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;

    const targetPath = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri,
      title: `Select Target Directory for ${typeLabel}`
    });
    return targetPath?.[0];
  }

  /**
   * Collect project details from user input
   * @param type
   */
  private static async promptForProjectDetails(type: ScaffoldType): Promise<ScaffoldOptions | undefined> {
    // Get project name
    const projectName = await vscode.window.showInputBox({
      prompt: 'Enter project name (optional)',
      placeHolder: 'example',
      value: 'example',
      ignoreFocusOut: true
    });

    // Get GitHub runner choice
    const githubRunner = await ScaffoldCommand.promptForGitHubRunner();
    let details: { description?: string; author?: string; tags?: string[] } = {};
    let orgDetails: { organizationName?: string; internalContact?: string; legalContact?: string; organizationPolicyLink?: string } = {};

    // Collect additional details if needed

    if (type === ScaffoldType.Apm) {
      const apmDetails = await ScaffoldCommand.promptForApmDetails();
      if (apmDetails) {
        details = apmDetails;
      }
    }

    if (type === ScaffoldType.Skill) {
      const skillsDetails = await ScaffoldCommand.promptForSkillsDetails();
      if (skillsDetails) {
        details = skillsDetails;
      }
    }

    // For GitHub type, collect organization details for InnerSource LICENSE
    if (type === ScaffoldType.GitHub) {
      orgDetails = await ScaffoldCommand.promptForOrganizationDetails();
    }

    return {
      projectName,
      githubRunner,
      ...details,
      ...orgDetails
    };
  }

  /**
   * Prompt for GitHub Actions runner configuration
   */
  private static async promptForGitHubRunner(): Promise<string> {
    const runnerChoice = await vscode.window.showQuickPick(
      [
        {
          label: 'GitHub-hosted (ubuntu-latest)',
          description: 'Free GitHub-hosted runner',
          value: 'ubuntu-latest'
        },
        {
          label: 'Self-hosted',
          description: 'Use self-hosted runner',
          value: 'self-hosted'
        },
        {
          label: 'Custom',
          description: 'Specify custom runner label',
          value: 'custom'
        }
      ],
      {
        placeHolder: 'Select GitHub Actions runner type',
        title: 'GitHub Actions Runner',
        ignoreFocusOut: true
      }
    );

    if (runnerChoice?.value === 'self-hosted') {
      return 'self-hosted';
    }

    if (runnerChoice?.value === 'custom') {
      const customRunner = await vscode.window.showInputBox({
        prompt: 'Enter custom runner label',
        placeHolder: 'my-runner or [self-hosted, linux, x64]',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Runner label cannot be empty';
          }
          return undefined;
        },
        ignoreFocusOut: true
      });
      return customRunner || 'ubuntu-latest';
    }

    return 'ubuntu-latest';
  }

  /**
   * Prompt for project metadata (description, author, tags)
   * Shared by APM and Skill scaffold types
   * @param type - The scaffold type ('apm' or 'skill')
   */
  private static async promptForProjectMetadata(type: 'apm' | 'skill'): Promise<{ description?: string; author?: string; tags?: string[] }> {
    const typeLabel = type === 'apm' ? 'package' : 'skill';
    const defaultTags = type === 'apm' ? 'apm, prompts' : 'skill, prompts';

    const description = await vscode.window.showInputBox({
      prompt: `Enter ${typeLabel} description`,
      placeHolder: `A short description of your ${typeLabel}`,
      ignoreFocusOut: true
    });

    const author = await vscode.window.showInputBox({
      prompt: 'Enter author name',
      placeHolder: 'Your Name <email@example.com>',
      value: process.env.USER || 'user',
      ignoreFocusOut: true
    });

    const tagsInput = await vscode.window.showInputBox({
      prompt: 'Enter tags (comma separated)',
      placeHolder: 'ai, prompts, coding',
      value: defaultTags,
      ignoreFocusOut: true
    });

    const tags = tagsInput
      ? tagsInput.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;

    return { description, author, tags };
  }

  /**
   * Prompt for APM-specific project details
   */
  private static async promptForApmDetails(): Promise<{ description?: string; author?: string; tags?: string[] }> {
    return ScaffoldCommand.promptForProjectMetadata('apm');
  }

  /**
   * Prompt for Skill-specific project details
   */
  private static async promptForSkillsDetails(): Promise<{ description?: string; author?: string; tags?: string[] }> {
    return ScaffoldCommand.promptForProjectMetadata('skill');
  }

  /**
   * Prompt for organization details for InnerSource LICENSE and docs
   */
  private static async promptForOrganizationDetails(): Promise<{
    author?: string;
    githubOrg?: string;
    organizationName?: string;
    internalContact?: string;
    legalContact?: string;
    organizationPolicyLink?: string;
  }> {
    const author = await vscode.window.showInputBox({
      prompt: 'Enter author name (for package.json)',
      placeHolder: 'Your Name or Team Name',
      ignoreFocusOut: true
    });

    const githubOrg = await vscode.window.showInputBox({
      prompt: 'Enter GitHub organization/username (for repository URLs)',
      placeHolder: 'your-org',
      ignoreFocusOut: true
    });

    const organizationName = await vscode.window.showInputBox({
      prompt: 'Enter organization name (for LICENSE)',
      placeHolder: 'Your Organization Name',
      value: 'Your Organization',
      ignoreFocusOut: true
    });

    const internalContact = await vscode.window.showInputBox({
      prompt: 'Enter internal contact email (for security/support inquiries)',
      placeHolder: 'security@yourorg.com',
      value: 'security@yourorg.com',
      ignoreFocusOut: true
    });

    const legalContact = await vscode.window.showInputBox({
      prompt: 'Enter legal contact email (for licensing questions)',
      placeHolder: 'legal@yourorg.com',
      value: 'legal@yourorg.com',
      ignoreFocusOut: true
    });

    const organizationPolicyLink = await vscode.window.showInputBox({
      prompt: 'Enter organization policy URL (optional)',
      placeHolder: 'https://yourorg.com/policies',
      ignoreFocusOut: true
    });

    return {
      author,
      githubOrg,
      organizationName,
      internalContact,
      legalContact,
      organizationPolicyLink
    };
  }

  /**
   * Handle post-scaffold actions: npm install and folder opening
   * @param typeLabel
   * @param targetPath
   */
  private static async handlePostScaffoldActions(typeLabel: string, targetPath: vscode.Uri): Promise<void> {
    const npmWrapper = NpmCliWrapper.getInstance();
    await npmWrapper.installWithProgress(targetPath.fsPath);
    // The @prompt-registry/collection-scripts package is now available on npmjs
    const setupChoice = await vscode.window.showInformationMessage(
      `${typeLabel} scaffolded successfully!`,
      'Open Folder',
      'Skip'
    );
    if (setupChoice === 'Open Folder') {
      await vscode.commands.executeCommand('vscode.openFolder', targetPath);
    }
  }
}
