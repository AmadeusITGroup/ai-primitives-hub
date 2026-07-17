#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const isLocal = process.argv.includes('--local');
const platform = process.platform;
const arch = process.arch;

console.log(`Building SEA for ${platform}-${arch}...`);

// Step 1: Build TypeScript
console.log('Building TypeScript...');
execSync('pnpm run build', { cwd: rootDir, stdio: 'inherit' });

// Step 2: Bundle with esbuild
console.log('Bundling with esbuild...');
execSync('node esbuild.config.mjs', { cwd: rootDir, stdio: 'inherit' });

// Step 3: Generate SEA blob
console.log('Generating SEA blob...');
execSync('node --experimental-sea-config sea-config.json', { cwd: rootDir, stdio: 'inherit' });

// Step 4: Copy Node executable
const nodePath = process.execPath;
const outputName = isLocal
  ? `ai-primitives-hub-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`
  : `ai-primitives-hub${platform === 'win32' ? '.exe' : ''}`;
const outputPath = path.join(rootDir, 'dist', outputName);

console.log(`Copying Node executable to ${outputPath}...`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.copyFileSync(nodePath, outputPath);

// Step 5: Remove signature (macOS)
if (platform === 'darwin') {
  console.log('Removing signature (macOS)...');
  try {
    execSync(`codesign --remove-signature "${outputPath}"`, { stdio: 'inherit' });
  } catch (e) {
    // Ignore if already unsigned
  }
}

// Step 6: Inject blob with postject
console.log('Injecting blob with postject...');
execSync(
  `npx -y postject "${outputPath}" NODE_SEA_BLOB sea-prep.blob ` +
  `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ` +
  `--macho-segment-name NODE_SEA`,
  { cwd: rootDir, stdio: 'inherit' }
);

// Step 7: Sign binary (macOS)
if (platform === 'darwin') {
  console.log('Signing binary (macOS)...');
  try {
    execSync(`codesign --sign - "${outputPath}"`, { stdio: 'inherit' });
  } catch (e) {
    // Ignore if signing fails
  }
}

// Step 8: Make executable
if (platform !== 'win32') {
  console.log('Making executable...');
  fs.chmodSync(outputPath, '0755');
}

// Step 9: Generate checksum
console.log('Generating checksum...');
const hash = crypto.createHash('sha256');
const fileBuffer = fs.readFileSync(outputPath);
hash.update(fileBuffer);
const checksum = hash.digest('hex');
fs.writeFileSync(`${outputPath}.sha256`, checksum);

// Step 10: Clean up
console.log('Cleaning up...');
fs.unlinkSync(path.join(rootDir, 'sea-prep.blob'));

console.log(`Single executable created at: ${outputPath}`);
console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`SHA256: ${checksum}`);
