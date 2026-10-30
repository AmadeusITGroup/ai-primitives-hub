'use strict';

/** GitHub API boundary only. Report generation belongs to the shared app package. */
async function postGovernanceComment({ github, context, body, subject, sourceSha }) {
  if (!['hub', 'collection', 'skill'].includes(subject)) {
    throw new Error('Unsupported governance subject.');
  }
  const pr = context.payload.pull_request;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!pr || pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository) {
    return 'skipped';
  }
  // A newer synchronize event must not be replaced by this older run.
  if (sourceSha && sourceSha !== pr.head.sha) {
    return 'skipped';
  }
  const marker = `<!-- ${subject}-validation-report -->`;
  if (typeof body !== 'string' || !body.startsWith(`${marker}\n`)) {
    throw new Error('Provider governance report marker is missing or incorrect.');
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pr.number,
    per_page: 100
  });
  const existing = comments.find((comment) => comment.user?.type === 'Bot'
    && comment.user.login === 'github-actions[bot]'
    && comment.body?.startsWith(`${marker}\n`));
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
    return 'updated';
  }
  await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
  return 'created';
}

module.exports = { postGovernanceComment };