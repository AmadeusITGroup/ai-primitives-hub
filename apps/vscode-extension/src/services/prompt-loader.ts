/**
 * Prompt Loader Service
 * Loads prompts from installed bundles
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  DeploymentManifest,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';

const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);

export interface PromptInfo {
  id: string;
  name: string;
  description: string;
  bundleId: string;
  filePath: string;
  tags: string[];
}

export interface PromptContent {
  info: PromptInfo;
  content: string;
}

/**
 * Service to load prompts from installed bundles
 */
export class PromptLoader {
  private readonly logger: Logger;
  private readonly promptCache: Map<string, PromptContent> = new Map();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
  }

  /**
   * Get prompts from a specific bundle
   * @param bundleId
   * @param bundlePath
   */
  private async getPromptsFromBundle(bundleId: string, bundlePath: string): Promise<PromptInfo[]> {
    const prompts: PromptInfo[] = [];

    try {
      // Read deployment manifest
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`No manifest found for bundle: ${bundleId}`);
        return [];
      }

      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = yaml.load(manifestContent) as DeploymentManifest;

      if (!manifest.prompts || manifest.prompts.length === 0) {
        this.logger.debug(`Bundle ${bundleId} has no prompts defined`);
        return [];
      }

      // Create PromptInfo for each prompt
      for (const promptDef of manifest.prompts) {
        const promptFilePath = path.join(bundlePath, promptDef.file);

        if (!fs.existsSync(promptFilePath)) {
          this.logger.warn(`Prompt file not found: ${promptFilePath}`);
          continue;
        }

        prompts.push({
          id: promptDef.id,
          name: promptDef.name,
          description: promptDef.description,
          bundleId,
          filePath: promptFilePath,
          tags: promptDef.tags || []
        });
      }

      return prompts;
    } catch (error) {
      this.logger.error(`Failed to load prompts from bundle ${bundleId}`, error as Error);
      return [];
    }
  }

  /**
   * Get list of available prompts from all installed bundles
   */
  public async getAvailablePrompts(): Promise<PromptInfo[]> {
    const prompts: PromptInfo[] = [];

    try {
      // Get bundles directory
      const bundlesDir = path.join(this.context.globalStorageUri.fsPath, 'bundles');

      if (!fs.existsSync(bundlesDir)) {
        this.logger.debug('Bundles directory does not exist');
        return [];
      }

      // Read all bundle directories
      const bundleDirs = await readdir(bundlesDir);

      for (const bundleId of bundleDirs) {
        const bundlePath = path.join(bundlesDir, bundleId);

        // Check if it's a directory
        const stat = fs.statSync(bundlePath);
        if (!stat.isDirectory()) {
          continue;
        }

        // Load prompts from this bundle
        const bundlePrompts = await this.getPromptsFromBundle(bundleId, bundlePath);
        prompts.push(...bundlePrompts);
      }

      this.logger.debug(`Found ${prompts.length} available prompts`);
      return prompts;
    } catch (error) {
      this.logger.error('Failed to get available prompts', error as Error);
      return [];
    }
  }

  /**
   * Load a specific prompt by ID
   * @param promptId
   */
  public async loadPrompt(promptId: string): Promise<PromptContent | null> {
    try {
      // Check cache first
      if (this.promptCache.has(promptId)) {
        this.logger.debug(`Loading prompt from cache: ${promptId}`);
        return this.promptCache.get(promptId)!;
      }

      // Find prompt in available prompts
      const availablePrompts = await this.getAvailablePrompts();
      const promptInfo = availablePrompts.find((p) => p.id === promptId);

      if (!promptInfo) {
        this.logger.warn(`Prompt not found: ${promptId}`);
        return null;
      }

      // Load prompt content from file
      const content = await readFile(promptInfo.filePath, 'utf8');

      const promptContent: PromptContent = {
        info: promptInfo,
        content
      };

      // Cache it
      this.promptCache.set(promptId, promptContent);

      this.logger.debug(`Loaded prompt: ${promptId} (${content.length} chars)`);
      return promptContent;
    } catch (error) {
      this.logger.error(`Failed to load prompt: ${promptId}`, error as Error);
      return null;
    }
  }
}
