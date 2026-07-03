import * as assert from 'node:assert';
import * as path from 'node:path';

suite('Webpack Configuration', () => {
  test('should externalize @elastic/elasticsearch as a runtime dependency', () => {
    const webpackConfig = require(path.join(process.cwd(), 'webpack.config.js'));

    assert.strictEqual(
      webpackConfig.externals['@elastic/elasticsearch'],
      'commonjs @elastic/elasticsearch',
      '@elastic/elasticsearch should be externalized so webpack does not bundle its optional native dependencies'
    );
  });
});