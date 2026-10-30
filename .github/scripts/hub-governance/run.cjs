'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Execute only the pinned installed provider CLI, never consumer scripts or package hooks. */
function runValidation(env = process.env, command = process.argv.slice(4)) {
  const [executable, subject, verb, ...options] = command;
  if (executable !== 'ai-primitives-hub' || subject !== env.SUBJECT || !['hub', 'collection', 'skill'].includes(subject) || verb !== 'validate') {
    throw new Error('Expected a standard ai-primitives-hub validation command.');
  }
  const checkSources = env.CHECK_SOURCES === 'true';
  const checkReleases = env.CHECK_RELEASES === 'true';
  if (checkSources && !['hub', 'collection'].includes(env.SUBJECT)) {
    throw new Error('--check-sources is supported only for hub and collection validation.');
  }
  if (checkReleases && env.SUBJECT !== 'collection') {
    throw new Error('--check-releases is supported only for collection validation.');
  }
  if (env.REPOSITORY && env.SUBJECT !== 'collection') {
    throw new Error('--repository is supported only for collection validation.');
  }
  const args = [subject, verb, ...options];
  const launcher = path.join(env.REPORT_DIR, 'tools', 'node_modules', '@ai-primitives-hub', 'cli', 'bin', 'ai-primitives-hub.js');
  // Offline validation has no need for tokens, GitHub credentials or runtime injection.
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  // The standard CLI otherwise falls back to a host gh login when no token exists.
  // CI must use only explicitly supplied credentials, even on self-hosted runners.
  childEnv.AI_PRIMITIVES_HUB_DISABLE_GH_CLI = '1';
  // Never inherit ambient credentials. Forward only a deliberately supplied
  // source token, only when a network check was explicitly enabled. A PR-scoped
  // collection run downloads the hub sources the PR added or modified.
  const collectionSources = env.SUBJECT === 'collection' && Boolean(env.HEAD_REF);
  if ((checkSources || checkReleases || collectionSources) && env.SOURCE_TOKEN) {
    childEnv.GH_TOKEN = env.SOURCE_TOKEN;
  }
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd: env.WORKING_DIRECTORY, encoding: 'utf8', env: childEnv });
  fs.writeFileSync(path.join(env.REPORT_DIR, 'result.json'), result.stdout ?? '');
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  // The process status, not a user-authored file, is the authoritative execution status.
  fs.writeFileSync(path.join(env.REPORT_DIR, 'exit-code.txt'), `${result.status ?? 1}\n`);
  return result.status ?? 1;
}

/** Always publish a summary, including when setup failed before validation could start. */
function publishValidation(env = process.env) {
  let verdict = 'fail';
  let score = '';
  let exitCode = 1;
  const resultPath = path.join(env.REPORT_DIR, 'result.json');
  const reportPath = path.join(env.REPORT_DIR, 'report.md');
  try {
    const envelope = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const result = envelope.data;
    const code = Number(fs.readFileSync(path.join(env.REPORT_DIR, 'exit-code.txt'), 'utf8').trim());
    if (result?.schemaVersion !== 1 || result.subject !== env.SUBJECT || !['pass', 'fail'].includes(result.verdict)
      || !Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
      throw new Error('Invalid provider result.');
    }
    if (result.verdict === 'pass' && (code !== 0 || envelope.status === 'error')) {
      throw new Error('Provider verdict does not match execution status.');
    }
    score = String(result.score);
    exitCode = code === 0 && result.verdict === 'pass' && envelope.status !== 'error' ? 0 : 1;
    verdict = exitCode === 0 ? 'pass' : 'fail';
    if (!fs.existsSync(reportPath) || !fs.readFileSync(reportPath, 'utf8').startsWith(`<!-- ${env.SUBJECT}-validation-report -->\n`)) {
      throw new Error('Provider report is missing or has an invalid marker.');
    }
  } catch {
    verdict = 'fail';
    score = '';
    exitCode = 1;
    fs.writeFileSync(reportPath, `<!-- ${env.SUBJECT}-validation-report -->\n## AI Primitives Hub validation\n\n**FAIL**: Provider setup or validation execution did not complete. See the job log for the failing step.\n`);
  }
  const markdown = fs.readFileSync(reportPath, 'utf8');
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  fs.appendFileSync(env.GITHUB_OUTPUT, `verdict=${verdict}\nscore=${score}\nexit-code=${exitCode}\nreport-path=${reportPath}\nresult-path=${resultPath}\n`);
  return exitCode;
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'run') {
    process.exitCode = runValidation();
  } else if (mode === 'publish') {
    publishValidation();
  } else {
    throw new Error('Expected run or publish.');
  }
}

module.exports = { runValidation, publishValidation };