'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Execute only the pinned installed provider CLI, never consumer scripts or package hooks. */
function runValidationV1(env = process.env) {
  const args = [env.SUBJECT, 'validate', '--output', 'json', '--report-path', path.join(env.REPORT_DIR, 'report.md')];
  if (env.SUBJECT === 'hub') {
    args.push('--config', env.CONFIG_PATH);
  }
  if (env.POLICY_PATH) {
    args.push('--policy', env.POLICY_PATH);
  }
  if (env.MIN_SCORE) {
    args.push('--min-score', env.MIN_SCORE);
  }
  if (env.SUBJECT === 'collection' && env.COLLECTION_FILE) {
    args.push('--collection-file', env.COLLECTION_FILE);
  }
  if (env.SUBJECT === 'skill') {
    args.push('--skills-dir', env.SKILLS_DIR);
  }
  const launcher = path.join(env.REPORT_DIR, 'tools', 'node_modules', '@ai-primitives-hub', 'cli', 'bin', 'ai-primitives-hub-governance-v1.js');
  // Offline validation has no need for tokens, GitHub credentials or runtime injection.
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
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
function publishValidationV1(env = process.env) {
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
    process.exitCode = runValidationV1();
  } else if (mode === 'publish') {
    publishValidationV1();
  } else {
    throw new Error('Expected run or publish.');
  }
}

module.exports = { runValidationV1, publishValidationV1 };