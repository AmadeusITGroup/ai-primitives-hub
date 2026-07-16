import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  defaultTokenProvider,
} from '../../src/auth/default-token-provider';

describe('defaultTokenProvider', () => {
  it('resolves a token from the env without shelling out to gh', async () => {
    const provider = defaultTokenProvider({ GITHUB_TOKEN: 'from-env', AI_PRIMITIVES_HUB_DISABLE_GH_CLI: '1' });
    await expect(provider.getToken('github.com')).resolves.toBe('from-env');
  });

  it('resolves from env without needing the gh CLI fallback to run', async () => {
    // AI_PRIMITIVES_HUB_DISABLE_GH_CLI is deliberately left unset here, so
    // the composite provider includes a real GhCliTokenProvider — but
    // CompositeTokenProvider short-circuits at the first resolved token,
    // so the (unmockable, real-process) gh fallback is never invoked.
    // This keeps the test hermetic without needing a `gh` binary present.
    const provider = defaultTokenProvider({ GITHUB_TOKEN: 'from-env' });
    await expect(provider.getToken('github.com')).resolves.toBe('from-env');
  });

  it('returns only the env provider when AI_PRIMITIVES_HUB_DISABLE_GH_CLI=1 and no token is set', async () => {
    const provider = defaultTokenProvider({ AI_PRIMITIVES_HUB_DISABLE_GH_CLI: '1' });
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined for a non-GitHub host even with a token set', async () => {
    const provider = defaultTokenProvider({ GITHUB_TOKEN: 'from-env', AI_PRIMITIVES_HUB_DISABLE_GH_CLI: '1' });
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
  });
});
