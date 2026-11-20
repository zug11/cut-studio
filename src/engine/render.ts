import { tmpdir } from 'node:os';
import { drawTitle } from './graphics';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  RenderOptions,
  ResolvedClip,
  Tick,
  Timeline
} from '../core/types';
import {
  frameToTicks,
  framesCovering,
  quantizeToFrame,
  TICKS_PER_SECOND,
  ticksToSeconds,
  ticksToFrame
} from '../core/time';
import { assertNotAborted, runTool } from './process';
import { assertSafeOutput } from './output';
import { arrangeLayers } from '../core/layers';

export function ffmpegSeconds(ticks: Tick): string {
  const value = BigInt(Math.round(ticks)),
    rate = BigInt(TICKS_PER_SECOND),
    sign = value < 0n ? '-' : '',
    absolute = value < 0n ? -value : value;
  return `${sign}${absolute / rate}.${(((absolute % rate) * 1_000_000_000n) / rate).toString().padStart(9, '0')}`;
}
export function renderRange(
  timeline: Timeline,
  options: { from?: Tick; to?: Tick } = {}
): { from: Tick; to: Tick } {
  if (
    (options.from != null &&
      (!Number.isSafeInteger(options.from) || options.from < 0)) ||
    (options.to != null &&
      (!Number.isSafeInteger(options.to) || options.to <= 0))
  )
    throw new Error(
      'Render boundaries must be finite nonnegative CUT timestamps.'
    );
  const end = frameToTicks(
    framesCovering(timeline.duration, timeline.fps),
    timeline.fps
  );
  const from = quantizeToFrame(options.from ?? 0, timeline.fps);
  const to = Math.min(
    end,
    options.to == null ? end : quantizeToFrame(options.to, timeline.fps)
  );
  if (from >= to)
    throw new Error(
      'Render range is empty. --from must be before --to and before the end of the film.'
    );
  return { from, to };
}
function sampleCount(ticks: Tick, sampleRate: number): number {
  const numerator = BigInt(ticks) * BigInt(sampleRate),
    denominator = BigInt(TICKS_PER_SECOND);
  return Number((numerator * 2n + denominator) / (2n * denominator));
}
interface ActiveClip {
  clip: ResolvedClip;
  kind: 'video' | 'audio';
  index: number;
  elapsed: Tick;
  endOffset: Tick;
  seekOffset: Tick;
  offset: Tick;
}
export interface RenderPlan {
  args: string[];
  from: Tick;
  to: Tick;
  width: number;
  height: number;
  graph: string;
}
/** Pure planning layer: FFmpeg receives arguments directly, never a shell command. */
export function buildRenderPlan(
  timeline: Timeline,
  options: RenderOptions,
  destination = options.output
): RenderPlan {
  const { from, to } = renderRange(timeline, options),
    duration = to - from;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-filter_complex_threads',
    '1'
  ];
  const active: ActiveClip[] = [];
  for (const track of arrangeLayers(timeline.tracks))
    for (const clip of track.clips) {
      if (clip.end <= from || clip.at >= to || (options.format === 'wav' && track.kind === 'video')) continue;
      const elapsed = Math.max(0, from - clip.at),
        endOffset = Math.min(clip.duration, to - clip.at);
      let seekOffset = elapsed;
      // Keep the original fade envelope when rendering a section through a fade.
      if (track.kind === 'audio') {
        if (elapsed < clip.fadeIn) seekOffset = 0;
        if (clip.fadeOut > 0 && elapsed >= clip.duration - clip.fadeOut)
          seekOffset = Math.min(seekOffset, clip.duration - clip.fadeOut);
        if (seekOffset < clip.fadeIn) seekOffset = 0;
      }
      const inputStart = clip.in + seekOffset;
      args.push(
        '-protocol_whitelist',
        'file,pipe',
        ...(options.formatWhitelist
          ? ['-format_whitelist', options.formatWhitelist]
          : []),
        ...(clip.media.still ? ['-loop','1','-framerate', timeline.fps.num + '/' + timeline.fps.den] : ['-ss',ffmpegSeconds(inputStart)]),
        '-t',
        ffmpegSeconds(endOffset - seekOffset),
        '-i',
        clip.absolutePath
      );
      active.push({
        clip,
        kind: track.kind,
        index: active.length,
        elapsed,
        endOffset,
        seekOffset,
        offset: Math.max(0, clip.at - from)
      });
    }
  const scale = options.preview
    ? Math.min(
        1,
        960 / timeline.resolution.width,
        540 / timeline.resolution.height
      )
    : 1;
  const width = Math.max(
      2,
      Math.round((timeline.resolution.width * scale) / 2) * 2
    ),
    height = Math.max(
      2,
      Math.round((timeline.resolution.height * scale) / 2) * 2
    );
  const fps = `${timeline.fps.num}/${timeline.fps.den}`,
    d = ffmpegSeconds(duration);
  const filters: string[] = options.format === 'wav' ? [] : [
    `color=c=${options.alpha ? 'black@0' : 'black'}:s=${width}x${height}:r=${fps}:d=${d},format=${options.alpha ? 'rgba' : 'yuv420p'}[base]`
  ];
  let previous = 'base',
    videoIndex = 0;
  const audioLabels: string[] = ['silence'];
  filters.push(
    `anullsrc=r=48000:cl=stereo,atrim=duration=${d},asetpts=PTS-STARTPTS[silence]`
  );
  for (const item of active) {
    const { clip, index, elapsed, endOffset, seekOffset, offset } = item;
    const label = `clip${index}`;
    if (item.kind === 'video') {
      const clipDuration = endOffset - elapsed;
      const factor = clip.scale ?? 1;
      const w = Math.max(2, Math.round(width * factor / 2) * 2), h = Math.max(2, Math.round(height * factor / 2) * 2);
      const edges = clip.crop;
      const crop = edges ? `crop=iw-${edges[0]+edges[2]}:ih-${edges[1]+edges[3]}:${edges[0]}:${edges[1]}:exact=1,` : '';
      filters.push(
        `[${index}:v:0]trim=duration=${ffmpegSeconds(clipDuration)},setpts=PTS-STARTPTS,fps=fps=${fps}:start_time=0:round=near,${crop}scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,format=rgba,setsar=1,colorchannelmixer=aa=${clip.opacity},setpts=PTS+${ffmpegSeconds(offset)}/TB[${label}]`
      );
      const out = `v${videoIndex++}`;
      const x = Math.round((clip.x ?? 0) * scale), y = Math.round((clip.y ?? 0) * scale);
      filters.push(
        `[${previous}][${label}]overlay=x=(W-w)/2+${x}:y=(H-h)/2+${y}:${options.alpha ? 'format=rgb:' : ''}eof_action=pass:repeatlast=0:shortest=0:enable='gte(t,${ffmpegSeconds(offset)})*lt(t,${ffmpegSeconds(offset + clipDuration)})'[${out}]`
      );
      previous = out;
    } else {
      const sourceRate = clip.media.sampleRate || 48000;
      const samples = (ticks: Tick) => sampleCount(ticks, sourceRate);
      const audio = [
        `atrim=end_sample=${samples(endOffset - seekOffset)}`,
        'asetpts=PTS-STARTPTS',
        `volume=${clip.gain}dB`
      ];
      if (samples(clip.fadeIn) > 0 && seekOffset < clip.fadeIn)
        audio.push(`afade=t=in:ss=0:ns=${samples(clip.fadeIn)}`);
      if (samples(clip.fadeOut) > 0 && endOffset > clip.duration - clip.fadeOut)
        audio.push(
          `afade=t=out:ss=${samples(Math.max(0, clip.duration - clip.fadeOut - seekOffset))}:ns=${samples(clip.fadeOut)}`
        );
      if (elapsed > seekOffset)
        audio.push(
          `atrim=start_sample=${samples(elapsed - seekOffset)}`,
          'asetpts=PTS-STARTPTS'
        );
      if (clip.duck && clip.duckRanges?.length) {
        const intervals = clip.duckRanges.filter(r => r.end > elapsed && r.start < endOffset)
          .map(r => `gte(t,${ffmpegSeconds(r.start-elapsed)})*lt(t,${ffmpegSeconds(r.end-elapsed)})`);
        if (intervals.length) audio.push(`volume=${clip.duck.db}dB:enable='${intervals.join('+')}'`);
      }
      const delaySamples = sampleCount(offset, 48000);
      audio.push(
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `adelay=${delaySamples}S:all=1`
      );
      filters.push(`[${index}:a:0]${audio.join(',')}[${label}]`);
      audioLabels.push(label);
    }
  }
  if (options.format !== 'wav') filters.push(`[${previous}]format=${options.alpha ? 'yuva444p10le' : 'yuv420p'}[vout]`);
  filters.push(
    `${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0:normalize=0,atrim=duration=${d}[aout]`
  );
  if (options.alpha) filters.push('[aout]anullsink');
  const graph = filters.join(';');
  args.push('-filter_complex', graph);
  if (options.format !== 'wav') args.push('-map', '[vout]', '-fps_mode', 'cfr');
  if (!options.alpha) args.push('-map','[aout]');
  args.push('-t', options.format === 'wav' ? ffmpegSeconds(Math.min(to,timeline.duration)-from) : d);
  if (options.format === 'wav') args.push('-c:a','pcm_s24le','-f','wav');
  else if (options.alpha) args.push('-c:v','prores_ks','-profile:v','4','-alpha_bits','16','-pix_fmt','yuva444p10le','-threads','2','-f','mov');
  else if (options.format === 'webm')
    args.push(
      '-c:v',
      'libvpx',
      '-b:v',
      options.preview ? '1500k' : '4000k',
      '-maxrate',
      options.preview ? '2000k' : '6000k',
      '-bufsize',
      options.preview ? '3000k' : '8000k',
      '-crf',
      options.preview ? '32' : '16',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-lag-in-frames',
      '0',
      '-threads',
      '2',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-f',
      'webm'
    );
  else
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      options.preview ? 'ultrafast' : 'medium',
      '-crf',
      options.preview ? '25' : '18',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      options.audioCodec === 'mp3' ? 'libmp3lame' : 'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4'
    );
  args.push('-progress', 'pipe:1', '-nostats', destination);
  return { args, from, to, width, height, graph };
}
export async function render(
  timeline: Timeline,
  options: RenderOptions
): Promise<string> {
  assertNotAborted(options.signal);
  const output = await assertSafeOutput(timeline, options.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = resolve(
    dirname(output),
    `.${basename(output)}.${randomUUID()}.partial`
  );
  const artwork = timeline.tracks.some(t => t.clips.some(c => c.element === 'title' || c.element === 'caption'))
    ? await mkdtemp(resolve(tmpdir(),'cut-artwork-')) : undefined;
  try {
  if (artwork) {
    let number = 0;
    const tracks = await Promise.all(timeline.tracks.map(async track => ({...track,
      clips: await Promise.all(track.clips.map(async clip => {
        if (clip.element !== 'caption' && clip.element !== 'title') return clip;
        const file = resolve(artwork, (++number) + '.png');
        await drawTitle(clip,timeline.resolution.width,timeline.resolution.height,file);
        return {...clip,absolutePath:file};
      }))
    })));
    timeline = {...timeline,tracks};
  }
  const plan = buildRenderPlan(timeline, options, temporary);
  const totalSeconds = ticksToSeconds(plan.to - plan.from);
  let pending = '';
  options.onProgress?.({ seconds: 0, fraction: 0 });
  try {
    await runTool('ffmpeg', plan.args, {
      signal: options.signal,
      onStdout(chunk) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const seconds = Math.max(
              0,
              Number(line.slice('out_time_us='.length)) / 1_000_000
            );
            if (Number.isFinite(seconds))
              options.onProgress?.({
                seconds,
                fraction: Math.max(0, Math.min(1, seconds / totalSeconds))
              });
          }
        }
      }
    });
    assertNotAborted(options.signal);
    await assertSafeOutput(timeline, output);
    await rename(temporary, output);
    options.onProgress?.({ seconds: totalSeconds, fraction: 1 });
    return output;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  } finally { if (artwork) await rm(artwork,{recursive:true,force:true}); }
}
