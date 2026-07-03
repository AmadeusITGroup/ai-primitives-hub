import * as assert from 'node:assert';
import * as path from 'node:path';

suite('Webpack Configuration', () => {
  test('should bundle @elastic/elasticsearch into the extension', () => {
    const webpackConfig = require(path.join(process.cwd(), 'webpack.config.js'));

    assert.strictEqual(webpackConfig.externals['@elastic/elasticsearch'], undefined);
  });

  test('should externalize apache-arrow native bindings', () => {
    const webpackConfig = require(path.join(process.cwd(), 'webpack.config.js'));

    assert.strictEqual(
      webpackConfig.externals['apache-arrow/Arrow.node'],
      'commonjs apache-arrow/Arrow.node',
      'apache-arrow native bindings should stay external because webpack cannot bundle .node modules'
    );
  });
});
