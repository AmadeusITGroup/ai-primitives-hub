import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";

const config = {
  input: "src/index.js",
  output: {
    esModule: true,
    file: "dist/index.js",
    format: "es",
    // Shared CommonJS validators resolve schema paths from their module directory.
    banner: 'import { fileURLToPath as bundleFileURLToPath } from "node:url";\nimport { dirname as bundleDirname } from "node:path";\nconst __dirname = bundleDirname(bundleFileURLToPath(import.meta.url));',
    sourcemap: true,
  },
  plugins: [json(), commonjs(), nodeResolve({ preferBuiltins: true }), terser()],
};

export default config;
