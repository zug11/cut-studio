import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'cut-mac-build-'));
const bundle = path.join(root, 'dist', 'CUT Studio.app');
const stage = path.join(temp, 'CUT Studio.app');
const contents = path.join(stage, 'Contents');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
}
try {
  if (process.platform !== 'darwin') throw new Error('Build the native Mac app on macOS with Apple Command Line Tools installed.');
  run(process.execPath, ['scripts/package-standalone.mjs']);
  run('tar', ['-xzf', path.join(root, 'dist', 'CUT-Studio-standalone.tar.gz'), '-C', temp]);
  const payload = path.join(temp, 'CUT-Studio');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'), { recursive: true });
  for (const item of ['runtime', 'examples', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) await cp(path.join(payload, item), path.join(contents, 'Resources', item), { recursive: true });
  await cp(path.join(root, 'macos', 'native-host.cjs'), path.join(contents, 'Resources', 'runtime', 'native-host.cjs'));
  const mcpLauncher = path.join(contents, 'Resources', 'runtime', 'cut-mcp');
  await cp(path.join(root, 'macos', 'cut-mcp'), mcpLauncher);
  await chmod(mcpLauncher, 0o755);
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`;
  run('xcrun', ['swiftc', '-swift-version', '5', '-O', '-whole-module-optimization', '-target', target, '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers', 'macos/App.swift', 'macos/Runtime.swift', 'macos/AssistantConnection.swift', '-o', path.join(contents, 'MacOS', 'CUTStudio')]);
  run('xcrun', ['swiftc', '-swift-version', '5', '-O', 'macos/Icon.swift', '-o', path.join(temp, 'draw-icon')]);
  run(path.join(temp, 'draw-icon'), [path.join(temp, 'AppIcon.iconset')]);
  run('/usr/bin/iconutil', ['-c', 'icns', path.join(temp, 'AppIcon.iconset'), '-o', path.join(contents, 'Resources', 'AppIcon.icns')]);
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CUTStudio</string>
<key>CFBundleIdentifier</key><string>studio.cut.app</string>
<key>CFBundleName</key><string>CUT Studio</string>
<key>CFBundleDisplayName</key><string>CUT Studio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.video</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Copyright © 2026 CUT Studio contributors</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CFBundleDocumentTypes</key><array>
<dict><key>CFBundleTypeName</key><string>CUT Film</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array><string>studio.cut.source</string></array><key>CFBundleTypeExtensions</key><array><string>cut</string></array></dict>
<dict><key>CFBundleTypeName</key><string>CUT Project Folder</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array><string>public.folder</string></array></dict>
</array>
<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>studio.cut.source</string><key>UTTypeDescription</key><string>CUT Film Source</string><key>UTTypeConformsTo</key><array><string>public.plain-text</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>cut</string></array><key>public.mime-type</key><string>text/x-cut</string></dict></dict></array>
</dict></plist>`, 'utf8');
  run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
  run('/usr/bin/xattr', ['-cr', stage]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', stage]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', stage]);
  const zip = path.join(root, 'dist', 'CUT-Studio-Mac.zip');
  await rm(zip, { force: true });
  // Archive clean staging before a synced Documents folder can attach Finder metadata.
  run('/usr/bin/ditto', ['--noextattr', '--norsrc', '-c', '-k', '--keepParent', stage, zip]);
  const verification = path.join(temp, 'verify');
  await mkdir(verification, { recursive: true });
  run('/usr/bin/ditto', ['--noextattr', '--norsrc', '-x', '-k', zip, verification]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(verification, 'CUT Studio.app')]);
  await rm(bundle, { recursive: true, force: true });
  await rename(stage, bundle);
  process.stdout.write(`Native Mac app ready: ${bundle}\nArchive: ${path.join(root, 'dist', 'CUT-Studio-Mac.zip')}\nArchitecture: ${process.arch}; macOS 14+; locally ad-hoc signed.\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
finally { await rm(temp, { recursive: true, force: true }); }
