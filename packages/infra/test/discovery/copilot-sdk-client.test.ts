/**
 * Tests for Copilot SDK client.
 * @module test/infra/discovery/copilot-sdk-client
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CopilotSdkClient,
} from '../../src/discovery/copilot-sdk-client';
import type {
  SessionOptions,
} from '../../src/ports/copilot-sdk';

describe('CopilotSdkClient', () => {
  let client: CopilotSdkClient;

  beforeEach(() => {
    client = new CopilotSdkClient();
  });

  it('should implement CopilotSdk interface', () => {
    expect(client).toHaveProperty('isAvailable');
    expect(client).toHaveProperty('createSession');
  });

  it('should return false for isAvailable by default (mock implementation)', () => {
    expect(client.isAvailable()).toBe(false);
  });

  it('should create a mock session', async () => {
    const options: SessionOptions = {
      skillDirectories: ['/skills'],
      onPermissionRequest: vi.fn()
    };

    const session = await client.createSession(options);

    expect(session).toBeDefined();
    expect(session).toHaveProperty('sendAndWait');
    expect(session).toHaveProperty('sendWithStream');
    expect(session).toHaveProperty('close');
  });

  it('should handle session sendAndWait', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    const response = await session.sendAndWait('test prompt');

    // Mock implementation returns empty string
    expect(response).toBe('');
  });

  it('should handle session sendWithStream', async () => {
    const chunks: string[] = [];
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    const response = await session.sendWithStream('test prompt', (chunk: string) => {
      chunks.push(chunk);
    });

    // Mock implementation returns empty string
    expect(response).toBe('');
    expect(chunks).toHaveLength(0);
  });

  it('should handle session close', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    await session.close();

    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle multiple sequential sessions', async () => {
    const session1 = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    await session1.close();

    const session2 = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    await session2.close();

    // Should not throw
    expect(true).toBe(true);
  });

  it('should handle empty skill directories', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    expect(session).toBeDefined();
    await session.close();
  });

  it('should handle multiple skill directories', async () => {
    const session = await client.createSession({
      skillDirectories: ['/skills/1', '/skills/2', '/skills/3'],
      onPermissionRequest: vi.fn()
    });

    expect(session).toBeDefined();
    await session.close();
  });

  it('should handle permission request callback', async () => {
    const onPermissionRequest = vi.fn().mockResolvedValue({ kind: 'approved' as const });

    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest
    });

    // In mock implementation, this may not be called, but the callback should be accepted
    expect(session).toBeDefined();
    await session.close();
  });

  it('should handle permission request denial', async () => {
    const onPermissionRequest = vi.fn().mockResolvedValue({ kind: 'denied' as const });

    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest
    });

    expect(session).toBeDefined();
    await session.close();
  });

  it('should handle long prompts in sendAndWait', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    const longPrompt = 'a'.repeat(10_000);
    const response = await session.sendAndWait(longPrompt);

    // Mock implementation returns empty string
    expect(response).toBe('');
    await session.close();
  });

  it('should handle special characters in prompts', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    const specialPrompt = 'Test with "quotes" and \'apostrophes\' and <special> & symbols';
    const response = await session.sendAndWait(specialPrompt);

    // Mock implementation returns empty string
    expect(response).toBe('');
    await session.close();
  });

  it('should handle unicode in prompts', async () => {
    const session = await client.createSession({
      skillDirectories: [],
      onPermissionRequest: vi.fn()
    });

    const unicodePrompt = 'Test with unicode 🎉🎊🎈 and emojis 🚀';
    const response = await session.sendAndWait(unicodePrompt);

    // Mock implementation returns empty string
    expect(response).toBe('');
    await session.close();
  });
});
