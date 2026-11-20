import { describe, it, expect } from 'vitest';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { exportFcp7, fcp7Exporter } from '../src/exporters/fcp7';
import { secondsToTicks as t } from '../src/core/time';
import type { Timeline, ResolvedClip } from '../src/core/types';

const range = { start: { offset: 0, line: 0, column: 0 }, end: { offset: 10, line: 0, column: 10 } };
function fixture(): Timeline {
  const clip: ResolvedClip = {
    id: 'c1',
    path: 'assets/a & b.mp4',
    absolutePath: '/tmp/CUT & film/a & b.mp4',
    in: t(1),
    out: t(3),
    at: t(4),
    duration: t(2),
    end: t(6),
    opacity: 1,
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
    range,
    fields: {},
    media: {
      path: '/tmp/CUT & film/a & b.mp4',
      duration: t(8),
      hasVideo: true,
      hasAudio: true,
      fps: { num: 24, den: 1 },
      sampleRate: 48000,
      fingerprint: 'test'
    }
  };
  return {
    name: 'A & B <film>',
    resolution: { width: 1920, height: 1080 },
    fps: { num: 24, den: 1 },
    range,
    duration: t(6),
    filePath: '/tmp/film.cut',
    hash: 'fixture',
    tracks: [{ id: 'v1', kind: 'video', name: 'Picture', range, clips: [clip] }]
  };
}

describe('FCP 7 XML exporter', () => {
  it('preserves explicit video/audio layer gaps and canonical order in XML', () => {
    const timeline = fixture();
    const clip = timeline.tracks[0].clips[0];
    timeline.tracks = [
      { id: 'top', kind: 'video', name: 'Top', layer: 3, range, clips: [{ ...clip, path: 'top.mp4' }] },
      { id: 'music', kind: 'audio', name: 'Music', layer: 3, range, clips: [{ ...clip, media: { ...clip.media, channels: 1 } }] },
      { id: 'bottom', kind: 'video', name: 'Bottom', layer: 1, range, clips: [{ ...clip, path: 'bottom.mp4' }] },
      { id: 'stereo', kind: 'audio', name: 'Stereo', layer: 1, range, clips: [{ ...clip, media: { ...clip.media, channels: 2 } }] }
    ];
    const result = exportFcp7(timeline);
    expect(XMLValidator.validate(result.xml)).toBe(true);
    const media = new XMLParser().parse(result.xml).xmeml.sequence.media;
    expect(media.video.track).toHaveLength(3);
    expect(media.video.track[0].clipitem.name).toBe('bottom.mp4');
    expect(media.video.track[1].clipitem).toBeUndefined();
    expect(media.video.track[2].clipitem.name).toBe('top.mp4');
    expect(media.audio.track).toHaveLength(4);
    expect(media.audio.track[1].clipitem).toBeUndefined();
    expect(media.audio.track[2].clipitem.file.media.audio.channelcount).toBe(1);
    expect(media.audio.track[3].clipitem.sourcetrack.trackindex).toBe(2);
  });
  it('exports well-formed XML with editable source trims and timeline positions', () => {
    const { xml, warnings } = exportFcp7(fixture());
    expect(XMLValidator.validate(xml)).toBe(true);
    const tree = new XMLParser().parse(xml);
    const seq = tree.xmeml.sequence;
    expect(seq.name).toBe('A & B <film>');
    expect(seq.duration).toBe(144);
    const clip = seq.media.video.track.clipitem;
    expect(clip.start).toBe(96);
    expect(clip.end).toBe(144);
    expect(clip.in).toBe(24);
    expect(clip.out).toBe(72);
    expect(clip.duration).toBe(192);
    expect(clip.file.duration).toBe(192);
    expect(clip.file.pathurl).toBe('file:///tmp/CUT%20&%20film/a%20&%20b.mp4');
    expect(warnings).toEqual([]);
  });
  it('reports effects and audio precision that do not transfer', () => {
    const timeline = fixture();
    timeline.tracks[0].clips[0].opacity = 0.5;
    const clip = {
      ...timeline.tracks[0].clips[0],
      gain: -6,
      fadeIn: t(0.5),
      media: { ...timeline.tracks[0].clips[0].media, channels: 1 }
    };
    timeline.tracks.push({ id: 'a1', name: 'Music', kind: 'audio', range, clips: [clip] });
    const exported = exportFcp7(timeline);
    expect(exported.warnings.join(' ')).toMatch(/Opacity/);
    expect(exported.warnings.join(' ')).toMatch(/gain and fades/);
    expect(exported.warnings.join(' ')).toMatch(/sample-accurate/);
    expect(
      new XMLParser().parse(exported.xml).xmeml.sequence.media.audio.track.clipitem.sourcetrack.mediatype
    ).toBe('audio');
  });
  it('preserves rational NTSC rates without decimal approximations', () => {
    const timeline = fixture();
    timeline.fps = { num: 24000, den: 1001 };
    timeline.tracks[0].clips[0].media.fps = timeline.fps;
    const { xml } = exportFcp7(timeline);
    expect(xml).toContain('<timebase>24</timebase><ntsc>TRUE</ntsc>');
  });
  it('refuses unsupported interchange frame rates rather than mislabelling them', () => {
    const timeline = fixture();
    timeline.fps = { num: 29, den: 2 };
    expect(() => exportFcp7(timeline)).toThrow(/cannot represent/);
  });
  it('implements the independent exporter contract', () => {
    expect(fcp7Exporter.extension).toBe('.xml');
    expect(fcp7Exporter.export(fixture()).contents).toContain('<xmeml version="5">');
  });
  it('uses DTD-supported channel counts and preserves source mono/stereo channels', () => {
    const timeline = fixture();
    const clip = {
      ...timeline.tracks[0].clips[0],
      media: { ...timeline.tracks[0].clips[0].media, channels: 2 }
    };
    timeline.tracks.push({ id: 'a1', name: 'Stereo', kind: 'audio', range, clips: [clip] });
    const result = exportFcp7(timeline);
    expect(result.xml).not.toContain('numOutputChannels');
    const audio = new XMLParser().parse(result.xml).xmeml.sequence.media.audio;
    expect(audio.channelcount).toBe(2);
    expect(audio.track).toHaveLength(2);
    expect(audio.track[0].clipitem.file.media.audio.channelcount).toBe(2);
    expect(audio.track[0].clipitem.sourcetrack.trackindex).toBe(1);
    expect(audio.track[1].clipitem.sourcetrack.trackindex).toBe(2);
    expect(audio.track[0].clipitem.link).toHaveLength(2);
    clip.media.channels = 1;
    const mono = new XMLParser().parse(exportFcp7(timeline).xml).xmeml.sequence.media.audio;
    expect(mono.track.clipitem.file.media.audio.channelcount).toBe(1);
  });
  it('warns when scaling or letterboxing must be recreated and rejects unrepresentable short audio', () => {
    const timeline = fixture();
    timeline.tracks[0].clips[0].media.width = 640;
    timeline.tracks[0].clips[0].media.height = 480;
    expect(exportFcp7(timeline).warnings.join(' ')).toMatch(/scaling and letterboxing/);
    const clip = {
      ...timeline.tracks[0].clips[0],
      in: 0,
      out: t(0.001),
      duration: t(0.001),
      at: 0,
      end: t(0.001),
      media: { ...timeline.tracks[0].clips[0].media, channels: 1 }
    };
    timeline.tracks.push({ id: 'a1', name: 'Too short', kind: 'audio', range, clips: [clip] });
    expect(() => exportFcp7(timeline)).toThrow(/shorter than one interchange frame/);
  });
});
