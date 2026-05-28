/**
 * GitHub Copilot Integration
 * Exposes installed prompts as chat participant with slash commands
 */

import * as vscode from 'vscode';
import {
  PromptExecutor,
} from '../services/prompt-executor';
import {
  PromptLoader,
} from '../services/prompt-loader';
import {
  Logger,
} from '../utils/logger';

export class CopilotIntegration implements vscode.Disposable {
  private participant: vscode.ChatParticipant | undefined;
  private readonly promptLoader: PromptLoader;
  private readonly promptExecutor: PromptExecutor;
  private readonly logger: Logger;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
    this.promptLoader = new PromptLoader(context);
    this.promptExecutor = new PromptExecutor(context);
  }

  /**
   * Handle chat requests from `@prompts` participant
   * @param request
   * @param context
   * @param stream
   * @param token
   */
  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    try {
      const command = request.command;
      const userInput = request.prompt;

      this.logger.debug(`Chat request: command=${command}, prompt="${userInput}"`);

      // Handle help command
      if (!command || command === 'help') {
        await this.showHelp(stream);
        return;
      }

      // Handle list command
      if (command === 'list') {
        await this.listPrompts(stream);
        return;
      }

      // Execute prompt command
      await this.executePrompt(command, userInput, stream, token);
    } catch (error) {
      this.logger.error('Error handling chat request', error as Error);
      stream.markdown(`\n\n❌ **Error:** ${(error as Error).message}\n\n`);
      stream.markdown('Try `@prompts /help` for available commands.\n');
    }
  }

  /**
   * Show help information
   * @param stream
   */
  private async showHelp(stream: vscode.ChatResponseStream): Promise<void> {
    const availablePrompts = await this.promptLoader.getAvailablePrompts();

    stream.markdown('# 📚 Prompt Registry\n\n');
    stream.markdown('Use installed prompts directly in Copilot Chat!\n\n');

    stream.markdown('## Available Commands\n\n');

    if (availablePrompts.length === 0) {
      stream.markdown('⚠️ No prompts installed yet.\n\n');
      stream.markdown('1. Install a bundle from the Prompt Registry view\n');
      stream.markdown('2. Activate a profile containing prompts\n');
      stream.markdown('3. Use prompts with `@prompts /command`\n\n');
    } else {
      for (const prompt of availablePrompts) {
        stream.markdown(`### \`/${prompt.id}\`\n`);
        stream.markdown(`**${prompt.name}**\n\n`);
        stream.markdown(`${prompt.description}\n\n`);
        stream.markdown(`*From bundle: ${prompt.bundleId}*\n\n`);
      }
    }

    stream.markdown('## Special Commands\n\n');
    stream.markdown('- `/help` - Show this help message\n');
    stream.markdown('- `/list` - List all available prompts\n\n');

    stream.markdown('## Usage\n\n');
    stream.markdown('```\n');
    stream.markdown('@prompts /code-review\n');
    stream.markdown('function add(a, b) { return a + b; }\n');
    stream.markdown('```\n\n');
  }

  /**
   * List available prompts
   * @param stream
   */
  private async listPrompts(stream: vscode.ChatResponseStream): Promise<void> {
    const availablePrompts = await this.promptLoader.getAvailablePrompts();

    stream.markdown('## 📋 Available Prompts\n\n');

    if (availablePrompts.length === 0) {
      stream.markdown('No prompts installed. Install bundles from the Prompt Registry view.\n');
      return;
    }

    // Group by bundle
    const byBundle = new Map<string, typeof availablePrompts>();
    for (const prompt of availablePrompts) {
      const bundlePrompts = byBundle.get(prompt.bundleId) || [];
      bundlePrompts.push(prompt);
      byBundle.set(prompt.bundleId, bundlePrompts);
    }

    for (const [bundleId, prompts] of byBundle) {
      stream.markdown(`### 📦 ${bundleId}\n\n`);
      for (const prompt of prompts) {
        stream.markdown(`- \`/${prompt.id}\` - ${prompt.name}\n`);
      }
      stream.markdown('\n');
    }
  }

  /**
   * Execute a prompt command
   * @param command
   * @param userInput
   * @param stream
   * @param token
   */
  private async executePrompt(
    command: string,
    userInput: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Show thinking indicator
    stream.progress('Loading prompt...');

    // Load prompt content
    const promptContent = await this.promptLoader.loadPrompt(command);

    if (!promptContent) {
      stream.markdown(`\n\n❌ **Prompt not found:** \`${command}\`\n\n`);
      stream.markdown('Available prompts:\n\n');
      await this.listPrompts(stream);
      return;
    }

    this.logger.debug(`Executing prompt: ${command}`);

    // DEBUG: Show what we're sending
    stream.markdown(`\n\n🔍 **DEBUG: Loading prompt "${command}"**\n\n`);
    stream.markdown(`- Prompt length: ${promptContent.content.length} chars\n`);
    stream.markdown(`- First 200 chars: ${promptContent.content.substring(0, 200)}...\n\n`);

    // Get current context (selection, file, etc.)
    const contextInfo = this.getEditorContext();

    // Execute prompt with language model
    stream.progress('Processing with AI...');

    await this.promptExecutor.execute({
      promptContent: promptContent.content,
      userInput,
      context: contextInfo,
      stream,
      token
    });
  }

  /**
   * Get current editor context
   */
  private getEditorContext(): { selection?: string; fileName?: string; language?: string } {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {};
    }

    const selection = editor.document.getText(editor.selection);
    const fileName = editor.document.fileName;
    const language = editor.document.languageId;

    return {
      selection: selection || undefined,
      fileName,
      language
    };
  }

  /**
   * Activate Copilot integration
   */
  public async activate(): Promise<void> {
    try {
      // Register chat participant
      this.participant = vscode.chat.createChatParticipant(
        'prompts',
        this.handleRequest.bind(this)
      );

      // Set participant icon
      this.participant.iconPath = new vscode.ThemeIcon('book');

      // Register as disposable
      this.context.subscriptions.push(this.participant);

      this.logger.info('Copilot integration activated: @prompts participant registered');
    } catch (error) {
      this.logger.error('Failed to activate Copilot integration', error as Error);

      // Check if Chat API is available
      if (!vscode.chat) {
        this.logger.warn('Chat API not available - GitHub Copilot may not be installed or enabled');
        vscode.window.showWarningMessage(
          'GitHub Copilot Chat is required to use prompt commands. Please install GitHub Copilot extension.'
        );
      }
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.participant?.dispose();
    this.logger.debug('Copilot integration disposed');
  }
}
