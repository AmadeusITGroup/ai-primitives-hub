#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { listCollectionFiles, validateAllCollections, generateMarkdown } = require('../dist');

function parseArgs(argv) {
  const out = { verbose: false, collectionFiles: [], outputMarkdown: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose') {
      out.verbose = true;
    } else if (arg === '--output-markdown' && argv[i + 1]) {
      out.outputMarkdown = argv[i + 1];
      i++;
    } else if (arg === '--collection-file' && argv[i + 1]) {
      out.collectionFiles.push(argv[i + 1]);
      i++;
    }
  }
  return out;
}

const repoRoot = process.cwd();
const args = parseArgs(process.argv.slice(2));

const collectionsDir = path.join(repoRoot, 'collections');
if (!fs.existsSync(collectionsDir)) {
  console.error('❌ collections/ directory not found');
  process.exit(1);
}

const files = args.collectionFiles.length > 0 ? args.collectionFiles : listCollectionFiles(repoRoot);
console.log(`Found ${files.length} collection(s)`);

// Use validateAllCollections for complete validation including duplicate detection
const result = validateAllCollections(repoRoot, files);

// Output markdown for PR comments
if (args.outputMarkdown) {
  const markdown = generateMarkdown(result, files.length);
  fs.writeFileSync(args.outputMarkdown, markdown);
  console.log(`Markdown written to ${args.outputMarkdown}`);
}

// Human-readable output
result.fileResults.forEach((fileResult) => {
  if (!fileResult.ok) {
    console.error(`❌ ${fileResult.file}: invalid`);
    fileResult.errors.forEach((e) => console.error(`  - ${e}`));
  } else if (args.verbose) {
    console.log(`✓ ${fileResult.file}: valid`);
  }
  if (fileResult.warnings && fileResult.warnings.length > 0) {
    fileResult.warnings.forEach((w) => {
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning file=${fileResult.file}::${w}`);
      } else {
        console.warn(`⚠️  ${w}`);
      }
    });
  }
});

// Show cross-collection errors (duplicates)
const crossCollectionErrors = result.errors.filter((e) => e.includes('Duplicate collection'));
if (crossCollectionErrors.length > 0) {
  console.error('\n❌ Cross-collection errors:');
  crossCollectionErrors.forEach((e) => console.error(`  - ${e}`));
}

if (result.ok) {
  console.log(`\n✅ All ${files.length} collection(s) valid`);
} else {
  console.error(`\n❌ Validation failed with ${result.errors.length} error(s)`);
}

process.exit(result.ok ? 0 : 1);
