import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.vscode-test', 'studio-data');
await mkdir(path.join(profile, 'User'), { recursive: true });
// This is a dedicated development profile; never change an installed editor's preferences.
await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  'chat.disableAIFeatures': true, 'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'editor.minimap.enabled': false
}, null, 2), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
const executable = process.env.CUT_VSCODE || await downloadAndUnzipVSCode('stable');
const child = spawn(executable, [
  `--extensionDevelopmentPath=${root}`,
  '--user-data-dir', profile,
  '--extensions-dir', path.join(root, '.vscode-test', 'studio-extensions'),
  '--skip-welcome', '--skip-release-notes', '--new-window',
  path.join(root, 'examples'), path.join(root, 'examples', 'signal.cut')
], { detached: true, stdio: 'ignore', shell: false });
child.on('error', error => { console.error(`Could not open VS Code: ${error.message}`); process.exitCode = 1; });
child.unref();
console.log('Opened CUT Studio in a dedicated VS Code window. Trust the sample folder when VS Code asks, then use CUT: Open Video Monitor.');
