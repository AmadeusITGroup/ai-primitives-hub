const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // Native .node modules cannot be webpacked; keep them as require() at runtime
    'apache-arrow/Arrow.node': 'commonjs apache-arrow/Arrow.node'
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    conditionNames: ['import', 'require', 'node', 'default']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/, /\.test\.ts$/, /src\/test\//],
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  optimization: {
    // Webpack's unused-export elision rewrites `module.exports.x = <expr>` into bare
    // expression statements without a terminating semicolon. When a dependency has an
    // export assignment whose value starts with `(`, the next line is parsed as a call
    // instead of a new statement (ASI hazard). This corrupts undici's index.js in
    // `--mode production`, turning its exports into `ping(WebSocketStream, undefined)(...)`,
    // which throws "Cannot read private member #handler" while `dist/extension.js` is
    // being required — so `activate()` never runs and no command is registered.
    // Disabling usedExports keeps the assignments intact. Cost is ~50 KB of bundle size.
    usedExports: false
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};

module.exports = config;
