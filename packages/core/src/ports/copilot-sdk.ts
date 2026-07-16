/**
 * Copilot SDK port interface.
 *
 * Abstract interface for Copilot SDK integration — the AI-session
 * backend `app/discovery/recommendation-engine.ts`'s AI-powered path
 * depends on. Infrastructure layer provides concrete implementations
 * (e.g. a real Copilot SDK client for the CLI's `discover --ai`
 * command); this package only depends on the shape.
 *
 * Ported unchanged from the reference branch's
 * `core/src/ports/copilot-sdk.ts`.
 * @module ports/copilot-sdk
 */

/**
 * Permission request from Copilot SDK.
 */
export interface PermissionRequest {
  /** Kind of permission requested */
  readonly kind: string;
}

/**
 * Permission response to Copilot SDK.
 */
export interface PermissionResponse {
  /** Whether permission was approved or denied */
  readonly kind: 'approved' | 'denied';
}

/**
 * Options for creating a Copilot session.
 */
export interface SessionOptions {
  /** Model to use for the session */
  readonly model?: string;
  /** Skill directories to load custom skills from */
  readonly skillDirectories: readonly string[];
  /** Permission request handler */
  readonly onPermissionRequest: (request: PermissionRequest) => Promise<PermissionResponse>;
}

/**
 * Copilot session interface.
 */
export interface CopilotSession {
  /**
   * Send a prompt and wait for complete response.
   * @param prompt - The prompt to send.
   * @returns Complete response string.
   */
  sendAndWait(prompt: string): Promise<string>;

  /**
   * Send a prompt with streaming response.
   * @param prompt - The prompt to send.
   * @param onChunk - Callback for each chunk of the response.
   * @returns Complete response string.
   */
  sendWithStream(prompt: string, onChunk: (chunk: string) => void): Promise<string>;

  /**
   * Close the session and release resources.
   */
  close(): Promise<void>;
}

/**
 * Copilot SDK interface.
 *
 * Abstract interface for AI model integration. Concrete
 * implementations handle specific Copilot SDK versions.
 */
export interface CopilotSdk {
  /**
   * Check if Copilot SDK is available.
   * @returns True if SDK is available and can be used.
   */
  isAvailable(): boolean;

  /**
   * Create a Copilot session with custom skills.
   * @param options - Session configuration options.
   * @returns Copilot session instance.
   */
  createSession(options: SessionOptions): Promise<CopilotSession>;
}
