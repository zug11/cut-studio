import { build, context } from 'esbuild';
import { chmod, copyFile, cp, mkdir } from 'node:fs/promises';
import { watchFile } from 'node:fs';

const watching = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true };
const nodeBundle = { ...common, platform: 'node', target: 'node20', format: 'cjs' };
const bundles = [
  {
    ...nodeBundle,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.cjs',
    external: ['vscode']
  },
  {
    ...nodeBundle,
    entryPoints: ['src/cli/main.ts'],
    outfile: 'dist/cli.cjs',
    banner: { js: '#!/usr/bin/env node' }
  },
  {
    ...nodeBundle, target: 'node22', format: 'esm', minify: true,
    entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp.mjs',
    banner: { js: `import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));` }
  },
  { ...nodeBundle, entryPoints: ['src/standalone/server.ts'], outfile: 'dist/server.cjs' },
  {
    ...common,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    entryPoints: ['src/standalone/app.ts'],
    outfile: 'dist/web/app.js'
  }
];
const assets = [
  ['node_modules/@resvg/resvg-wasm/index_bg.wasm','graphics/resvg.wasm'],
  ['resources/graphics/LICENSE-resvg.txt','graphics/LICENSE-resvg.txt'],
  ...['whisper-cli-mac-arm64','LICENSE-whisper.cpp','LICENSE-Whisper-model','NOTICE.txt'].map(name => ['resources/speech/'+name, 'speech/'+name]),
  ['src/standalone/index.html', 'web/index.html'],
  ['src/standalone/app.css', 'web/app.css'],
  ['src/standalone/panel-bridge.js', 'web/panel-bridge.js'],
  ['media/studio.js', 'web/studio.js'],
  ['media/studio.css', 'web/studio.css'],
  ...['bridge.py', 'py-premiere.zip', 'NOTICE.txt', 'LICENSE-py-premiere.txt'].map((name) => [
    'resources/premiere/' + name,
    'premiere/' + name
  ])
];

await Promise.all(['dist/web', 'dist/premiere','dist/graphics','dist/speech'].map((dir) => mkdir(dir, { recursive: true })));
await cp('resources/resolve', 'dist/resolve', { recursive: true });
await Promise.all(
  bundles.map(async (options) => {
    if (watching) {
      const ctx = await context(options);
      await ctx.watch();
    } else {
      await build(options);
    }
  })
);
if (!watching) await chmod('dist/cli.cjs', 0o755);
for (const [source, name] of assets) {
  const destination = 'dist/' + name;
  await copyFile(source, destination);
  if (watching) {
    watchFile(source, { interval: 250 }, () => {
      copyFile(source, destination).catch((error) => console.error(error.message));
    });
  }
}
