import type { Timeline, ResolvedClip } from './types';

export function renderedProperties(c: ResolvedClip) {
  const values: string[] = [];
  if (c.element) values.push(c.element);
  else if (c.media.still) values.push('still image');
  if (c.x || c.y) values.push('position');
  if (c.crop?.some((n) => n !== 0)) values.push('crop');
  if ((c.scale ?? 1) !== 1) values.push('scale');
  if (c.duck && c.duckRanges?.length) values.push('dialogue ducking');
  return values;
}
export function premierePlan(timeline: Timeline) {
  const clips = timeline.tracks.flatMap((track) =>
    track.clips.map((c) => ({
      clip: c.name || c.path,
      layer: (track.kind === 'audio' ? 'A' : 'V') + track.layer,
      properties: renderedProperties(c)
    }))
  );
  return {
    native: [
      'cuts',
      'timeline placement',
      'video and audio layers',
      'opacity',
      'audio gain and fades'
    ],
    editable: clips.filter((c) => !c.properties.length).length,
    rendered: clips.filter((c) => c.properties.length)
  };
}
