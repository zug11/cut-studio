import { build } from 'esbuild';
import {
  copyFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'CUT-Studio-standalone.tar.gz');
const stage = await mkdtemp(path.join(tmpdir(), 'cut-studio-package-'));
const packageRoot = path.join(stage, 'CUT-Studio');
const temporary = path.join(root, 'dist', `.CUT-Studio-standalone.${randomUUID()}.partial`);

async function copy(source, destination) {
  const target = path.join(packageRoot, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
  if (/\.(?:[cm]?js)$/.test(target)) {
    const content = await readFile(target, 'utf8');
    await writeFile(target, content.replace(/^\/\/[#@] sourceMappingURL=.*\r?\n?/gm, ''), 'utf8');
  }
}

async function bundledNotices() {
  // Use the actual module graph rather than including unrelated development dependencies.
  const results = await Promise.all([
    build({
      absWorkingDir: root,
      entryPoints: ['src/standalone/app.ts'],
      bundle: true,
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent'
    }),
    build({
      absWorkingDir: root,
      entryPoints: ['src/standalone/server.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      write: false,
      metafile: true,
      logLevel: 'silent'
    }),
    build({
      absWorkingDir: root,
      entryPoints: ['src/cli/main.ts', 'src/mcp/server.ts'],
      outdir: 'runtime',
      bundle: true,
      platform: 'node',
      target: 'node22',
      write: false,
      metafile: true,
      logLevel: 'silent'
    })
  ]);
  const packages = new Map();
  for (const result of results)
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.includes('node_modules/')) continue;
      let directory = path.dirname(path.resolve(root, input));
      while (directory !== path.dirname(directory)) {
        try {
          const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
          if (info.name && info.version) {
            packages.set(`${info.name}@${info.version}`, { info, directory });
            break;
          }
        } catch {
          /* A source directory is not necessarily a package root. */
        }
        directory = path.dirname(directory);
      }
    }
  const sections = [
    'CUT STUDIO — THIRD-PARTY BUNDLED SOFTWARE NOTICES',
    'The following packages are bundled into the editor and local tools. Their license and copyright notices follow in full.',
    'Node.js, FFmpeg and FFprobe are not included. Install those tools separately; their own distribution licenses apply.'
  ];
  for (const [name, { info, directory }] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const candidates = (await readdir(directory)).filter((name) =>
      /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(name)
    );
    if (!candidates.length && info.name === '@resvg/resvg-wasm') {
      sections.push(name, 'MPL-2.0', 'https://github.com/thx/resvg-js/tree/v2.6.2', await readFile(path.join(root,'resources/graphics/LICENSE-resvg.txt'),'utf8'));
      continue;
    }
    if (!candidates.length) throw new Error(`No license notice found for bundled package ${name}`);
    const licenses = [];
    for (const candidate of candidates.sort()) {
      const file = path.join(directory, candidate);
      if ((await stat(file)).isFile()) licenses.push(await readFile(file, 'utf8'));
    }
    if (!licenses.length) throw new Error(`No readable license notice found for bundled package ${name}`);
    const repository = typeof info.repository === 'string' ? info.repository : info.repository?.url;
    sections.push(
      '='.repeat(72),
      name,
      `License: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license)}`,
      repository || info.homepage || '',
      ...licenses
    );
  }
  return sections.join('\n\n') + '\n';
}

try {
  await mkdir(path.join(packageRoot, 'runtime', 'web'), { recursive: true });
  for (const file of ['server.cjs', 'cli.cjs', 'mcp.mjs']) await copy(`dist/${file}`, `runtime/${file}`);
  for (const file of ['index.html', 'app.js', 'app.css', 'studio.js', 'studio.css', 'panel-bridge.js'])
    await copy(`dist/web/${file}`, `runtime/web/${file}`);
  // Only ship the small generated sample. Never regenerate or modify project documents.
  for (const file of ['signal.cut', 'direct.cut', 'layers.cut', 'light-study.cut', 'light-study-alternate.cut', 'scenes/opening.cut']) if (existsSync(path.join(root, 'examples', file))) await copy(`examples/${file}`, `examples/${file}`);
  for (const file of ['dawn.mp4', 'current.mp4', 'light.mp4', 'tone-low.wav', 'tone-high.wav', 'light-cue.wav', 'light-cue.srt'])
    await copy(`examples/media/${file}`, `examples/media/${file}`);
  await copy('LICENSE', 'LICENSE');
  for (const folder of ['speech','graphics','resolve']) await cp(path.join(root,'dist',folder),path.join(packageRoot,'runtime',folder),{recursive:true});
  await chmod(path.join(packageRoot,'runtime/speech/whisper-cli-mac-arm64'),0o755);
  if (existsSync(path.join(root, 'dist', 'premiere'))) await cp(path.join(root, 'dist', 'premiere'), path.join(packageRoot, 'runtime', 'premiere'), { recursive: true });
  await copy('Launch CUT Studio.command', 'Launch CUT Studio.command');
  await chmod(path.join(packageRoot, 'Launch CUT Studio.command'), 0o755);
  await chmod(path.join(packageRoot, 'runtime', 'cli.cjs'), 0o755);
  let notices = await bundledNotices();
  for (const name of ['NOTICE.txt', 'LICENSE-pr2resolve.txt']) notices += '\n' + await readFile(path.join(root, 'dist', 'resolve', name), 'utf8');
  for (const file of ['NOTICE.txt', 'LICENSE-py-premiere.txt']) {
    const source = path.join(root, 'dist', 'premiere', file);
    if (existsSync(source)) notices += '\n' + '='.repeat(72) + '\nPREMIERE PROJECT WRITER\n\n' + await readFile(source, 'utf8');
  }
  await writeFile(path.join(packageRoot, 'THIRD-PARTY-NOTICES.txt'), notices, 'utf8');
  await writeFile(
    path.join(packageRoot, 'START-HERE.txt'),
    `CUT STUDIO — THE CODE IS THE MOVIE

REQUIREMENTS
Install Node.js 22 or later and FFmpeg with FFprobe. Use your existing browser.
Node.js: https://nodejs.org/
FFmpeg: https://ffmpeg.org/download.html
Full FFmpeg builds should provide libx264, aac, libmp3lame, libvpx and libopus.
No npm packages, VS Code, accounts or downloads are required by this archive.

OPEN THE EDITOR
macOS: Double-click “Launch CUT Studio.command”. Keep the Terminal window open.
Linux/Windows: Open a terminal in this extracted CUT-Studio folder and run:
  node runtime/server.cjs
The sample project opens in your default browser. A local address is also printed.
Stop the local editor by pressing Ctrl+C in its terminal.

OPEN YOUR OWN PROJECT
From this folder, run:
  node runtime/server.cjs "/absolute/path/to/my-film-project"
Keep your .cut document and media inside that project folder. The browser editor
reads and saves files within the selected project. A folder's own media and CUT
documents are never changed merely by opening it. The launcher accepts the same
project path argument. Use --no-open to print the address without opening a tab.

FIRST EDIT
Open signal.cut in the explorer. Wait for CURRENT, then press Play.
Change a clip's “at” time in code to move it on the timeline. Click a timeline
clip to jump to its source, or click the ruler to seek. Save with Cmd+S/Ctrl+S.
Use the toolbar to render an MP4. MP4 export runs locally with H.264 and AAC.
When the monitor is focused: Space plays/pauses, Left/Right step a frame,
and Home returns to the start. Resize the panels by dragging their dividers.
Your code is authoritative; the timeline is its visualization.

COMMAND LINE
  node runtime/cli.cjs check examples/signal.cut
  node runtime/cli.cjs timeline examples/signal.cut
  node runtime/cli.cjs preview examples/signal.cut
  node runtime/cli.cjs render examples/signal.cut --output movie.mp4
  node runtime/cli.cjs render examples/signal.cut --from 2s --to 6s --output section.mp4

CONNECT AN AI ASSISTANT
In a local MCP client, choose a stdio server. Set the command to the absolute
path of Node.js and supply three arguments: the absolute path to runtime/mcp.mjs,
--project, and the absolute path to your film project folder. The client starts
the server. It can inspect and edit CUT films and export a new Premiere file or
movie. Use one connection per project.

LOCAL FILES AND LIMITS
All media processing happens on your computer. The local server listens only
on 127.0.0.1. Preview cache files are written to the project’s .cut-cache folder;
you may delete that folder while playback and rendering are stopped.
The generated sample media contains no third-party footage.
This version supports cuts, layers, opacity, audio mixing, gain and audio fades.
No transitions, grading, keyframes or live drag-and-drop timeline editing.

This package contains the ready-to-run local editor and CLI, browser assets,
sample CUT documents, five small sample media files and license notices.
It does not contain Node.js, FFmpeg, VS Code, npm dependencies or test state.
See LICENSE and THIRD-PARTY-NOTICES.txt for the included software licenses.
`,
    'utf8'
  );
  const archive = spawnSync('tar', ['-czf', temporary, '-C', stage, 'CUT-Studio'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'pipe',
    shell: false
  });
  if (archive.error) throw archive.error;
  if (archive.status !== 0)
    throw new Error(`Could not create standalone archive: ${archive.stderr.toString().trim()}`);
  await rename(temporary, output);
  const bytes = (await stat(output)).size;
  process.stdout.write(
    `Created ${output}\n${(bytes / (1024 * 1024)).toFixed(2)} MB compressed; ready to extract and run with Node.js + FFmpeg.\n`
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(temporary, { force: true });
}
