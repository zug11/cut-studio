import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { probeMedia } from '../engine/probe';
import { runTool } from '../engine/process';
import { renderPreview } from '../engine/preview';
import { drawSVG } from '../engine/graphics';
import { ffmpegSeconds } from '../engine/render';
import {
  formatTime,
  frameToTicks,
  framesCovering,
  parseTime,
  playablePosition,
  secondsToTicks,
  ticksToFrame,
  ticksToSeconds
} from '../core/time';
import type { Timeline, Rational } from '../core/types';
import { ProjectPaths, CONFINED_MEDIA_FORMATS, projectFileKind } from './paths';

export interface ReviewMedia {
  image?: string;
  audio?: string;
  movie?: string;
  frames: { seconds: number; ticks: number; frame: number; timecode: string }[];
  cue?: { ticks: number; seconds: number; frame: number; timecode: string };
  fps?: Rational;
  from: number;
  to: number;
}

export async function mediaFile(project: ProjectPaths, file: string) {
  const absolute = await project.resolve(file);
  for (const name of [file, absolute]) {
    if (!['video', 'audio'].includes(projectFileKind(name) || ''))
      throw new Error(
        'Choose a video, sound file or still inside the project.'
      );
  }
  return absolute;
}
async function cache(project: ProjectPaths) {
  const directory = await project.resolve('.cut-cache/review', true);
  await mkdir(directory, { recursive: true });
  return directory;
}
const inputGuard = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  CONFINED_MEDIA_FORMATS
];
const quiet = ['-v', 'error', '-nostdin', '-y'];
async function sheet(
  input: string,
  times: number[],
  labels: number[],
  fps: Rational,
  output: string,
  signal?: AbortSignal
) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'cut-frames-'));
  try {
    const cells: string[] = [];
    const columns = Math.min(4, times.length),
      w = 224,
      h = 126,
      row = h + 25;
    for (const [i, tick] of times.entries()) {
      const jpeg = path.join(scratch, i + '.jpg');
      await runTool(
        'ffmpeg',
        [
          ...quiet,
          ...inputGuard,
          '-ss',
          ffmpegSeconds(tick),
          '-i',
          input,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          'scale=224:126:force_original_aspect_ratio=decrease,pad=224:126:(ow-iw)/2:(oh-ih)/2',
          '-q:v',
          '4',
          jpeg
        ],
        { signal }
      );
      const bytes = await readFile(jpeg);
      const x = (i % columns) * w,
        y = Math.floor(i / columns) * row;
      cells.push(
        '<image x="' +
          x +
          '" y="' +
          y +
          '" width="' +
          w +
          '" height="' +
          h +
          '" xlink:href="data:image/jpeg;base64,' +
          bytes.toString('base64') +
          '"/>',
        '<text x="' +
          (x + 8) +
          '" y="' +
          (y + h + 17) +
          '" font-size="13" fill="#dce7df">' +
          formatTime(labels[i], fps) +
          '</text>'
      );
    }
    await drawSVG(
      columns * w,
      Math.ceil(times.length / columns) * row,
      '<rect width="100%" height="100%" fill="#171d21"/>' + cells.join(''),
      output
    );
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}
async function audioSample(
  input: string,
  start: number,
  duration: number,
  output: string,
  signal?: AbortSignal
) {
  await runTool(
    'ffmpeg',
    [
      ...quiet,
      ...inputGuard,
      '-ss',
      ffmpegSeconds(start),
      '-i',
      input,
      '-t',
      ffmpegSeconds(duration),
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      '32000',
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '96k',
      output
    ],
    { signal }
  );
}
export async function contactSheet(
  project: ProjectPaths,
  file: string,
  count = 8,
  signal?: AbortSignal
): Promise<ReviewMedia> {
  const asset = await mediaFile(project, file);
  const info = await probeMedia(asset, signal, {
    formatWhitelist: CONFINED_MEDIA_FORMATS
  });
  if (!info.hasVideo)
    throw new Error(
      'This source contains sound only. Use Audition to hear it.'
    );
  if (!Number.isInteger(count) || count < 1 || count > 12)
    throw new Error('Choose 1 to 12 frames.');
  const fps = info.fps || { num: 24, den: 1 };
  const frames = info.still
    ? 1
    : Math.max(1, framesCovering(info.videoDuration || info.duration, fps));
  const n = Math.min(count, frames);
  const times = Array.from({ length: n }, (_, i) =>
    frameToTicks(Math.floor((i * frames) / n), fps)
  );
  const image = path.join(await cache(project), randomUUID() + '.png');
  await sheet(asset, times, times, fps, image, signal);
  return {
    image,
    fps,
    frames: times.map((t) => ({
      seconds: ticksToSeconds(t),
      ticks: t,
      frame: ticksToFrame(t, fps),
      timecode: formatTime(t, fps)
    })),
    from: 0,
    to: ticksToSeconds(info.duration)
  };
}
export async function audition(
  project: ProjectPaths,
  file: string,
  from = 0,
  seconds = 5,
  signal?: AbortSignal
): Promise<ReviewMedia> {
  if (
    !Number.isFinite(from) ||
    from < 0 ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 15
  )
    throw new Error('Use a source position and a duration up to 15 seconds.');
  const asset = await mediaFile(project, file);
  const info = await probeMedia(asset, signal, {
    formatWhitelist: CONFINED_MEDIA_FORMATS
  });
  if (info.still) return contactSheet(project, file, 1, signal);
  const duration = Math.min(seconds, ticksToSeconds(info.duration) - from);
  if (duration <= 0)
    throw new Error('The source position is past the end of the take.');
  const base = path.join(await cache(project), randomUUID());
  const result: ReviewMedia = { from, to: from + duration, frames: [] };
  try {
    if (info.hasVideo) {
      result.movie = base + '.mp4';
      await runTool(
        'ffmpeg',
        [
          ...quiet,
          ...inputGuard,
          '-ss',
          String(from),
          '-i',
          asset,
          '-t',
          String(duration),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          '-pix_fmt',
          'yuv420p',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          result.movie
        ],
        { signal }
      );
      const fps = info.fps || { num: 24, den: 1 };
      result.image = base + '.png';
      await sheet(
        result.movie,
        [0],
        [secondsToTicks(from)],
        fps,
        result.image,
        signal
      );
      result.frames = [
        {
          seconds: from,
          ticks: secondsToTicks(from),
          frame: ticksToFrame(secondsToTicks(from), fps),
          timecode: formatTime(secondsToTicks(from), fps)
        }
      ];
    }
    if (info.hasAudio) {
      result.audio = base + '.mp3';
      await audioSample(
        asset,
        secondsToTicks(from),
        secondsToTicks(duration),
        result.audio,
        signal
      );
    }
    return result;
  } catch (error) {
    await Promise.all(
      [result.movie, result.image, result.audio]
        .filter((p): p is string => !!p)
        .map((p) => rm(p, { force: true }))
    );
    throw error;
  }
}
export function cueTime(timeline: Timeline, cue: string) {
  const match = /^([A-Za-z_][\w-]*)\.(start|end)$/.exec(cue);
  if (!match) return parseTime(cue, timeline.fps);
  const clip = timeline.tracks
    .flatMap((t) => t.clips)
    .find((c) => !c.sceneId && (c.name === match[1] || c.id === match[1]));
  if (clip) return match[2] === 'start' ? clip.at : clip.end;
  const scene = timeline.scenes?.find((s) => s.name === match[1]);
  if (scene && scene.out !== undefined)
    return scene.at + (match[2] === 'start' ? 0 : scene.out);
  throw new Error('Unknown cue: ' + cue);
}
export async function reviewFilm(
  project: ProjectPaths,
  timeline: Timeline,
  cue = '0s',
  seconds = 5,
  signal?: AbortSignal
): Promise<ReviewMedia> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 15)
    throw new Error('Choose a review duration up to 15 seconds.');
  const center = cueTime(timeline, cue);
  if (center > timeline.duration)
    throw new Error('The review cue is past the end of the film.');
  const length = secondsToTicks(seconds),
    from = Math.max(
      0,
      Math.min(center - Math.floor(length / 2), timeline.duration - length)
    );
  const directory = await cache(project);
  const preview = await renderPreview(timeline, {
    cacheDir: directory,
    from,
    to: Math.min(timeline.duration, from + length),
    signal,
    format: 'mp4',
    formatWhitelist: CONFINED_MEDIA_FORMATS
  });
  const movie = await project.resolve(project.relative(preview.path));
  const last = playablePosition(preview.to - 1, preview.to, timeline.fps);
  const frame = ticksToFrame(
    playablePosition(center, timeline.duration, timeline.fps),
    timeline.fps
  );
  const times = [
    ...new Set(
      [
        preview.from,
        frameToTicks(Math.max(0, frame - 1), timeline.fps),
        frameToTicks(frame, timeline.fps),
        last
      ].map((t) => Math.max(preview.from, Math.min(last, t)))
    )
  ].sort((a, b) => a - b);
  const base = path.join(directory, randomUUID()),
    image = base + '.png',
    audio = base + '.mp3';
  try {
    await sheet(
      movie,
      times.map((t) => t - preview.from),
      times,
      timeline.fps,
      image,
      signal
    );
    await audioSample(movie, 0, preview.to - preview.from, audio, signal);
    return {
      movie,
      image,
      audio,
      fps: timeline.fps,
      cue: {
        ticks: center,
        seconds: ticksToSeconds(center),
        frame: ticksToFrame(center, timeline.fps),
        timecode: formatTime(center, timeline.fps)
      },
      from: ticksToSeconds(preview.from),
      to: ticksToSeconds(preview.to),
      frames: times.map((t) => ({
        seconds: ticksToSeconds(t),
        ticks: t,
        frame: ticksToFrame(t, timeline.fps),
        timecode: formatTime(t, timeline.fps)
      }))
    };
  } catch (error) {
    await Promise.all([image, audio].map((p) => rm(p, { force: true })));
    throw error;
  }
}
