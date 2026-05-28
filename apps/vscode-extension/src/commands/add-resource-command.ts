import {
  execSync,
} from 'node:child_process';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  TemplateEngine,
} from '../services/template-engine';
import {
  generateSanitizedId,
} from '../utils/bundle-name-utils';

export enum ResourceType {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Prompt = 'prompt',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Instruction = 'instruction',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Agent = 'agent',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  Skill = 'skill'
}

interface ResourceTypeInfo {
  label: string;
  description: string;
  icon: string;
  folder: string;
  extension: string;
  template: string;
}

export class AddResourceCommand {
  private readonly templateEngine: TemplateEngine;
  private readonly resourceTypes: Map<ResourceType, ResourceTypeInfo>;

  constructor(extensionPathOrTemplateRoot?: string) {
    // If path includes 'templates/resources', use it directly (for tests)
    // Otherwise treat as extensionPath and append templates/resources path
    let templatesPath: string;
    if (extensionPathOrTemplateRoot) {
      templatesPath = extensionPathOrTemplateRoot.includes('templates/resources')
        || extensionPathOrTemplateRoot.includes('templates\\resources')
        ? extensionPathOrTemplateRoot
        : path.join(extensionPathOrTemplateRoot, 'templates/resources');
    } else {
      templatesPath = path.join(__dirname, '../templates/resources');
    }
    this.templateEngine = new TemplateEngine(templatesPath);

    this.resourceTypes = new Map([
      [ResourceType.Prompt, {
        label: '$(file-text) Prompt',
        description: 'Interactive prompt for Copilot',
        icon: '$(file-text)',
        folder: 'prompts',
        extension: '.prompt.md',
        template: 'prompt.template.md'
      }],
      [ResourceType.Instruction, {
        label: '$(book) Instruction',
        description: 'Step-by-step guidance document',
        icon: '$(book)',
        folder: 'instructions',
        extension: '.instructions.md',
        template: 'instruction.template.md'
      }],

      [ResourceType.Agent, {
        label: '$(robot) Agent',
        description: 'Autonomous AI agent configuration',
        icon: '$(robot)',
        folder: 'agents',
        extension: '.agent.md',
        template: 'agent.template.md'
      }],
      [ResourceType.Skill, {
        label: '$(lightbulb) Skill',
        description: 'Agent skill with domain expertise',
        icon: '$(lightbulb)',
        folder: 'skills',
        extension: '.skill.md',
        template: 'skill.template.md'
      }]
    ]);
  }

  private async getWorkspaceFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return undefined;
    }

    if (folders.length === 1) {
      return folders[0].uri.fsPath;
    }

    const selected = await vscode.window.showQuickPick(
      folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f
      })),
      { placeHolder: 'Select workspace folder', ignoreFocusOut: true }
    );

    return selected?.folder.uri.fsPath;
  }

  private async selectResourceType(): Promise<ResourceType | undefined> {
    const items: vscode.QuickPickItem[] = Array.from(this.resourceTypes.entries()).map(
      ([type, info]) => ({
        label: info.label,
        description: info.description,
        detail: `Creates a new ${type} in ${info.folder}/`,
        type: type as any
      })
    );

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select resource type to add',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });

    return selected ? (selected as any).type : undefined;
  }

  private async promptForResourceName(): Promise<string | undefined> {
    return await vscode.window.showInputBox({
      prompt: 'Enter resource name',
      placeHolder: 'e.g., Code Review Helper',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Resource name is required';
        }
        if (value.length > 100) {
          return 'Resource name must be 100 characters or less';
        }
        return null;
      }
    });
  }

  private async promptForDescription(): Promise<string | undefined> {
    return await vscode.window.showInputBox({
      prompt: 'Enter resource description',
      placeHolder: 'e.g., Helps review code for best practices and potential issues',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Description is required';
        }
        if (value.length > 500) {
          return 'Description must be 500 characters or less';
        }
        return null;
      }
    });
  }

  private async promptForAuthor(): Promise<string | undefined> {
    const gitConfig = await this.getGitUserName();
    return await vscode.window.showInputBox({
      prompt: 'Enter author name',
      placeHolder: 'Your name',
      ignoreFocusOut: true,
      value: gitConfig,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Author name is required';
        }
        return null;
      }
    });
  }

  private async getGitUserName(): Promise<string> {
    try {
      return execSync('git config user.name', { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  private async addToCollection(workspaceRoot: string, resourcePath: string, resourceType: ResourceType): Promise<void> {
    try {
      const collectionsDir = path.join(workspaceRoot, 'collections');
      const collectionsDirUri = vscode.Uri.file(collectionsDir);

      // Check if collections directory exists
      try {
        await vscode.workspace.fs.stat(collectionsDirUri);
      } catch {
        vscode.window.showWarningMessage('No collections directory found');
        return;
      }

      // Find collection files
      const entries = await vscode.workspace.fs.readDirectory(collectionsDirUri);
      const collectionFiles = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.collection.yml'))
        .map(([name]) => name);

      if (collectionFiles.length === 0) {
        vscode.window.showWarningMessage('No collection files found');
        return;
      }

      // Let user select collection
      const selected = await vscode.window.showQuickPick(
        collectionFiles.map((f) => ({
          label: f,
          description: path.join('collections', f)
        })),
        { placeHolder: 'Select collection to add resource to', ignoreFocusOut: true }
      );

      if (!selected) {
        return;
      }

      const collectionUri = vscode.Uri.file(path.join(collectionsDir, selected.label));
      const collectionContentBytes = await vscode.workspace.fs.readFile(collectionUri);
      const collectionContent = Buffer.from(collectionContentBytes).toString('utf8');
      const collection: any = yaml.load(collectionContent);

      // Add resource to collection
      const relativePath = path.relative(workspaceRoot, resourcePath);
      const newItem = {
        path: relativePath,
        kind: resourceType
      };

      if (!collection.items) {
        collection.items = [];
      }

      // Check if already exists
      const exists = collection.items.some((item: any) => item.path === relativePath);
      if (exists) {
        vscode.window.showInformationMessage('Resource already exists in collection');
        return;
      }

      collection.items.push(newItem);

      // Write back
      const updatedContent = yaml.dump(collection);
      await vscode.workspace.fs.writeFile(collectionUri, Buffer.from(updatedContent, 'utf8'));

      vscode.window.showInformationMessage(`✓ Added resource to ${selected.label}`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to add to collection: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async execute(): Promise<void> {
    try {
      // Get workspace folder
      const workspaceFolder = await this.getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }

      // Select resource type
      const resourceType = await this.selectResourceType();
      if (!resourceType) {
        return;
      }

      // Get resource details
      const resourceName = await this.promptForResourceName();
      if (!resourceName) {
        return;
      }

      const resourceDescription = await this.promptForDescription();
      if (!resourceDescription) {
        return;
      }

      const author = await this.promptForAuthor();
      if (!author) {
        return;
      }

      // Create resource file
      const resourceInfo = this.resourceTypes.get(resourceType)!;
      const fileName = generateSanitizedId(resourceName) + resourceInfo.extension;
      const dirPath = path.join(workspaceFolder, resourceInfo.folder);
      const resourcePath = path.join(dirPath, fileName);

      // Check if file already exists
      const resourceUri = vscode.Uri.file(resourcePath);
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(resourceUri);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        const overwrite = await vscode.window.showWarningMessage(
          `File ${fileName} already exists. Overwrite?`,
          'Yes', 'No'
        );
        if (overwrite !== 'Yes') {
          return;
        }
      }

      // Ensure directory exists
      const dirUri = vscode.Uri.file(dirPath);
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // Directory may already exist, ignore error
      }

      // Prepare template context
      const context: any = {
        projectName: resourceName,
        collectionId: generateSanitizedId(resourceName),
        RESOURCE_NAME: resourceName,
        RESOURCE_DESCRIPTION: resourceDescription,
        AUTHOR: author,
        DATE: new Date().toISOString().split('T')[0],
        VERSION: '1.0.0'
      };

      // Render template using TemplateEngine
      const content = await this.templateEngine.renderTemplate(resourceInfo.template, context);

      // Write file
      await vscode.workspace.fs.writeFile(resourceUri, Buffer.from(content, 'utf8'));

      // Show success message
      const openFile = await vscode.window.showInformationMessage(
        `✓ Created ${resourceInfo.label.replace(/\$\([^)]+\)\s*/, '')} at ${path.relative(workspaceFolder, resourcePath)}`,
        'Open File', 'Add to Collection'
      );

      if (openFile === 'Open File') {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resourcePath));
        await vscode.window.showTextDocument(doc);
      } else if (openFile === 'Add to Collection') {
        await this.addToCollection(workspaceFolder, resourcePath, resourceType);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to add resource: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
