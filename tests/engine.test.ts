import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/core/compiler';
import { secondsToTicks, ticksToSeconds } from '../src/core/time';
import type { Timeline } from '../src/core/types';
import {
  buildRenderPlan,
  checkTools,
  configureTools,
  findDirectPreview,
  probeMedia,
  render,
  renderPreview,
  runTool
} from '../src/engine';

let directory: string, timeline: Timeline, movie: string;
const source = `film "Engine acceptance" {
  resolution 320x180
  fps 24
  track video "Main" {
    clip "red.mp4" from 0s to 1s at 0s
    clip "blue.mp4" from 0s to 1s at 1.5s
    clip "blue.mp4" from 0s to 0.5s at 3.5s
  }
  track video "Overlay" { clip "green.mp4" { in 0s out 1.5s at 0.5s opacity 0.5 } }
  track audio "Tone 440" { clip "440.wav" { in 0.25s out 2.25s at 0s gain -6dB fade_in 0.25s fade_out 0.25s } }
  track audio "Tone 880" { clip "880.wav" { in 1s out 3s at 1s gain -12dB } }
}`;
function ffmpeg(args: string[]): Buffer {
  return execFileSync(
    process.env.CUT_FFMPEG || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
    { maxBuffer: 64 * 1024 * 1024 }
  );
}
function colors(file: string): Buffer {
  return ffmpeg(['-i', file, '-vf', 'scale=4:4', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
}
function pixel(buffer: Buffer, frame: number): number[] {
  return [...buffer.subarray(frame * 4 * 4 * 3 + 15, frame * 4 * 4 * 3 + 18)];
}
function nearColor(actual: number[], expected: number[]): void {
  for (let index = 0; index < 3; index++) expect(Math.abs(actual[index] - expected[index])).toBeLessThan(20);
}
function audio(file: string): Float32Array {
  const raw = ffmpeg(['-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
function amplitude(samples: Float32Array, from: number, length: number, frequency: number): number {
  let sin = 0,
    cos = 0;
  const count = Math.round(length * 48000),
    start = Math.round(from * 48000);
  for (let index = 0; index < count; index++) {
    const phase = (2 * Math.PI * frequency * index) / 48000,
      sample = samples[(start + index) * 2] || 0;
    sin += sample * Math.sin(phase);
    cos += sample * Math.cos(phase);
  }
  return (2 * Math.hypot(sin, cos)) / count;
}
beforeAll(async () => {
  await checkTools();
  directory = await mkdtemp(join(tmpdir(), 'cut-engine-'));
  for (const [name, color] of [
    ['red', 'red'],
    ['green', 'lime'],
    ['blue', 'blue']
  ])
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=320x180:r=24:d=3`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-y',
      join(directory, `${name}.mp4`)
    ]);
  for (const frequency of [440, 880])
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:sample_rate=48000:duration=4`,
      '-af',
      'pan=stereo|c0=c0|c1=c0',
      '-c:a',
      'pcm_s16le',
      '-y',
      join(directory, `${frequency}.wav`)
    ]);
  const result = await compile(source, join(directory, 'film.cut'));
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  timeline = result.timeline!;
  movie = join(directory, 'movie.mp4');
  await render(timeline, { output: movie });
}, 60000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('local FFmpeg acceptance', () => {
  it('renders explicit numbered layers correctly when source declarations are reversed', async () => {
    const source = `film "Numbered" { resolution 320x180 fps 24
      track video "Top" layer 3 { clip "blue.mp4" { in 0s out 1s at 0s opacity 0.5 } }
      track audio "High" layer 3 { clip "880.wav" { in 0s out 1s at 0s gain -12dB } }
      track video "Bottom" layer 1 { clip "red.mp4" from 0s to 1s at 0s }
      track audio "Low" layer 1 { clip "440.wav" { in 0s out 1s at 0s gain -6dB } }
    }`;
    const result = await compile(source, join(directory, 'numbered.cut'));
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(result.timeline!.tracks.map(track => [track.kind, track.layer])).toEqual([['video', 1], ['video', 2], ['video', 3], ['audio', 1], ['audio', 2], ['audio', 3]]);
    const output = join(directory, 'numbered.mp4');
    await render(result.timeline!, { output });
    nearColor(pixel(colors(output), 12), [127, 0, 127]);
    const samples = audio(output);
    expect(amplitude(samples, 0.3, 0.1, 440)).toBeCloseTo(0.125 * 10 ** (-6 / 20), 2);
    expect(amplitude(samples, 0.3, 0.1, 880)).toBeCloseTo(0.125 * 10 ** (-12 / 20), 2);
    const reordered = await compile(source.replace('layer 3', 'layer 2'), join(directory, 'numbered.cut'));
    expect(reordered.timeline!.hash).not.toBe(result.timeline!.hash);
  });
  it('renders individual clip overrides and rejects overlaps across declarations sharing a layer', async () => {
    const result = await compile(`film "Overrides" { resolution 320x180 fps 24 track video "Sources" {
      clip "blue.mp4" from 0s to 1s at 0s layer 3
      clip "red.mp4" from 0s to 1s at 0s layer 1
    } }`, join(directory, 'overrides.cut'));
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const output = join(directory, 'overrides.mp4'); await render(result.timeline!, { output });
    nearColor(pixel(colors(output), 12), [0, 0, 255]);
    const invalid = await compile(`film "Overlap" { resolution 320x180 track video "A" layer 3 { clip "blue.mp4" from 0s to 1s at 0s } track video "B" layer 3 { clip "red.mp4" from 0s to 1s at 0s } }`, join(directory, 'overlap.cut'));
    expect(invalid.timeline).toBeUndefined();
    expect(invalid.diagnostics.some(d => d.code === 'TRACK_OVERLAP' && d.message.includes('V3'))).toBe(true);
  });
  it('renders exact frame placements, transparent gaps, layering, opacity and black empty output', async () => {
    expect(ticksToSeconds(timeline.duration)).toBe(4);
    const info = await probeMedia(movie);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(ticksToSeconds(info.duration)).toBeCloseTo(4, 2);
    const frames = colors(movie);
    expect(frames.length / 48).toBe(96);
    nearColor(pixel(frames, 11), [255, 0, 0]);
    nearColor(pixel(frames, 12), [127, 127, 0]);
    nearColor(pixel(frames, 24), [0, 127, 0]);
    nearColor(pixel(frames, 36), [0, 127, 127]);
    nearColor(pixel(frames, 48), [0, 0, 255]);
    nearColor(pixel(frames, 60), [0, 0, 0]);
    nearColor(pixel(frames, 84), [0, 0, 255]);
  });
  it('mixes independent audio with correct gains, source trims, placement, silence and fades', () => {
    const samples = audio(movie);
    expect(amplitude(samples, 0.5, 0.1, 440)).toBeCloseTo(0.125 * 10 ** (-6 / 20), 2);
    expect(amplitude(samples, 0.5, 0.1, 880)).toBeLessThan(0.001);
    expect(amplitude(samples, 1.2, 0.1, 440)).toBeCloseTo(0.125 * 10 ** (-6 / 20), 2);
    expect(amplitude(samples, 1.2, 0.1, 880)).toBeCloseTo(0.125 * 10 ** (-12 / 20), 2);
    expect(amplitude(samples, 2.3, 0.1, 440)).toBeLessThan(0.001);
    expect(amplitude(samples, 2.3, 0.1, 880)).toBeCloseTo(0.125 * 10 ** (-12 / 20), 2);
    expect(amplitude(samples, 0.02, 0.05, 440)).toBeLessThan(amplitude(samples, 0.5, 0.05, 440) * 0.3);
    expect(amplitude(samples, 1.92, 0.05, 440)).toBeLessThan(amplitude(samples, 0.5, 0.05, 440) * 0.3);
    expect(amplitude(samples, 3.3, 0.1, 880)).toBeLessThan(0.001);
  });
  it('renders selected sections with matching frames, audio offsets and preserved fade envelopes', async () => {
    const section = join(directory, 'section.mp4');
    await render(timeline, { output: section, from: secondsToTicks(0.125), to: secondsToTicks(2.25) });
    const full = colors(movie),
      part = colors(section);
    expect(part.length / 48).toBe(51);
    for (const frame of [0, 8, 9, 20, 33, 45]) nearColor(pixel(part, frame), pixel(full, frame + 3));
    const fullAudio = audio(movie),
      sectionAudio = audio(section);
    expect(amplitude(sectionAudio, 0.025, 0.05, 440)).toBeCloseTo(amplitude(fullAudio, 0.15, 0.05, 440), 2);
    expect(amplitude(sectionAudio, 1, 0.1, 880)).toBeCloseTo(amplitude(fullAudio, 1.125, 0.1, 880), 2);
  });
  it('caches playable VP8/Opus proxies by edit, range, media fingerprint and format', async () => {
    const options = {
      cacheDir: join(directory, '.cut-cache'),
      from: secondsToTicks(0.5),
      to: secondsToTicks(1.5),
      format: 'webm' as const
    };
    const first = await renderPreview(timeline, options),
      second = await renderPreview(timeline, options);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.path).toBe(second.path);
    expect(first.hash).toBe(timeline.hash);
    const proxyInfo = await probeMedia(first.path);
    expect(proxyInfo.hasVideo && proxyInfo.hasAudio).toBe(true);
    const changed = await compile(source.replace('opacity 0.5', 'opacity 0.25'), join(directory, 'film.cut'));
    const third = await renderPreview(changed.timeline!, options);
    expect(third.path).not.toBe(first.path);
    const probe = JSON.parse(
      (await runTool('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', first.path])).stdout
    );
    expect(probe.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(['vp8', 'opus']);
  });
  it('keeps a nonzero source trim and sub-millisecond timeline placement sample-accurate', async () => {
    const impulse = join(directory, 'impulse.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='if(eq(n,24001),0.5,0)':s=48000:d=1",
      '-af',
      'pan=stereo|c0=c0|c1=c0',
      '-c:a',
      'pcm_f32le',
      '-y',
      impulse
    ]);
    const result = await compile(
      'film "Samples" { resolution 320x180 track audio "Impulse" { clip "impulse.wav" { in 0.5s out 0.51s at 0.000125s } } }',
      join(directory, 'sample.cut')
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const plan = buildRenderPlan(result.timeline!, { output: join(directory, 'unused.mp4') });
    const raw = ffmpeg([
      ...plan.args.slice(3, plan.args.indexOf('-filter_complex')),
      '-filter_complex',
      plan.graph,
      '-map',
      '[vout]',
      '-f',
      'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-map',
      '[aout]',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:1'
    ]);
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const activeSamples = [...samples].filter((value, index) => index % 2 === 0 && Math.abs(value) > 0.01);
    expect(activeSamples).toHaveLength(1);
    expect(samples[7 * 2]).toBeCloseTo(0.5, 5);
    expect(samples[6 * 2]).toBe(0);
    expect(samples[8 * 2]).toBe(0);
    const shortPreview = await renderPreview(result.timeline!, { cacheDir: join(directory, '.cut-cache') });
    expect(shortPreview.to).toBeGreaterThanOrEqual(result.timeline!.duration);
  });
  it('renders an audible H.264/MP3 MP4 proxy for restricted VS Code webviews', async () => {
    const options = {
      cacheDir: join(directory, '.cut-cache'),
      format: 'mp4' as const,
      audioCodec: 'mp3' as const
    };
    const proxy = await renderPreview(timeline, options);
    const probe = JSON.parse(
      (await runTool('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', proxy.path])).stdout
    );
    expect(probe.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(['h264', 'mp3']);
    const samples = audio(proxy.path);
    expect(amplitude(samples, 1.2, 0.1, 440)).toBeCloseTo(0.125 * 10 ** (-6 / 20), 2);
    expect(amplitude(samples, 1.2, 0.1, 880)).toBeCloseTo(0.125 * 10 ** (-12 / 20), 2);
    const aac = await renderPreview(timeline, { ...options, audioCodec: 'aac' });
    expect(aac.path).not.toBe(proxy.path);
    const cached = await renderPreview(timeline, options);
    expect(cached.cached).toBe(true);
    expect(cached.path).toBe(proxy.path);
  });
  it('preserves overlapping fade envelopes when rendering through the tail of an audio clip', async () => {
    const result = await compile(
      'film "Fades" { resolution 320x180 track audio "Tone" { clip "440.wav" { in 0.5s out 1.5s at 0s fade_in 0.8s fade_out 0.8s } } }',
      join(directory, 'fade.cut')
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const full = join(directory, 'fades.mp4'),
      section = join(directory, 'fades-section.mp4');
    await render(result.timeline!, { output: full });
    await render(result.timeline!, { output: section, from: secondsToTicks(0.875), to: secondsToTicks(1) });
    expect(amplitude(audio(section), 0.025, 0.05, 440)).toBeCloseTo(
      amplitude(audio(full), 0.9, 0.05, 440),
      3
    );
  });
  it('uses direct playback only when the single silent full-frame source exactly matches the composition', async () => {
    const single = await compile(
      'film "Direct" { resolution 320x180 fps 24 track video "Main" { clip "red.mp4" from 0.5s to 1.5s at 0s } }',
      join(directory, 'direct.cut')
    );
    const direct = findDirectPreview(single.timeline!, {
      from: secondsToTicks(0.25),
      to: secondsToTicks(0.75)
    });
    expect(direct?.direct).toBe(true);
    expect(direct?.path).toBe(join(directory, 'red.mp4'));
    expect(ticksToSeconds(direct!.sourceIn!)).toBe(0.75);
    expect(findDirectPreview(timeline)).toBeUndefined();
    const scaled = await compile(
      'film "Scale" { resolution 640x360 fps 24 track video "Main" { clip "red.mp4" from 0s to 1s at 0s } }',
      join(directory, 'scale.cut')
    );
    expect(findDirectPreview(scaled.timeline!)).toBeUndefined();
  });
  it('validates video overlap on the resolved frame grid rather than unrounded source decimals', async () => {
    const adjacent = await compile(
      'film "Frames" { resolution 320x180 fps 24 track video "A" { clip "red.mp4" from 0s to 1s at 0s clip "blue.mp4" from 0s to 1s at 0.999s } }',
      join(directory, 'frames.cut')
    );
    expect(adjacent.timeline).toBeDefined();
    expect(adjacent.diagnostics.some((d) => d.code === 'FRAME_ROUNDING')).toBe(true);
    expect(adjacent.timeline!.tracks[0].clips[1].at).toBe(secondsToTicks(1));
    const overlap = await compile(
      'film "Frames" { resolution 320x180 fps 24 track video "A" { clip "red.mp4" from 0s to 1s at 0s clip "blue.mp4" from 0s to 1s at 0.95s } }',
      join(directory, 'frames.cut')
    );
    expect(overlap.timeline).toBeUndefined();
    expect(overlap.diagnostics.some((d) => d.code === 'TRACK_OVERLAP')).toBe(true);
  });
  it('reports missing files, missing stream kinds, invalid ranges and implicit-duration overlaps', async () => {
    const invalids = [
      source.replace('red.mp4', 'missing.mp4'),
      source.replace('red.mp4', '440.wav'),
      source.replace('from 0s to 1s at 0s', 'from 0s to 10s at 0s'),
      'film "Overlap" { track audio "A" { clip "440.wav" { at 0s } clip "880.wav" { at 1s } } }'
    ];
    for (const invalid of invalids) {
      const result = await compile(invalid, join(directory, 'film.cut'));
      expect(result.timeline).toBeUndefined();
      expect(result.diagnostics.some((d) => d.severity === 'error' && d.range.start.line >= 0)).toBe(true);
    }
  });
  it('rejects overwriting a source and supports cancellation without leaving partial output', async () => {
    await expect(render(timeline, { output: join(directory, 'red.mp4') })).rejects.toThrow('overwrite');
    const controller = new AbortController(),
      output = join(directory, 'cancelled.mp4');
    const rendering = render(timeline, { output, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(directory)).not.toContain('cancelled.mp4');
    expect((await readdir(directory)).some((name) => name.includes('.partial'))).toBe(false);
  });
  it('gives actionable executable installation guidance', async () => {
    configureTools({ ffmpegPath: join(directory, 'missing-ffmpeg') });
    try {
      await expect(checkTools()).rejects.toThrow('Install FFmpeg');
    } finally {
      configureTools({});
    }
  });
});
