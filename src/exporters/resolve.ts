import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Timeline } from '../core/types';
import { arrangeLayers } from '../core/layers';
import { atomicCopyOutput, assertSafeOutput } from '../engine/output';
import { prepareLayers } from './layers';

export async function exportResolve(timeline: Timeline, options: {
  output: string; signal?: AbortSignal; formatWhitelist?: string;
}) {
  const { output, signal } = options;
  if (path.extname(output).toLowerCase() !== '.drp') throw new Error('Choose a .drp output file.');
  signal?.throwIfAborted();
  await assertSafeOutput(timeline, output);
  const installed = path.join(__dirname, 'resolve', 'bridge.py');
  const sourceBridge = path.resolve(__dirname, '../../resources/resolve/bridge.py');
  const bridge = existsSync(installed) ? installed : sourceBridge;
  if (!existsSync(bridge)) throw new Error('The Resolve writer is missing from this CUT installation.');
  await mkdir(path.dirname(output), { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), 'cut-resolve-'));
  let prepared: Awaited<ReturnType<typeof prepareLayers>> | undefined;
  let published = false;
  try {
    prepared = await prepareLayers(timeline, output, signal, options.formatWhitelist, 'resolve');
    const manifest = path.join(work, 'timeline.json');
    const project = path.join(work, 'project.drp');
    await writeFile(manifest, JSON.stringify({ ...prepared.timeline, tracks: arrangeLayers(prepared.timeline.tracks) }));
    const { stdout } = await promisify(execFile)(process.env.CUT_PYTHON || 'python3',
      ['-I', '-B', bridge, manifest, project], { signal, maxBuffer: 1024 * 1024 });
    signal?.throwIfAborted();
    await atomicCopyOutput(timeline, project, output);
    published = true;
    const warnings = stdout.split(/\r?\n/).filter(line => /^\s*Warning:/i.test(line)).map(line => line.trim());
    return { path: output, mediaDirectory: prepared.directory, warnings: [...prepared.warnings, ...warnings] };
  } finally {
    if (!published && prepared?.directory) await rm(prepared.directory, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}
