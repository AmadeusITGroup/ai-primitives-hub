import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  formatCredential,
  formatTokenOrigin,
} from '../../src/auth/format-token-origin';

describe('formatTokenOrigin', () => {
  it('renders a bare kind when there is no detail', () => {
    expect(formatTokenOrigin({ kind: 'explicit' })).toBe('explicit');
  });

  it('renders kind:detail so the user knows what to fix', () => {
    expect(formatTokenOrigin({ kind: 'setting', detail: 'promptregistry.githubToken' }))
      .toBe('setting:promptregistry.githubToken');
    expect(formatTokenOrigin({ kind: 'env', detail: 'GH_TOKEN' })).toBe('env:GH_TOKEN');
  });

  it('renders a VS Code account label in parentheses, since it is a name', () => {
    expect(formatTokenOrigin({ kind: 'vscode-session', detail: 'octocat' })).toBe('vscode-session(octocat)');
  });

  it('ignores an empty detail', () => {
    expect(formatTokenOrigin({ kind: 'gh-cli', detail: '' })).toBe('gh-cli');
  });
});

describe('formatCredential', () => {
  it('says the request was anonymous when there is no credential', () => {
    expect(formatCredential(undefined)).toBe('origin=anonymous');
  });

  it('reports the origin and a redacted token, never the token itself', () => {
    const token = 'gho_0123456789abcdef0123456789abcdef9c1e';
    const formatted = formatCredential({
      token,
      origin: { kind: 'vscode-session', detail: 'octocat' }
    });

    expect(formatted).toBe(`origin=vscode-session(octocat) token=***<len=${token.length},tail=9c1e>`);
    expect(formatted).not.toContain(token);
  });
});
