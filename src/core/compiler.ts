import { realpath } from 'node:fs/promises';
import { readDocument } from '../project/documents';
import { placeItems } from './placement';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCut } from './parser';
import {
  formatTime,
  quantizeToFrame,
  frameToTicks,
  ticksToFrame
} from './time';
import type {
  Clip,
  CompileResult,
  Diagnostic,
  ResolvedClip,
  ResolvedTrack,
  SourceRange,
  Timeline
} from './types';
import { probeMedia } from '../engine/probe';
import { assertNotAborted } from '../engine/process';
import { arrangeLayers } from './layers';

export interface CompileOptions {
  signal?: AbortSignal;
  formatWhitelist?: string;
  readScene?: (file: string) => Promise<{file: string; source: string}>;
}

async function openScene(file: string) {
  const actual = await realpath(file);
  if (!/\.cut$/i.test(actual)) throw new Error('Choose a .cut scene file.');
  return {file: actual, source: (await readDocument(actual)).source};
}

/** Shared by the CLI and VS Code. No editor dependencies enter the compiler. */
export async function compile(
  source: string,
  filePath: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  return compileFilm(source, resolve(filePath), options, [], { count: 0 });
}

async function compileFilm(source: string, filePath: string, options: CompileOptions, ancestors: string[], budget: {count: number}): Promise<CompileResult> {
  const parsed = parseCut(source);
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  if (!parsed.film || diagnostics.some((d) => d.severity === 'error'))
    return { ...parsed, diagnostics };
  const film = parsed.film;
  const diagnostic = (
    code: string,
    message: string,
    range: SourceRange,
    severity: Diagnostic['severity'] = 'error'
  ) => diagnostics.push({ code, message, range, severity });
  if (film.resolution.width % 2 || film.resolution.height % 2)
    diagnostic(
      'RESOLUTION',
      'H.264 output requires even resolution dimensions, such as 1920x1080.',
      film.range
    );
  let tracks: ResolvedTrack[] = arrangeLayers(
    await Promise.all(
      film.tracks.map(async (track) => {
        const clips = await Promise.all(
          track.clips.map(async (clip): Promise<ResolvedClip | undefined> => {
            assertNotAborted(options.signal);
            if (
              !clip.path ||
              /\0/.test(clip.path) ||
              (!clip.element && /^[a-z][a-z0-9+.-]*:\/\//i.test(clip.path))
            ) {
              diagnostic(
                'LOCAL_MEDIA_ONLY',
                'Use a relative or absolute local media path. URLs and remote processing are not supported.',
                clip.fields.path || clip.range
              );
              return;
            }
            const absolutePath = clip.element ? resolve(dirname(filePath), '.cut-graphic-' + clip.id + '.png') : resolve(dirname(filePath), clip.path);
            try {
              const graphic = clip.element === 'title' || clip.element === 'caption';
              const media = graphic ? {
                path: absolutePath, fingerprint: createHash('sha256').update(clip.element! + clip.path).digest('hex'),
                hasVideo: true, hasAudio: false, duration: 0, still: true,
                width: film.resolution.width, height: film.resolution.height, videoDuration: undefined, audioDuration: undefined
              } : await probeMedia(absolutePath, options.signal, {
                formatWhitelist: options.formatWhitelist
              });
              if (!(track.kind === 'video' ? media.hasVideo : media.hasAudio)) {
                diagnostic(
                  'STREAM_MISSING',
                  `“${clip.path}” has no ${track.kind} stream.`,
                  clip.fields.path || clip.range
                );
                return;
              }
              if (media.still && clip.out === undefined) { diagnostic('STILL_DURATION','Give a still, title or caption an out time for its duration.',clip.range); return; }
              if (clip.crop && (clip.crop[0]+clip.crop[2] >= (media.width || 0) || clip.crop[1]+clip.crop[3] >= (media.height || 0))) {
                diagnostic('CROP_RANGE', 'Crop margins must leave some visible picture.', clip.fields.crop || clip.range); return;
              }
              const sourceDuration = media.still ? clip.out! : (track.kind === 'video'
                  ? media.videoDuration
                  : media.audioDuration) || media.duration;
              let sourceIn = clip.in,
                sourceOut = clip.out ?? sourceDuration,
                at = clip.at;
              if (sourceIn < 0 || sourceIn >= sourceDuration) {
                diagnostic(
                  'SOURCE_RANGE',
                  `Source in ${formatTime(sourceIn)} is outside “${clip.path}” (${formatTime(sourceDuration)} long).`,
                  clip.fields.in || clip.range
                );
                return;
              }
              // One tick tolerance accounts only for metadata decimal rounding, never an extra frame.
              if (sourceOut > sourceDuration + 1) {
                diagnostic(
                  'SOURCE_RANGE',
                  `Source out ${formatTime(sourceOut)} exceeds “${clip.path}” (${formatTime(sourceDuration)} long). out is exclusive.`,
                  clip.fields.out || clip.range
                );
                return;
              }
              if (track.kind === 'video') {
                for (const field of ['in', 'out', 'at'] as const) {
                  const original =
                    field === 'in'
                      ? sourceIn
                      : field === 'out'
                        ? sourceOut
                        : at;
                  let rounded = quantizeToFrame(original, film.fps);
                  // A rounded out must never ask the decoder for media beyond the source.
                  if (field === 'out' && rounded > sourceDuration)
                    rounded = frameToTicks(
                      ticksToFrame(rounded, film.fps) - 1,
                      film.fps
                    );
                  if (rounded !== original) {
                    diagnostic(
                      'FRAME_ROUNDING',
                      `${field} ${formatTime(original)} resolves to ${formatTime(rounded)} on the ${film.fps.num}/${film.fps.den} fps output grid.`,
                      clip.fields[field] || clip.range,
                      'warning'
                    );
                  }
                  if (field === 'in') sourceIn = rounded;
                  else if (field === 'out') sourceOut = rounded;
                  else at = rounded;
                }
              }
              const exactEnd =
                BigInt(at) + BigInt(sourceOut) - BigInt(sourceIn);
              if (exactEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
                diagnostic(
                  'TIME_OVERFLOW',
                  'The clip end exceeds the exact integer timeline. Use a shorter timeline position.',
                  clip.fields.at || clip.range
                );
                return;
              }
              const end = Number(exactEnd),
                duration = sourceOut - sourceIn;
              if (!(duration > 0)) {
                diagnostic(
                  'INVALID_RANGE',
                  'out must be after in, with at least one output frame for video.',
                  clip.fields.out || clip.range
                );
                return;
              }
              if (at < 0) {
                diagnostic(
                  'NEGATIVE_POSITION',
                  'at must be zero or later.',
                  clip.fields.at || clip.range
                );
                return;
              }
              if (clip.fadeIn > duration || clip.fadeOut > duration)
                diagnostic(
                  'FADE_RANGE',
                  `Each fade must fit inside the ${formatTime(duration)} clip.`,
                  (clip.fadeIn > duration
                    ? clip.fields.fadeIn
                    : clip.fields.fadeOut) || clip.range
                );
              return {
                ...clip,
                in: sourceIn,
                out: sourceOut,
                at,
                duration,
                end,
                absolutePath,
                media: media.still ? { ...media, duration: sourceDuration } : media
              };
            } catch (error) {
              if (options.signal?.aborted) throw error;
              const message =
                error instanceof Error ? error.message : String(error);
              diagnostic(
                'MEDIA_ERROR',
                `“${clip.path}”: ${message}`,
                clip.fields.path || clip.range
              );
            }
          })
        );
        return {
          ...track,
          clips: clips.filter((clip): clip is ResolvedClip => !!clip)
        };
      })
    )
  );
  const scenes: { ref: Clip & {duration: number; end: number}; timeline: Timeline }[] = [];
  const dependencies = new Set<string>();
  for (const ref of film.scenes || []) {
    assertNotAborted(options.signal);
    try {
      if (!/\.cut$/i.test(ref.path)) throw new Error('A scene must reference a .cut file.');
      if (ancestors.length >= 16 || ++budget.count > 256) throw new Error('Scene nesting or instance limit exceeded (16 levels, 256 scenes).');
      const child = await (options.readScene || openScene)(resolve(dirname(filePath), ref.path));
      if (child.file === filePath || ancestors.includes(child.file)) throw new Error('Circular scene reference.');
      const result = await compileFilm(child.source, child.file, options, [...ancestors,filePath], budget);
      for (const d of result.diagnostics) diagnostic(d.code, ref.path + ' line ' + (d.range.start.line + 1) + ' — ' + d.message, ref.range, d.severity);
      if (!result.timeline) continue;
      const timeline = result.timeline;
      if (timeline.fps.num !== film.fps.num || timeline.fps.den !== film.fps.den || timeline.resolution.width !== film.resolution.width || timeline.resolution.height !== film.resolution.height)
        throw new Error('Use the same resolution and frame rate in the parent and its scene.');
      dependencies.add(child.file);
      for (const dep of timeline.dependencies || []) dependencies.add(dep);
      scenes.push({ref: {...ref, at: quantizeToFrame(ref.at, film.fps), duration: timeline.duration, end: ref.at + timeline.duration}, timeline});
    } catch (error) {
      if (options.signal?.aborted) throw error;
      diagnostic('SCENE_ERROR', ref.path + ' — ' + (error instanceof Error ? error.message : error), ref.range);
    }
  }
  placeItems([
    ...tracks.flatMap(track => track.clips.map(item => ({item,picture:track.kind === 'video'}))),
    ...scenes.map(({ref}) => ({item:ref, picture:true}))
  ],film,diagnostics);
  if (scenes.length) {
    const nested = scenes.flatMap(({ref,timeline}) => timeline.tracks.filter(t => t.clips.length).map(track => ({
      ...track, clips: track.clips.map(c => ({
        ...c, id: ref.id + '/' + c.id, sceneId: ref.id, originFile: c.originFile || timeline.filePath,
        range: ref.range, fields: {}, path: c.element ? c.path : relative(dirname(filePath), c.absolutePath),
        at: ref.at + c.at, end: ref.at + c.end
      }))
    })));
    tracks = arrangeLayers([...tracks, ...nested]);
  }
  for (const track of tracks) for (const clip of track.clips) {
    if (!clip.duck) continue;
    const dialogue = tracks.find(t => t.kind === 'audio' && t.layer === clip.duck!.layer);
    if (!dialogue || dialogue === track) {
      diagnostic('DUCK_LAYER','Ducking needs a different, existing audio layer.',clip.fields.duck || clip.range); continue;
    }
    clip.duckRanges = dialogue.clips.filter(c => c.end > clip.at && c.at < clip.end).map(c => ({
      start: Math.max(0, c.at - clip.at), end: Math.min(clip.duration, c.end - clip.at)
    }));
  }
  assertNotAborted(options.signal);
  for (const track of tracks) {
    const clips = [...track.clips].sort((a, b) => a.at - b.at);
    for (let index = 1; index < clips.length; index++) {
      if (clips[index].at < clips[index - 1].end)
        diagnostic(
          'TRACK_OVERLAP',
          `Clips overlap on ${track.kind} layer ${track.kind === 'video' ? 'V' : 'A'}${track.layer} (“${track.name}”) at ${formatTime(clips[index].at)}. Change at or assign a different layer.`,
          clips[index].fields.at || clips[index].range
        );
    }
  }
  const duration = Math.max(
    0,
    ...tracks.flatMap((track) => track.clips.map((clip) => clip.end))
  );
  if (!(duration > 0))
    diagnostic(
      'EMPTY_FILM',
      'Add at least one video or audio clip with a positive duration.',
      film.range
    );
  if (diagnostics.some((d) => d.severity === 'error'))
    return { film, diagnostics };
  const semantic = {
    name: film.name,
    fps: film.fps,
    resolution: film.resolution,
    tracks: tracks.map((track) => ({
      kind: track.kind,
      name: track.name,
      layer: track.layer,
      clips: track.clips.map((clip) => ({
        path: clip.absolutePath,
        in: clip.in,
        out: clip.out,
        at: clip.at,
        layer: clip.layer,
        opacity: clip.opacity,
        gain: clip.gain,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        x: clip.x, y: clip.y, scale: clip.scale, crop: clip.crop, element: clip.element, duck: clip.duck, duckRanges: clip.duckRanges,
        fingerprint: clip.media.fingerprint
      }))
    }))
  };
  const hash = createHash('sha256')
    .update('cut-engine-1\0')
    .update(JSON.stringify(semantic))
    .digest('hex');
  const timeline: Timeline = {
    ...film,
    tracks,
    duration,
    filePath: resolve(filePath),
    dependencies: [...dependencies],
    ...(scenes.length ? {scenes:scenes.map(({ref})=>({...ref,out:ref.duration}))} : {}),
    hash
  };
  return { film, timeline, diagnostics };
}
