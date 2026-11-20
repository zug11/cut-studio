import { createHash } from 'node:crypto';
import { access, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { PreviewResult, RenderProgress, Tick, Timeline } from '../core/types';
import { secondsToTicks } from '../core/time';
import { assertNotAborted, toolPath } from './process';
import { render, renderRange } from './render';
import type { DetailedMediaInfo } from './probe';

export interface PreviewOptions {
  cacheDir: string;
  formatWhitelist?: string;
  from?: Tick;
  to?: Tick;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  format?: 'mp4' | 'webm';
  audioCodec?: 'aac' | 'mp3';
}
/** Cache keys include every edit plus media fingerprints and renderer settings. */
export async function renderPreview(timeline: Timeline, options: PreviewOptions): Promise<PreviewResult> {
  assertNotAborted(options.signal);
  const desiredTo = options.to ?? Math.min(timeline.duration, (options.from || 0) + secondsToTicks(8));
  // Preserve an audio tail shorter than half a video frame by padding the last output frame.
  const range = renderRange(timeline, {
    from: options.from,
    to: desiredTo >= timeline.duration ? undefined : desiredTo
  });
  const format = options.format || 'webm';
  const key = createHash('sha256')
    .update(
      `cut-proxy-4-framing\0${timeline.hash}\0${range.from}\0${range.to}\0${format}\0${options.audioCodec || 'aac'}\0${toolPath('ffmpeg')}`
    )
    .digest('hex');
  const path = join(resolve(options.cacheDir), `${key}.${format}`);
  try {
    await access(path);
    assertNotAborted(options.signal);
    return { path, ...range, hash: timeline.hash, cached: true };
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }
  await render(timeline, {
    ...range,
    output: path,
    preview: true,
    formatWhitelist: options.formatWhitelist,
    format,
    audioCodec: options.audioCodec,
    signal: options.signal,
    onProgress: options.onProgress
  });
  return { path, ...range, hash: timeline.hash, cached: false };
}
/** Optional explicit housekeeping; never touches source media or final exports. */
export async function prunePreviewCache(cacheDir: string, maximumBytes = 512 * 1024 * 1024): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  const entries = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.(?:webm|mp4)$/.test(name))
      .map(async (name) => {
        const path = join(cacheDir, name);
        const info = await stat(path);
        return { path, size: info.size, time: info.mtimeMs };
      })
  );
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.time - b.time)) {
    if (total <= maximumBytes) break;
    await rm(entry.path, { force: true });
    total -= entry.size;
  }
}

/** Direct source playback is deliberately restricted to a composition with no mixing or transforms.
 * The monitor must mute it: audio is always opt-in through CUT audio tracks.
 */
export function findDirectPreview(
  timeline: Timeline,
  options: { from?: Tick; to?: Tick } = {}
): PreviewResult | undefined {
  if (timeline.tracks.some((track) => track.kind === 'audio' && track.clips.length)) return;
  const clips = timeline.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips);
  if (clips.length !== 1) return;
  const clip = clips[0],
    media = clip.media as DetailedMediaInfo;
  if (
    clip.element || clip.x || clip.y || clip.crop || (clip.scale ?? 1) !== 1 || clip.media.still ||
    clip.at !== 0 ||
    clip.opacity !== 1 ||
    clip.duration !== timeline.duration ||
    !media.directCompatible ||
    !media.fps
  )
    return;
  if (!['.mp4', '.m4v', '.webm'].includes(extname(clip.absolutePath).toLowerCase())) return;
  if (
    media.width !== timeline.resolution.width ||
    media.height !== timeline.resolution.height ||
    BigInt(media.fps.num) * BigInt(timeline.fps.den) !== BigInt(timeline.fps.num) * BigInt(media.fps.den)
  )
    return;
  const range = renderRange(timeline, options);
  // Padding a final partial video frame needs a proxy, not direct playback.
  if (range.to > clip.duration) return;
  return {
    path: clip.absolutePath,
    ...range,
    hash: timeline.hash,
    cached: false,
    direct: true,
    sourceIn: clip.in + range.from
  };
}
