import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Timeline } from '../core/types';
import { prepareLayers } from './layers';
import { assertSafeOutput } from '../engine/output';
import { assertNotAborted, CancelledError } from '../engine/process';

export interface PremiereExportOptions { output: string; signal?: AbortSignal; onProgress?: (progress: { fraction: number; message: string }) => void; pythonPath?: string; formatWhitelist?: string }
export interface PremiereExportResult { mediaDirectory?: string; path: string; warnings: string[]; verified: boolean; verification: 'native-roundtrip' }
async function bridgePath(): Promise<string> {
  const candidates = [path.join(typeof __dirname === 'string' ? __dirname : process.cwd(), 'premiere', 'bridge.py'), path.resolve(process.cwd(), 'resources', 'premiere', 'bridge.py')];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Try the source checkout during tests/development. */ } }
  throw new Error('The native Premiere writer is missing. Run npm run build, or reinstall the complete CUT Studio application.');
}
/** Write a genuine Premiere XML object graph, not renamed interchange XML. No Adobe app or plugin is required. */
export async function exportPremiere(timeline: Timeline, options: PremiereExportOptions): Promise<PremiereExportResult> {
  assertNotAborted(options.signal);
  if (!/\.prproj$/i.test(options.output)) throw new Error('Native Premiere export requires a .prproj output filename.');
  const output = await assertSafeOutput(timeline, options.output), bridge = await bridgePath();
  await mkdir(path.dirname(output), { recursive: true });
  const workspace = await mkdtemp(path.join(tmpdir(), 'cut-premiere-')), input = path.join(workspace, 'timeline.json');
  const temporary = path.join(path.dirname(output), `.${path.basename(output, '.prproj')}.${randomUUID()}.prproj`);
  let prepared: Awaited<ReturnType<typeof prepareLayers>> | undefined;
  let committed = false;
  try {
    prepared = await prepareLayers(timeline, output, options.signal, options.formatWhitelist);
    await writeFile(input, JSON.stringify(prepared.timeline));
    const warnings = await new Promise<string[]>((resolve, reject) => {
      const executable = options.pythonPath || process.env.CUT_PYTHON || 'python3';
      const child = spawn(executable, ['-I', bridge, input, temporary], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let pending = '', stderr = '', result: { warnings?: string[]; verified?: boolean } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 1200); timer.unref(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => { options.signal?.removeEventListener('abort', abort); if (timer) clearTimeout(timer); };
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        for (const line of lines) { try { const value = JSON.parse(line); if (value.type === 'progress') options.onProgress?.({ fraction: value.fraction, message: value.message }); else if (value.type === 'result') result = value; } catch { /* Keep diagnostics on stderr, never execute child output. */ } }
      });
      child.once('error', (error: NodeJS.ErrnoException) => { cleanup(); reject(new Error(error.code === 'ENOENT' ? `Python 3.10 or later is required for native Premiere export. Install Python 3 from python.org or brew install python, or set CUT_PYTHON to its executable path. Could not find “${executable}”.` : `Could not start the native Premiere writer: ${error.message}`)); });
      child.once('close', code => { cleanup(); if (options.signal?.aborted) reject(new CancelledError()); else if (code !== 0 || !result?.verified) reject(new Error(`Native Premiere export failed: ${stderr.trim() || 'The writer did not validate the project.'}`)); else resolve(result.warnings || []); });
    });
    assertNotAborted(options.signal);
    const bytes = await readFile(temporary); if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Native Premiere writer did not produce a gzip-compressed Premiere project.');
    await assertSafeOutput(timeline, output);
    await rename(temporary, output);
    committed = true;
    options.onProgress?.({ fraction: 1, message: 'Native Premiere project exported' });
    return { path: output, mediaDirectory:prepared.directory, warnings:[...warnings,...prepared.warnings], verified: true, verification: 'native-roundtrip' };
  } finally { if (!committed && prepared?.directory) await rm(prepared.directory,{recursive:true,force:true}); await rm(temporary, { force: true }); await rm(temporary + '.tmp', { force: true }); await rm(workspace, { recursive: true, force: true }); }
}
