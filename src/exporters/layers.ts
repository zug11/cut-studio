import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Timeline, ResolvedClip } from '../core/types';
import { render } from '../engine/render';
import { probeMedia } from '../engine/probe';

import { renderedProperties } from '../core/premiere-plan';
/** Keep individual layers editable in Premiere. Bake only the unsupported appearance or mix. */
export async function prepareLayers(
  timeline: Timeline,
  destination: string,
  signal?: AbortSignal,
  formatWhitelist?: string,
  target: 'premiere' | 'resolve' = 'premiere'
) {
  const resolve = target === 'resolve';
  function properties(c: ResolvedClip, kind: 'video' | 'audio') {
    const props = renderedProperties(c);
    if (resolve && kind === 'video' && c.opacity !== 1) props.push('opacity');
    if (resolve && kind === 'audio') {
      if (c.gain) props.push('gain');
      if (c.fadeIn || c.fadeOut) props.push('audio fades');
      if ((c.media.channels || 0) > 2) props.push('stereo downmix');
    }
    return props;
  }
  const warnings: string[] = [];
  if (!timeline.tracks.some(t => t.clips.some(c => properties(c, t.kind).length)))
    return { timeline, warnings, directory: undefined };
  const directory = await mkdtemp(
    path.join(path.dirname(destination), 'CUT Linked Media-')
  );
  try {
    let index = 0;
    const tracks = [];
    for (const track of timeline.tracks) {
      const clips: ResolvedClip[] = [];
      for (const c of track.clips) {
        const props = properties(c, track.kind);
        if (!props.length) {
          clips.push(c);
          continue;
        }
        signal?.throwIfAborted();
        const label =
          (
            c.name ||
            (c.element
              ? c.element
              : path.basename(c.path, path.extname(c.path)))
          )
            .replace(/[^\p{L}\p{N}_-]+/gu, '-')
            .slice(0, 60) || 'clip';
        const stem = String(++index).padStart(3, '0') + '-' + label;
        const picture = track.kind === 'video',
          file = path.join(directory, stem + (picture ? '.mov' : '.wav'));
        // Premiere carries these controls separately. Resolve companions include them.
        const localClip = {
          ...c,
          id: 'clip',
          at: 0,
          end: c.duration,
          layer: 1,
          opacity: resolve ? c.opacity : 1,
          gain: resolve ? c.gain : 0,
          fadeIn: resolve ? c.fadeIn : 0,
          fadeOut: resolve ? c.fadeOut : 0
        };
        const single = {
          ...timeline,
          duration: c.duration,
          tracks: [{ ...track, layer: 1, clips: [localClip] }]
        };
        await render(single, {
          output: file,
          alpha: picture,
          format: picture ? undefined : 'wav',
          signal,
          formatWhitelist
        });
        const media = await probeMedia(file, signal);
        clips.push({
          ...c,
          ...(resolve ? { opacity: 1, gain: 0, fadeIn: 0, fadeOut: 0 } : {}),
          absolutePath: file,
          path: path.basename(file),
          in: 0,
          out: c.duration,
          media,
          element: undefined,
          x: undefined,
          y: undefined,
          scale: undefined,
          crop: undefined,
          duck: undefined,
          duckRanges: undefined
        });
        warnings.push(
          'Rendered ' +
            props.join(', ') +
            ' for ' +
            label +
            ' on ' +
            (picture ? 'V' : 'A') +
            track.layer +
            '. Its clip placement remains editable.'
        );
      }
      tracks.push({ ...track, clips });
    }
    warnings.push(
      'Keep the companion folder beside the exported project: ' +
        path.basename(directory)
    );
    return { timeline: { ...timeline, tracks }, directory, warnings };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
