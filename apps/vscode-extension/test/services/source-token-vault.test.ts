import * as assert from 'node:assert';
import {
  SourceTokenVault,
} from '../../src/services/source-token-vault';

suite('SourceTokenVault', () => {
  test('stores tokens under source-scoped SecretStorage keys', async () => {
    const values = new Map<string, string>();
    const secrets = {
      get: async (key: string) => values.get(key),
      store: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      }
    } as any;
    const vault = new SourceTokenVault(secrets);

    await vault.set('artifactory-source', 'secret-token');

    assert.strictEqual(await vault.get('artifactory-source'), 'secret-token');
    assert.strictEqual(values.size, 1);
    assert.ok([...values.keys()][0].includes('artifactory-source'));
  });

  test('migrates legacy plaintext source tokens and returns sanitized sources', async () => {
    const values = new Map<string, string>();
    const vault = new SourceTokenVault({
      get: async (key: string) => values.get(key),
      store: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      }
    } as any);
    const sources = [{ id: 'legacy', token: 'legacy-secret' } as any];

    const sanitized = await vault.migrateLegacyTokens(sources);

    assert.strictEqual(await vault.get('legacy'), 'legacy-secret');
    assert.strictEqual(sanitized[0].token, undefined);
  });
});
