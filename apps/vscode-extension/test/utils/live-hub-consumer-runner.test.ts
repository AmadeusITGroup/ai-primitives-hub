import * as assert from 'node:assert';
import {
  spawnSync,
} from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

suite('Live hub consumer runner', () => {
  for (const { reference: credentialRef, message } of [
    {
      reference: 'bad-name',
      message: /APH_LIVE_ARTIFACTORY_CREDENTIAL_REF must be an uppercase environment-variable name/u
    },
    ...['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].map((reference) => ({
      reference,
      message: new RegExp(`APH_LIVE_ARTIFACTORY_CREDENTIAL_REF must not override the isolated environment variable ${reference}`, 'u')
    }))
  ]) {
    test(`validates credential reference ${credentialRef} before resolving the token`, () => {
      const runnerPath = path.resolve(__dirname, '../../../test/run-live-hub-consumer-tests.js');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APH_LIVE_ARTIFACTORY_ROOT: 'https://artifactory.example.test/repo',
        APH_LIVE_ARTIFACTORY_AUTH: 'bearer',
        APH_LIVE_ARTIFACTORY_CONFIG_FILE: '__CONFIG__/hub-config.yml',
        APH_LIVE_PROFILE_ID: 'example-profile',
        APH_LIVE_HUB_ID: 'example-hub',
        APH_LIVE_CLI_EXPECTED_FILE: 'expected-cli-file',
        APH_LIVE_VSCODE_EXPECTED_FILE: 'expected-vscode-file',
        APH_LIVE_ARTIFACTORY_CREDENTIAL_REF: credentialRef,
        APH_LIVE_ENV_FILE: path.join(os.tmpdir(), `aph-live-missing-${process.pid}-${Date.now()}.env`)
      };
      delete env.APH_LIVE_ARTIFACTORY_TOKEN;
      delete env.ARTIFACTORY_READER_TOKEN;
      delete env[credentialRef];

      const result = spawnSync(process.execPath, [runnerPath], {
        env,
        encoding: 'utf8',
        timeout: 5000
      });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, message);
    });
  }
});
