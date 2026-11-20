import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { parseTime } from '../src/core/time';

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
const run = (executable: string, args: string[]): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

describe('actual CUT project CLI', () => {
  let directory: string, cli: string, film: string, malformed: string, missing: string;
  const call = (...args: string[]) => run(process.execPath, [cli, ...args]);
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'CUT CLI test with spaces '));
    cli = path.join(directory, 'cut CLI.cjs');
    await build({
      entryPoints: ['src/cli/main.ts'],
      outfile: cli,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      logLevel: 'silent'
    });
    const media = path.join(directory, 'video $x; [test] with spaces.mp4');
    const footage = await run(process.env.CUT_FFMPEG || 'ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=24:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      media
    ]);
    if (footage.code !== 0) throw new Error(`CLI test media generation failed: ${footage.stderr}`);
    film = path.join(directory, 'My film [draft].cut');
    const source = `film "CLI integration" {
  resolution 160x90
  fps 24
  track video "Main" {
    clip "video $x; [test] with spaces.mp4" from 0.25s to 2.25s at 0s
  }
  track audio "Score" {
    clip "video $x; [test] with spaces.mp4" { in 0.25s out 2.25s at 0s gain -6dB }
  }
}`;
    await writeFile(film, source);
    malformed = path.join(directory, 'malformed.cut');
    await writeFile(malformed, source.replace('to 2.25s', 'to bananas'));
    missing = path.join(directory, 'missing asset.cut');
    await writeFile(missing, source.replaceAll('video $x; [test] with spaces.mp4', 'missing footage.mp4'));
  }, 60_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('checks the real media and prints a resolved machine-readable timeline', async () => {
    const check = await call('check', film, '--json');
    expect(check.code, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ valid: true, diagnostics: [] });
    const summary = await call('timeline', film);
    expect(summary.code, summary.stderr).toBe(0);
    expect(summary.stdout).toContain('CLI integration');
    expect(summary.stdout).toContain('gain -6dB');
    const timeline = await call('timeline', film, '--json');
    expect(timeline.code, timeline.stderr).toBe(0);
    const result = JSON.parse(timeline.stdout);
    expect(result.timeline.duration).toBe(parseTime('2s'));
    expect(result.timeline.tracks).toHaveLength(2);
    expect(result.timeline.tracks[0].clips[0]).toMatchObject({
      in: parseTime('0.25s'),
      out: parseTime('2.25s'),
      at: 0,
      duration: parseTime('2s')
    });
  });
  it('lists explicit layer numbers and empty gaps through the actual CLI', async () => {
    const layered = path.join(directory, 'layered.cut');
    const source = (await readFile(film, 'utf8')).replace('track video "Main" {', 'track video "Main" layer 3 {').replace('track audio "Score" {', 'track audio "Score" layer 2 {');
    await writeFile(layered, source);
    const result = await call('timeline', layered);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/V1\s+Empty layer.*empty/);
    expect(result.stdout).toMatch(/V2\s+Empty layer.*empty/);
    expect(result.stdout).toMatch(/V3\s+Main/);
    expect(result.stdout).toMatch(/A2\s+Score/);
    expect(result.stdout).toContain('[V3]');
    const json = await call('timeline', layered, '--json');
    expect(JSON.parse(json.stdout).timeline.tracks.map((track: { kind: string; layer: number }) => [track.kind, track.layer])).toEqual([['video', 1], ['video', 2], ['video', 3], ['audio', 1], ['audio', 2]]);
  });

  it('renders the selected range to an actual H.264/AAC MP4', async () => {
    const output = path.join(directory, 'selected output $x;.mp4');
    const result = await call('render', film, '--from', '0.5s', '--to', '1.25s', '--output', output);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
    expect(result.stderr).toMatch(/Rendering \d+%/);
    const probe = await run(process.env.CUT_FFPROBE || 'ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      output
    ]);
    expect(probe.code, probe.stderr).toBe(0);
    const metadata = JSON.parse(probe.stdout);
    expect(Number(metadata.format.duration)).toBeCloseTo(0.75, 2);
    expect(
      metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')
    ).toMatchObject({ codec_name: 'h264', width: 160, height: 90, r_frame_rate: '24/1', nb_frames: '18' });
    expect(
      metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio')
    ).toMatchObject({ codec_name: 'aac', sample_rate: '48000' });
  }, 60_000);

  it('creates and reuses a content-addressed preview', async () => {
    const first = await call('preview', film, '--from', '0s', '--to', '1s');
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('Rendered preview');
    const previewPath = first.stdout.trim().split('): ')[1];
    expect(previewPath).toBeTruthy();
    expect((await stat(previewPath)).size).toBeGreaterThan(1000);
    const firstTime = (await stat(previewPath)).mtimeMs;
    const second = await call('preview', film, '--from', '0s', '--to', '1s');
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('Cached preview');
    expect(second.stdout.trim().split('): ')[1]).toBe(previewPath);
    expect((await stat(previewPath)).mtimeMs).toBe(firstTime);
  }, 60_000);

  it('exports an editable FCP 7 XML sequence', async () => {
    const output = path.join(directory, 'Premiere sequence.xml');
    const result = await call('export', film, '--output', output);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Exported editable sequence');
    const xml = await readFile(output, 'utf8');
    expect(xml).toContain('<xmeml');
    expect(xml).toContain('CLI integration');
    expect(xml).toContain('<clipitem');
    expect(xml).toContain('file://');
  });

  it('exports a genuine native Premiere project through the project CLI', async () => {
    const output = path.join(directory, 'Native sequence.prproj');
    const result = await call('export', film, '--output', output);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Exported native Premiere project');
    const xml = gunzipSync(await readFile(output)).toString('utf8');
    expect(xml).toContain('<PremiereData'); expect(xml).toContain('CLI integration'); expect(xml).not.toContain('<xmeml');
  });

  it('protects CUT source and media from render, preview-copy and XML outputs through symbolic and hard links', async () => {
    const media = path.join(directory, 'video $x; [test] with spaces.mp4');
    const protectedFiles = [film, media],
      originals = await Promise.all(protectedFiles.map((file) => readFile(file)));
    for (const command of ['preview', 'render', 'export'])
      for (const kind of ['symbolic', 'hard'])
        for (let index = 0; index < protectedFiles.length; index++) {
          const output = path.join(
            directory,
            `${command}-${kind}-${index}.${command === 'export' ? 'xml' : 'mp4'}`
          );
          if (kind === 'symbolic') await symlink(protectedFiles[index], output);
          else await link(protectedFiles[index], output);
          const result = await call(command, film, '--output', output);
          expect(result.code, `${command}/${kind}: ${result.stderr}`).toBe(1);
          expect(result.stderr).toMatch(/must not overwrite.*CUT document|must not overwrite.*source asset/);
          expect(await readFile(protectedFiles[index])).toEqual(originals[index]);
        }
  }, 60000);

  it('copies preview output atomically to an ordinary existing destination', async () => {
    const output = path.join(directory, 'copied-preview.mp4');
    await writeFile(output, 'old export');
    const result = await call('preview', film, '--from', '0s', '--to', '1s', '--output', output);
    expect(result.code, result.stderr).toBe(0);
    const probe = await run(process.env.CUT_FFPROBE || 'ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-of',
      'json',
      output
    ]);
    expect(probe.code, probe.stderr).toBe(0);
    expect(
      JSON.parse(probe.stdout).streams.some((stream: { codec_name: string }) => stream.codec_name === 'h264')
    ).toBe(true);
  });

  it('returns source-located syntax and media diagnostics with exit status 1', async () => {
    const badTime = await call('check', malformed);
    expect(badTime.code).toBe(1);
    expect(badTime.stderr).toMatch(/malformed\.cut:\d+:\d+: error \[invalid-time\]/);
    expect(badTime.stderr).toContain('bananas');
    const missingMedia = await call('check', missing, '--json');
    expect(missingMedia.code).toBe(1);
    const result = JSON.parse(missingMedia.stdout);
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (diagnostic: { severity: string; message: string }) =>
          diagnostic.severity === 'error' && /missing|not found|does not exist/i.test(diagnostic.message)
      )
    ).toBe(true);
  });

  it('fails helpfully when local tools are unavailable', async () => {
    const result = await call('render', film, '--ffmpeg', path.join(directory, 'not an ffmpeg executable'));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ffmpeg/i);
    expect(result.stderr).toMatch(/install|available|found/i);
  });

  it.each([
    ['render', '--unknown'],
    ['render', '--output'],
    ['render', '--from', '0s', '--from', '1s'],
    ['render', '--json']
  ])('rejects invalid CLI options %j', async (command, ...options) => {
    const result = await call(command, film, ...options);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown option|requires a value|more than once|available for/);
  });
  it('has runnable help/version and useful missing input/unknown command errors', async () => {
    expect((await call('--help')).stdout).toContain('cut render film.cut');
    expect((await call('--version')).stdout.trim()).toBe('0.1.0');
    expect((await call('check')).stderr).toContain('requires a .cut file');
    expect((await call('dance', film)).stderr).toContain('Unknown command');
  });
});
