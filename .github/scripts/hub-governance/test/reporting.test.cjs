const assert = require('node:assert/strict');
const { test } = require('node:test');
const { postGovernanceComment } = require('../post-comment.cjs');

function boundary(comments = []) {
  const calls = [];
  const github = {
    paginate: async () => comments,
    rest: { issues: {
      listComments: () => {},
      updateComment: async (request) => calls.push(['update', request]),
      createComment: async (request) => calls.push(['create', request])
    } }
  };
  return { github, calls };
}

const context = {
  repo: { owner: 'org', repo: 'consumer' },
  payload: { pull_request: { number: 126, head: { sha: 'current', repo: { full_name: 'org/consumer' } }, base: { repo: { full_name: 'org/consumer' } } } }
};
const body = '<!-- hub-validation-report -->\n## Report\nPASS\n';

test('updates the paginated bot-owned comment, not a user marker spoof', async () => {
  const { github, calls } = boundary([
    { id: 1, body, user: { type: 'User', login: 'attacker' } },
    { id: 2, body, user: { type: 'Bot', login: 'other[bot]' } },
    { id: 3, body, user: { type: 'Bot', login: 'github-actions[bot]' } }
  ]);
  await postGovernanceComment({ github, context, body, subject: 'hub', sourceSha: 'current' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1].comment_id, 3);
});

test('creates exactly one report when no owned comment exists', async () => {
  const { github, calls } = boundary();
  await postGovernanceComment({ github, context, body, subject: 'hub', sourceSha: 'current' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].issue_number, 126);
});

test('skips push events without a pull request', async () => {
  const { github, calls } = boundary();
  await postGovernanceComment({ github, context: { ...context, payload: {} }, body, subject: 'hub' });
  assert.equal(calls.length, 0);
});

test('never writes a comment for an untrusted fork', async () => {
  const { github, calls } = boundary();
  const fork = { ...context, payload: { pull_request: { ...context.payload.pull_request, head: { sha: 'current', repo: { full_name: 'other/fork' } } } } };
  await postGovernanceComment({ github, context: fork, body, subject: 'hub', sourceSha: 'current' });
  assert.equal(calls.length, 0);
});

test('rejects an incorrect marker instead of replacing an unrelated report', async () => {
  const { github, calls } = boundary();
  await assert.rejects(postGovernanceComment({ github, context, body: '<!-- other -->', subject: 'hub', sourceSha: 'current' }), /marker/);
  assert.equal(calls.length, 0);
});

test('does not overwrite a newer report with a stale run', async () => {
  const { github, calls } = boundary();
  await postGovernanceComment({ github, context, body, subject: 'hub', sourceSha: 'old' });
  assert.equal(calls.length, 0);
});