import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'tests/vscode/suite.cjs'),
  launchArgs: [path.join(root, 'examples'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions'],
});
