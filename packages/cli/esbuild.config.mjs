import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  absWorkingDir: __dirname
});
