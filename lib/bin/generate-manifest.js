#!/usr/bin/env node
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const { normalizeRepoRelativePath } = require('../dist');
const { resolveCollectionReadmePath } = require('../dist/collections');

function parseArgs(argv) {
  const out = {
    version: '0.0.0-dev',
    collectionFile: undefined,
    outFile: 'deployment-manifest.yml',
  };

  argv.forEach((arg, idx) => {
    if (arg === '--collection-file' && argv[idx + 1]) {
      out.collectionFile = argv[idx + 1];
    } else if (arg === '--out' && argv[idx + 1]) {
      out.outFile = argv[idx + 1];
    } else if (!arg.startsWith('--') && idx === 0) {
      out.version = arg;
    }
  });

  if (!out.version) out.version = '0.0.0-dev';
  return out;
}

const args = parseArgs(process.argv.slice(2));

try {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = fs.existsSync(packageJsonPath)
    ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    : {};
  const repoRoot = process.cwd();

  // Read collection file
  const collectionsDir = path.join(repoRoot, 'collections');
  let collectionFile = args.collectionFile;
  if (!collectionFile) {
    collectionFile = fs.readdirSync(collectionsDir).find((f) => f.endsWith('.collection.yml'));
    if (collectionFile) collectionFile = path.join('collections', collectionFile);
  }

  if (!collectionFile) {
    console.error('❌ No collection file found in collections/');
    process.exit(1);
  }

  const collectionAbs = path.isAbsolute(collectionFile)
    ? collectionFile
    : path.join(repoRoot, collectionFile);
  const collection = yaml.load(fs.readFileSync(collectionAbs, 'utf8'));

  // Map collection kinds to manifest types (only for those that need transformation)
  const kindToTypeMap = {
    instruction: 'instructions',
    'chat-mode': 'chatmode',
  };

  // Process all items into prompts array with type field
  const items = Array.isArray(collection.items) ? collection.items : [];

  const prompts = items.map((item) => {
    const itemPath = normalizeRepoRelativePath(item.path);
    const kind = item.kind;
    const itemAbs = path.join(repoRoot, itemPath);

    if (!fs.existsSync(itemAbs)) {
      const normalizedNote = item.path && item.path !== itemPath ? ` (normalized: ${itemPath})` : '';
      console.error(`❌ Referenced ${kind} file not found: ${item.path || itemPath}${normalizedNote}`);
      process.exit(1);
    }

    const itemContent = fs.readFileSync(itemAbs, 'utf8');
    const nameMatch = itemContent.match(/^#\s+(.+)$/m);
    const descMatch =
      itemContent.match(/^##?\s*Description[:\s]+(.+)$/im) || itemContent.match(/^>\s*(.+)$/m);

    // Clone tags array to avoid YAML anchors
    const tags = collection.tags ? [...collection.tags] : [];

    // Determine file extension
    const extension = path.extname(itemPath);

    // Map kind to type using the mapping
    const type = kindToTypeMap[kind] || kind;

    // Determine item ID: for skills, use parent folder name; otherwise use filename
    let itemId;
    if (kind === 'skill') {
      // For skills like "skills/example-skill/SKILL.md", use "example-skill"
      const pathParts = itemPath.split('/');
      itemId = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : path.basename(itemPath, extension);
    } else {
      itemId = path.basename(itemPath, extension);
    }

    return {
      id: itemId,
      name: nameMatch ? nameMatch[1] : itemId,
      description: descMatch ? descMatch[1] : '',
      file: itemPath,
      type: type,
      tags: tags,
    };
  });

  // Determine manifest id - should be the collection ID only, not the full bundle ID
  // The runtime will construct the full bundle ID from owner-repo-collectionId-version
  let manifestId = collection.id;
  if (!manifestId) {
    // fallback to package name (without scope prefix)
    manifestId = (packageJson.name || 'unknown')
      .replace('@amadeus-airlines-solutions/', '')
      .replace(/^@[^/]+\//, '');
  }

  // Extract MCP servers from either 'mcp.items' or 'mcpServers' field (matching AwesomeCopilotAdapter)
  const mcpServers = collection.mcpServers || (collection.mcp && collection.mcp.items);
  const mcpInputs = collection.mcp && collection.mcp.inputs;

  // Record the README asset filename so the runtime can locate it among the
  // release assets. GitHub names each release asset after its file basename,
  // so a readme declared as `docs/collection-overview.md` is published as
  // `collection-overview.md`. Storing the basename here lets adapters match it
  // reliably instead of guessing a fixed filename.
  const readmePath = resolveCollectionReadmePath(collection);
  const readmeAsset = readmePath ? path.basename(readmePath) : undefined;

  // Create deployment manifest
  const manifest = {
    id: manifestId,
    version: args.version,
    name: collection.name || packageJson.description,
    description: collection.description || packageJson.description,
    author: collection.author || packageJson.author || 'Prompt Registry',
    tags: collection.tags || packageJson.keywords || [],
    environments: ['vscode', 'windsurf', 'cursor'],
    license: packageJson.license || 'MIT',
    repository: packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') || '',
    prompts: prompts,
    dependencies: [],
    ...(readmeAsset ? { readme: readmeAsset } : {}),
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(mcpInputs && mcpInputs.length > 0 ? { mcpInputs } : {}),
  };

  // Write deployment manifest
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(args.outFile, yaml.dump(manifest, { lineWidth: -1 }));

  console.log('✓ Deployment manifest generated successfully');
  console.log(`  Version: ${args.version}`);
  console.log(`  ID: ${manifest.id}`);
  console.log(`  Total Items: ${prompts.length}`);

  // Log counts by type
  const typesCounts = {};
  prompts.forEach((p) => {
    typesCounts[p.type] = (typesCounts[p.type] || 0) + 1;
  });
  Object.keys(typesCounts).forEach((type) => {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1) + 's';
    console.log(`    ${typeLabel}: ${typesCounts[type]}`);
  });

  // Log MCP servers count if present
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    console.log(`  MCP Servers: ${Object.keys(mcpServers).length}`);
  }
  if (mcpInputs && mcpInputs.length > 0) {
    console.log(`  MCP Inputs: ${mcpInputs.length}`);
  }
} catch (error) {
  console.error('❌ Error generating deployment manifest:', error.message);
  process.exit(1);
}
