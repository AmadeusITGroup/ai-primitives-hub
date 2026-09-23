import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Inline the ternlight WASM so the SEA bundle is self-contained.
 *
 * `@ternlight/mini/pkg-node/tern_engine.js` loads `tern_engine_bg.wasm` from
 * disk at module initialization. In a single-executable bundle there is no
 * stable filesystem to load from, so we replace the `readFileSync` call with a
 * base64-encoded buffer. The 7.5 MB WASM becomes ~10 MB of base64 in the
 * bundle but keeps the executable portable.
 */
const ternlightWasmPlugin = {
  name: 'ternlight-wasm-inline',
  setup(build) {
    build.onLoad({ filter: /pkg-node[\\/]tern_engine\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const wasmPath = path.join(path.dirname(args.path), 'tern_engine_bg.wasm');
      const wasmBytes = await fs.promises.readFile(wasmPath);
      const base64 = wasmBytes.toString('base64');

      const needle = `const wasmPath = \`\${__dirname}/tern_engine_bg.wasm\`;\nconst wasmBytes = require('fs').readFileSync(wasmPath);`;
      if (!source.includes(needle)) {
        throw new Error(
          `ternlight-wasm-inline: could not locate wasm loader in ${args.path}`
        );
      }

      const replacement = `const wasmBytes = Buffer.from('${base64}', 'base64');`;
      const contents = source.replace(needle, replacement);
      return { contents, loader: 'js' };
    });
  }
};

await esbuild.build({
  entryPoints: ['src/sea-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  outfile: 'dist/ai-primitives-hub-bundle.js',
  format: 'cjs',
  external: [],
  minify: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  sourcemap: false,
  treeShaking: true,
  metafile: true,
  absWorkingDir: __dirname,
  plugins: [ternlightWasmPlugin]
});
