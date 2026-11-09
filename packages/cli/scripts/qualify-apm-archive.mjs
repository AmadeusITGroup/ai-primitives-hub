import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ZipBundleExtractor } from '@ai-primitives-hub/infra';

const APM_VERSION = '0.35.0';
const APM_SOURCE = `apm-cli==${APM_VERSION}`;

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const runUv = (args, options, { allowFailure = false } = {}) => {
  const result = spawnSync('uv', args, {
    ...options,
    encoding: 'utf8',
    env: {
      ...options.env,
      CI: '1'
    }
  });
  if (result.error) {
    throw new Error(`Could not run uv: ${result.error.message}`);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`uv exited with status ${String(result.status)}`);
  }
  return {
    output: `${result.stdout}\n${result.stderr}`,
    status: result.status
  };
};

const extractArchive = async (archivePath, outputDir) => {
  const files = await new ZipBundleExtractor().extract(await readFile(archivePath));
  for (const [filePath, bytes] of files) {
    const outputPath = path.resolve(outputDir, filePath);
    const relativePath = path.relative(outputDir, outputPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`Archive entry escapes the extraction directory: ${filePath}`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const [archiveArg, ...extraArgs] = args[0] === '--' ? args.slice(1) : args;
  if (!archiveArg || extraArgs.length > 0) {
    throw new Error('Usage: qualify-apm-archive.mjs <bundle.zip>');
  }

  const archivePath = path.resolve(archiveArg);
  if (path.extname(archivePath).toLowerCase() !== '.zip' || !(await stat(archivePath)).isFile()) {
    throw new Error(`Expected an existing ZIP archive: ${archivePath}`);
  }

  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'aph-apm-qualification-'));
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, 'config'),
    XDG_CACHE_HOME: path.join(isolatedHome, 'cache')
  };
  const options = { cwd: isolatedHome, env };

  try {
    console.log(`Pinned APM package: ${APM_SOURCE}`);
    const versionArgs = ['tool', 'run', '--from', APM_SOURCE, 'apm', '--version'];
    const versionResult = runUv(versionArgs, options);
    if (!versionResult.output.includes(APM_VERSION)) {
      throw new Error(`Expected APM ${APM_VERSION}; received: ${versionResult.output.trim()}`);
    }

    const directInstallArgs = [
      'tool', 'run', '--from', APM_SOURCE, 'apm', 'install', '--dry-run', archivePath
    ];
    console.log(`Direct ZIP command: uv ${directInstallArgs.map(quote).join(' ')}`);
    const directResult = runUv(directInstallArgs, options, { allowFailure: true });
    if (directResult.status !== 2 || !directResult.output.includes('not a valid APM bundle archive')) {
      throw new Error(`Unexpected direct ZIP install result: exit ${String(directResult.status)}`);
    }
    console.log(`Direct ZIP result: rejected as a local bundle by APM ${APM_VERSION}`);

    const extractedDir = path.join(isolatedHome, 'extracted-package');
    await mkdir(extractedDir);
    await extractArchive(archivePath, extractedDir);
    const sourceInstallArgs = [
      'tool', 'run', '--from', APM_SOURCE, 'apm', 'install', '--dry-run', extractedDir
    ];
    console.log(`Extracted-source command: uv ${sourceInstallArgs.map(quote).join(' ')}`);
    const sourceResult = runUv(sourceInstallArgs, options);
    if (!sourceResult.output.includes('Dry run completed')) {
      throw new Error('APM did not complete the extracted package dry-run');
    }
    console.log(`Result: PASS (APM ${APM_VERSION} accepts the extracted package directory; raw ZIP is not a local bundle)`);
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(`Result: FAIL (${error.message})`);
  process.exitCode = 1;
});
