import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { MediaInfo, Rational, Tick } from '../core/types';
import { secondsToTicks } from '../core/time';
import { assertNotAborted, runTool, toolPath } from './process';

interface ProbeStream {
  codec_type: string;
  codec_name?: string;
  channels?: number;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  duration?: string;
  duration_ts?: number;
  time_base?: string;
}
interface ProbeData {
  format?: { duration?: string };
  streams?: ProbeStream[];
}
export interface DetailedMediaInfo extends MediaInfo {
  videoDuration?: Tick;
  audioDuration?: Tick;
  videoCodec?: string;
  directCompatible?: boolean;
}
const probeCache = new Map<string, Promise<DetailedMediaInfo>>();
const completedProbeCache = new Map<string, DetailedMediaInfo>();
const signalledProbeCache = new WeakMap<
  AbortSignal,
  Map<string, Promise<DetailedMediaInfo>>
>();
function ratio(value?: string): Rational | undefined {
  if (!value) return undefined;
  const [num, den = 1] = value.split('/').map(Number);
  return num > 0 && den > 0 && Number.isFinite(num / den)
    ? { num, den }
    : undefined;
}
function streamDuration(stream?: ProbeStream): Tick | undefined {
  if (!stream) return undefined;
  const timeBase = ratio(stream.time_base);
  const value =
    stream.duration_ts != null && timeBase
      ? (stream.duration_ts * timeBase.num) / timeBase.den
      : Number(stream.duration);
  return value > 0 && Number.isFinite(value)
    ? secondsToTicks(value)
    : undefined;
}
export async function probeMedia(
  filePath: string,
  signal?: AbortSignal,
  options: { formatWhitelist?: string } = {}
): Promise<DetailedMediaInfo> {
  assertNotAborted(signal);
  const absolute = resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`Not a media file: ${absolute}`);
  const fingerprint = createHash('sha256')
    .update(
      `${absolute}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${toolPath('ffprobe')}\0${options.formatWhitelist || 'any'}`
    )
    .digest('hex');
  const key = `${absolute}:${fingerprint}`;
  const completed = completedProbeCache.get(key);
  if (completed) {
    assertNotAborted(signal);
    return completed;
  }
  // Coalesce repeated references in one compile without sharing its cancellation with another compile.
  let jobs = signal ? signalledProbeCache.get(signal) : probeCache;
  if (!jobs) {
    jobs = new Map();
    signalledProbeCache.set(signal!, jobs);
  }
  let job = jobs.get(key);
  if (!job) {
    job = (async () => {
      const { stdout } = await runTool(
        'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          ...(options.formatWhitelist
            ? ['-format_whitelist', options.formatWhitelist]
            : []),
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          absolute
        ],
        { signal }
      );
      let data: ProbeData;
      try {
        data = JSON.parse(stdout);
      } catch {
        throw new Error(`FFprobe returned invalid metadata for ${absolute}`);
      }
      const video = data.streams?.find(
        (stream) => stream.codec_type === 'video'
      );
      const audio = data.streams?.find(
        (stream) => stream.codec_type === 'audio'
      );
      const videoDuration = streamDuration(video),
        audioDuration = streamDuration(audio);
      const formatDuration = Number(data.format?.duration);
      const duration =
        formatDuration > 0 && Number.isFinite(formatDuration)
          ? secondsToTicks(formatDuration)
          : Math.max(videoDuration || 0, audioDuration || 0);
      const still = !!video && /\.(?:png|jpe?g|webp)$/i.test(absolute);
      if (!still && !(duration > 0))
        throw new Error(
          `Could not determine a finite positive duration for ${absolute}. Use a seekable video or audio file.`
        );
      if (!video && !audio)
        throw new Error(`No video or audio stream in ${absolute}`);
      return {
        path: absolute,
        duration, still,
        hasVideo: !!video,
        hasAudio: !!audio,
        width: video?.width,
        height: video?.height,
        fps: ratio(video?.avg_frame_rate) || ratio(video?.r_frame_rate),
        sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
        channels: audio?.channels,
        fingerprint,
        videoDuration,
        audioDuration,
        videoCodec: video?.codec_name,
        directCompatible:
          !!video &&
          ['h264', 'vp8'].includes(video.codec_name || '') &&
          (!video.sample_aspect_ratio ||
            video.sample_aspect_ratio === '1:1' ||
            video.sample_aspect_ratio === 'N/A') &&
          !Number(video.tags?.rotate || 0) &&
          !(video.side_data_list || []).some((data) => data.rotation) &&
          video.avg_frame_rate === video.r_frame_rate
      };
    })();
    jobs.set(key, job);
    const ownJobs = jobs;
    job
      .then(
        (result) => {
          completedProbeCache.set(key, result);
          if (completedProbeCache.size > 500)
            completedProbeCache.delete(
              completedProbeCache.keys().next().value!
            );
        },
        () => {}
      )
      .finally(() => ownJobs.delete(key));
  }
  return job;
}
export function clearProbeCache(): void {
  probeCache.clear();
  completedProbeCache.clear();
}
