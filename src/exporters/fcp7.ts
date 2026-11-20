import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Rational, ResolvedClip, Timeline } from '../core/types';
import { framesCovering, ticksToFrame } from '../core/time';
import type { TimelineExporter } from './index';
import { arrangeLayers } from '../core/layers';

function xml(value: unknown): string {
  const text = String(value);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(text))
    throw new Error(
      'A film, track or media name contains a control character that XML cannot represent. Rename it before exporting.'
    );
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!
  );
}
function rate(fps: Rational): string {
  const exact = fps.num / fps.den;
  const timebase = Math.round(exact);
  if (Math.abs(exact - timebase) < 1e-9)
    return `<rate><timebase>${timebase}</timebase><ntsc>FALSE</ntsc></rate>`;
  if (Math.abs(exact - (timebase * 1000) / 1001) < 1e-9)
    return `<rate><timebase>${timebase}</timebase><ntsc>TRUE</ntsc></rate>`;
  throw new Error(
    `FCP 7 XML cannot represent ${fps.num}/${fps.den} fps exactly. Use an integer or standard 1000/1001 frame rate.`
  );
}

export function exportFcp7(timeline: Timeline): { xml: string; warnings: string[] } {
  const warnings = new Set<string>();
  for (const clip of timeline.tracks.flatMap(t=>t.clips)) {
    if (clip.element === 'title' || clip.element === 'caption') throw new Error('For titles and captions, export a Premiere project with rendered graphics or an MP4.');
    if (clip.x || clip.y || clip.crop || clip.scale !== undefined || clip.duck) warnings.add('FCP 7 XML omits CUT framing and dialogue ducking. Premiere project export can render those layers.');
  }
  const sequenceRate = rate(timeline.fps);
  const sequenceFrames = framesCovering(timeline.duration, timeline.fps);
  const { width, height } = timeline.resolution;
  const orderedTracks = arrangeLayers(timeline.tracks);
  let fileIndex = 0;
  function channelCount(clip: ResolvedClip): number {
    if (!Number.isSafeInteger(clip.media.channels) || !clip.media.channels || clip.media.channels < 1) {
      warnings.add(
        'Source audio channel count is unavailable. The XML assumes mono; verify channel routing in the receiving editor.'
      );
      return 1;
    }
    if (clip.media.channels > 64)
      throw new Error(
        'FCP 7 XML export supports up to 64 source audio channels. Bake this audio mix before interchange.'
      );
    return clip.media.channels;
  }
  function file(clip: ResolvedClip, kind: 'video' | 'audio', mediaFps: Rational): string {
    const mediaRate = rate(mediaFps);
    const duration = framesCovering(clip.media.duration, mediaFps);
    const video =
      kind === 'video'
        ? `<video><samplecharacteristics>${mediaRate}<width>${clip.media.width || width}</width><height>${clip.media.height || height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`
        : '';
    const audio =
      kind === 'audio'
        ? `<audio><samplecharacteristics><samplerate>${clip.media.sampleRate || 48000}</samplerate></samplecharacteristics><channelcount>${channelCount(clip)}</channelcount></audio>`
        : '';
    return `<file id="file-${++fileIndex}"><name>${xml(path.basename(clip.path))}</name><pathurl>${xml(pathToFileURL(clip.absolutePath).href)}</pathurl>${mediaRate}<duration>${duration}</duration><media>${video}${audio}</media></file>`;
  }
  function clipItem(
    clip: ResolvedClip,
    kind: 'video' | 'audio',
    sourceChannel = 1,
    id?: string,
    links = ''
  ): string {
    const sourceFps = kind === 'video' ? clip.media.fps || timeline.fps : timeline.fps;
    if (kind === 'video' && clip.opacity !== 1)
      warnings.add(
        'Opacity is not exported. Bake translucent video layers with cut render before interchange.'
      );
    if (kind === 'audio' && (clip.gain !== 0 || clip.fadeIn !== 0 || clip.fadeOut !== 0))
      warnings.add(
        'Audio gain and fades are not exported. Bake the audio mix with cut render when those effects must match.'
      );
    if (kind === 'audio')
      warnings.add(
        'FCP 7 XML audio boundaries are rounded to sequence frames; sample-accurate audio trims require baking.'
      );
    if (kind === 'video' && sourceFps.num * timeline.fps.den !== timeline.fps.num * sourceFps.den)
      warnings.add(
        'Mixed source frame rates are described in XML; verify their conform and trim points in the receiving editor.'
      );
    if (
      kind === 'video' &&
      clip.media.width &&
      clip.media.height &&
      (clip.media.width !== width || clip.media.height !== height)
    )
      warnings.add(
        'CUT scaling and letterboxing are not exported. Source dimensions are preserved; match framing in the receiving editor or bake the video with cut render.'
      );
    const sourceIn = ticksToFrame(clip.in, sourceFps);
    const sourceOut = ticksToFrame(clip.out, sourceFps);
    const start = ticksToFrame(clip.at, timeline.fps),
      end = ticksToFrame(clip.end, timeline.fps);
    if (sourceOut <= sourceIn || end <= start)
      throw new Error(
        `“${clip.path}” is shorter than one interchange frame after rounding. Bake the composition before XML export.`
      );
    // XMEML duration is the full source length, not the selected in/out span.
    const duration = Math.max(sourceOut, framesCovering(clip.media.duration, sourceFps));
    // Apple's importer warns against a trackindex on a single silent video stream.
    const index = kind === 'video' && !clip.media.hasAudio ? '' : `<trackindex>${sourceChannel}</trackindex>`;
    return `<clipitem id="${id || `clip-${fileIndex + 1}`}"><name>${xml(path.basename(clip.path))}</name><enabled>TRUE</enabled><duration>${duration}</duration>${rate(sourceFps)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio>${file(clip, kind, sourceFps)}<sourcetrack><mediatype>${kind}</mediatype>${index}</sourcetrack>${links}</clipitem>`;
  }
  const videoTracks = orderedTracks
    .filter((track) => track.kind === 'video')
    .map(
      (track) =>
        `<track><!-- V${track.layer} ${xml(track.name).replace(/--/g, '—')} -->${track.clips.map((clip) => clipItem(clip, 'video')).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`
    )
    .join('');
  // FCP 7 represents source audio channels as separate tracks. Export each channel so
  // stereo source files never silently lose their right channel. Keep pairs linked.
  const auxiliaryAudioTracks: string[] = [];
  const audioTracks = orderedTracks
    .filter((track) => track.kind === 'audio')
    .map((track, trackIndex) => {
      const counts = track.clips.map(channelCount);
      const maximum = Math.max(1, ...counts);
      if (maximum > 2)
        warnings.add(
          'Multichannel audio is expanded to separate XML tracks. CUT’s stereo downmix is not baked; verify routing in the receiving editor.'
        );
      const channels = Array.from({ length: maximum }, (_, channel) => {
        const clips = track.clips
          .map((clip, clipIndex) => {
            if (channel >= counts[clipIndex]) return '';
            const ids = Array.from(
              { length: counts[clipIndex] },
              (_, index) => `audio-${trackIndex}-${clipIndex}-${index}`
            );
            const links =
              ids.length > 1 ? ids.map((id) => `<link><linkclipref>${id}</linkclipref></link>`).join('') : '';
            return clipItem(clip, 'audio', channel + 1, ids[channel], links);
          })
          .join('');
        const output = maximum === 2 ? `<outputchannelindex>${channel + 1}</outputchannelindex>` : '';
        return `<track><!-- A${track.layer} ${xml(track.name).replace(/--/g, '—')}${maximum > 1 ? ` · channel ${channel + 1}` : ''} -->${clips}<enabled>TRUE</enabled><locked>FALSE</locked>${output}</track>`;
      });
      // Preserve the user's numbered audio lanes. Extra source channels occupy
      // auxiliary lanes after all primary CUT layers rather than shifting A2/A3.
      auxiliaryAudioTracks.push(...channels.slice(1));
      return channels[0];
    })
    .join('') + auxiliaryAudioTracks.join('');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="cut-sequence"><name>${xml(timeline.name)}</name><duration>${sequenceFrames}</duration>${sequenceRate}<timecode>${sequenceRate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${sequenceRate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${videoTracks}</video><audio><channelcount>2</channelcount><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audioTracks}</audio></media></sequence></xmeml>\n`;
  return { xml: contents, warnings: [...warnings] };
}

export const fcp7Exporter: TimelineExporter = {
  id: 'fcp7',
  extension: '.xml',
  export: (timeline) => {
    const result = exportFcp7(timeline);
    return { contents: result.xml, warnings: result.warnings };
  }
};
