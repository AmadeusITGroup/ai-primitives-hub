import {
  createHash,
} from 'node:crypto';
import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
} from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';

const fixtureDirectory = resolve(dirname(new URL(import.meta.url).pathname), '../../fixtures/security');

const expectedFixtures: Record<string, string> = {
  '.markdown.ignore': '60b367466d5bf144c34a8ebcc24f485746b5a6b3c9df2924b926e037ed7161de',
  'README.md': '814d624e5100a8c3d6e01daeaa681f0f53fc735c06f597fafcbc29e83b4e553e',
  'CHANGELOG.md': 'cafef13187b33369cd7061067c9b1de0aea92692863d36c8c7ce9e4acc8569bb',
  'agentic_threats.md': 'd9ae21b957b28f0e08ec46de398d2ec85379f22cb9bd9a10754a55bfb8574a3c',
  'clean.md': 'ff55490bbe6006420571171eeaa352f9cd74e72f69b5b4887fc3c7b6656d4cb8',
  'hardcoded_secrets.md': 'a5457a4fb4852bf6eb033258c912012f9bc09b78767fd4edb58f9ab2409d5318',
  'html_injection.md': 'f3376e4c1c068a20d114c8959e05aaa6694e69f61f718696757b9d7b44269611',
  'prompt_injection.md': '138e76f28d030ed9c517dcf1a6e6fbd1bad655ca583d0836b288690bb4182480'
};

describe('security reference fixtures', () => {
  it('keeps the upstream fixture set and content stable', () => {
    const actual = Object.fromEntries(readdirSync(fixtureDirectory, { encoding: 'utf8' }).map((name) => [
      name,
      createHash('sha256').update(readFileSync(resolve(fixtureDirectory, name))).digest('hex')
    ]));

    expect(actual).toEqual(expectedFixtures);
  });
});
