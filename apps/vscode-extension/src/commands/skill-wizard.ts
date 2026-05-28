import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

export interface SkillWizardResult {
  skillName: string;
  skillPath: string;
  collectionPath?: string;
  success: boolean;
}

/**
 * Wizard for creating Agent Skills within an existing awesome-copilot project.
 * Handles skill creation, collection integration, and validation.
 */
export class SkillWizard {
  private readonly logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Check if the current workspace is an awesome-copilot project
   * @param workspaceRoot
   */
  public isAwesomeCopilotProject(workspaceRoot: string): boolean {
    const collectionsDir = path.join(workspaceRoot, 'collections');
    const skillsDir = path.join(workspaceRoot, 'skills');
    const hasCollections = fs.existsSync(collectionsDir);
    const hasSkills = fs.existsSync(skillsDir);

    // Check for collection files
    if (hasCollections) {
      const files = fs.readdirSync(collectionsDir);
      const hasCollectionFiles = files.some((f) => f.endsWith('.collection.yml'));
      if (hasCollectionFiles) {
        return true;
      }
    }

    // Also consider it an awesome-copilot project if it has a skills directory
    return hasSkills;
  }

  /**
   * Get list of collection files in the workspace
   * @param workspaceRoot
   */
  public getCollectionFiles(workspaceRoot: string): string[] {
    const collectionsDir = path.join(workspaceRoot, 'collections');
    if (!fs.existsSync(collectionsDir)) {
      return [];
    }

    return fs.readdirSync(collectionsDir)
      .filter((f) => f.endsWith('.collection.yml'))
      .map((f) => path.join(collectionsDir, f));
  }

  /**
   * Validate skill name format
   * @param name
   */
  public validateSkillName(name: string): string | undefined {
    if (!name || name.trim().length === 0) {
      return 'Skill name is required';
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      return 'Name must contain only lowercase letters, numbers, and hyphens';
    }
    if (name.length > 64) {
      return 'Name must not exceed 64 characters';
    }
    return undefined;
  }

  /**
   * Validate skill description
   * @param description
   */
  public validateDescription(description: string): string | undefined {
    if (!description || description.trim().length === 0) {
      return 'Description is required';
    }
    if (description.length < 10) {
      return 'Description must be at least 10 characters';
    }
    if (description.length > 1024) {
      return 'Description must not exceed 1024 characters';
    }
    return undefined;
  }

  /**
   * Generate SKILL.md content
   * @param name
   * @param description
   */
  public generateSkillContent(name: string, description: string): string {
    return `---
name: ${name}
description: "${description}"
---

# ${name}

${description}

## Capabilities

Describe what this skill enables Copilot to do.

## Usage

Explain when and how Copilot should use this skill.

## Examples

Provide example interactions or use cases.
`;
  }

  /**
   * Add skill to a collection file
   * @param collectionPath
   * @param skillName
   */
  public async addSkillToCollection(collectionPath: string, skillName: string): Promise<void> {
    const content = fs.readFileSync(collectionPath, 'utf8');
    const collection = yaml.load(content) as { items?: { path: string; kind: string }[] };

    if (!collection.items) {
      collection.items = [];
    }

    const skillPath = `skills/${skillName}/SKILL.md`;

    // Check if skill already exists in collection
    const exists = collection.items.some((item) => item.path === skillPath);
    if (exists) {
      this.logger.info(`Skill ${skillName} already exists in collection`);
      return;
    }

    // Add skill to items
    collection.items.push({
      path: skillPath,
      kind: 'skill'
    });

    // Write back to file
    const newContent = yaml.dump(collection, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false
    });
    fs.writeFileSync(collectionPath, newContent);

    this.logger.info(`Added skill ${skillName} to collection ${path.basename(collectionPath)}`);
  }

  /**
   * Run skill validation
   * @param workspaceRoot
   */
  public async runValidation(workspaceRoot: string): Promise<boolean> {
    const validateScript = path.join(workspaceRoot, 'scripts', 'validate-skills.js');
    const nodeModulesPath = path.join(workspaceRoot, 'node_modules');

    if (!fs.existsSync(validateScript)) {
      this.logger.warn('Skill validation script not found');
      return true; // Skip validation if script doesn't exist
    }

    // Check if dependencies are installed
    if (!fs.existsSync(nodeModulesPath)) {
      this.logger.info('Skipping validation - dependencies not installed yet');
      vscode.window.showInformationMessage(
        'Skill created! Run `npm install` then `npm run skill:validate` to validate.'
      );
      return true; // Skip validation, dependencies not installed yet
    }

    const { exec } = await import('node:child_process');
    return new Promise((resolve) => {
      exec(`node "${validateScript}"`, { cwd: workspaceRoot }, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          this.logger.error('Skill validation failed', error);
          vscode.window.showErrorMessage(`Skill validation failed: ${stderr || error.message}`);
          resolve(false);
        } else {
          this.logger.info('Skill validation passed');
          resolve(true);
        }
      });
    });
  }

  /**
   * Execute the skill creation wizard within an existing awesome-copilot project
   * @param workspaceRoot
   */
  public async execute(workspaceRoot: string): Promise<SkillWizardResult | undefined> {
    // Step 1: Ask for skill name
    const skillName = await vscode.window.showInputBox({
      prompt: 'Enter skill name (lowercase letters, numbers, hyphens)',
      placeHolder: 'my-skill',
      validateInput: (value) => this.validateSkillName(value),
      ignoreFocusOut: true
    });

    if (!skillName) {
      return undefined;
    }

    // Check if skill already exists
    const skillDir = path.join(workspaceRoot, 'skills', skillName);
    if (fs.existsSync(skillDir)) {
      vscode.window.showErrorMessage(`Skill "${skillName}" already exists`);
      return undefined;
    }

    // Step 2: Ask for description
    const description = await vscode.window.showInputBox({
      prompt: 'Enter skill description (10-1024 characters)',
      placeHolder: 'A concise description of what this skill enables',
      validateInput: (value) => this.validateDescription(value || ''),
      ignoreFocusOut: true
    });

    if (!description) {
      return undefined;
    }

    // Step 3: Ask which collection to add the skill to
    const collections = this.getCollectionFiles(workspaceRoot);
    let selectedCollection: string | undefined;

    if (collections.length > 0) {
      const collectionChoices = [
        {
          label: '$(close) None',
          description: 'Do not add to any collection',
          value: undefined as string | undefined
        },
        ...collections.map((c) => ({
          label: `$(file) ${path.basename(c)}`,
          description: path.relative(workspaceRoot, c),
          value: c
        }))
      ];

      const choice = await vscode.window.showQuickPick(collectionChoices, {
        placeHolder: 'Select a collection to add the skill to (optional)',
        title: 'Add to Collection',
        ignoreFocusOut: true
      });

      if (choice === undefined) {
        return undefined; // User cancelled
      }

      selectedCollection = choice.value;
    }

    // Step 4: Create the skill
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating Agent Skill...',
          cancellable: false
        },
        async (progress) => {
          // Ensure skills directory exists
          const skillsDir = path.join(workspaceRoot, 'skills');
          if (!fs.existsSync(skillsDir)) {
            fs.mkdirSync(skillsDir, { recursive: true });
          }

          // Create skill directory
          progress.report({ message: 'Creating skill directory...' });
          fs.mkdirSync(skillDir, { recursive: true });

          // Create SKILL.md
          progress.report({ message: 'Creating SKILL.md...' });
          const skillContent = this.generateSkillContent(skillName, description);
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

          // Add to collection if selected
          if (selectedCollection) {
            progress.report({ message: 'Adding to collection...' });
            await this.addSkillToCollection(selectedCollection, skillName);
          }

          // Run validation
          progress.report({ message: 'Validating...' });
          await this.runValidation(workspaceRoot);
        }
      );

      // Show success and offer to open the file
      const action = await vscode.window.showInformationMessage(
        `Agent Skill "${skillName}" created successfully!`,
        'Open SKILL.md',
        selectedCollection ? 'Open Collection' : 'Close'
      );

      const skillMdPath = path.join(skillDir, 'SKILL.md');

      if (action === 'Open SKILL.md') {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(skillMdPath));
      } else if (action === 'Open Collection' && selectedCollection) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(selectedCollection));
      }

      return {
        skillName,
        skillPath: skillMdPath,
        collectionPath: selectedCollection,
        success: true
      };
    } catch (error) {
      this.logger.error('Failed to create skill', error as Error);
      vscode.window.showErrorMessage(`Failed to create skill: ${(error as Error).message}`);
      return {
        skillName,
        skillPath: path.join(skillDir, 'SKILL.md'),
        success: false
      };
    }
  }
}
