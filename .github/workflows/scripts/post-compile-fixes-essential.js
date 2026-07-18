#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

console.log('Applying essential post-compilation fixes...');

// Fix test runner path - this is essential for tests to work
const runTestsPath = path.join('test', 'runExtensionTests.js');
if (fs.existsSync(runTestsPath)) {
    console.log('Fixing test runner path...');
    let content = fs.readFileSync(runTestsPath, 'utf8');
    content = content.replace(/test-dist\/src\/test\/index\.js/g, 'test-dist/test/index.js');
    fs.writeFileSync(runTestsPath, content);
}

// Ensure test-dist/test directory exists
const testDir = path.join('test-dist', 'test');
fs.mkdirSync(testDir, { recursive: true });

// Create basic test index.js if it doesn't exist
const indexPath = path.join(testDir, 'index.js');
if (!fs.existsSync(indexPath)) {
    console.log('Creating basic test index.js...');
    const indexContent = `const path = require('path');
const { glob } = require('glob');

exports.run = function() {
  // Create the mocha test
  const Mocha = require('mocha');
  const mocha = new Mocha({
    ui: 'bdd',
    color: true
  });

  const testsRoot = path.resolve(__dirname, '.');

  return (async () => {
    return new Promise((c, e) => {
      (async () => {
        try {
          const files = await glob('**/**.test.js', { cwd: testsRoot });
          
          // Add files to the test suite
          files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

          // Run the mocha test
          mocha.run((failures) => {
            if (failures > 0) {
              e(new Error(\`\${failures} tests failed.\`));
            } else {
              c();
            }
          });
        } catch (err) {
          console.error(err);
          e(err);
        }
      })();
    });
  })();
}`;
    fs.writeFileSync(indexPath, indexContent);
} else {
    console.log('Test index.js already exists');
}

console.log('Essential post-compilation fixes completed!');
