import type { Track } from './types';

/** Bounds sparse UI/XML allocation while allowing a practical number of edit layers. */
export const MAX_LAYERS = 256;

/**
 * Resolve declaration defaults, then group media by its effective numbered layer.
 * The same function drives immediate parser models, resolved timelines and exporters.
 * A clip override changes placement without requiring the user to move its source block.
 */
export function arrangeLayers<T extends Track>(tracks: readonly T[]): T[] {
  const reserved = { video: new Set<number>(), audio: new Set<number>() };
  for (const track of tracks) if (track.layer !== undefined) reserved[track.kind].add(track.layer);
  const next = { video: 1, audio: 1 };
  const groups = { video: new Map<number, T>(), audio: new Map<number, T>() };
  for (const track of tracks) {
    let layer = track.layer;
    if (layer === undefined) {
      while (reserved[track.kind].has(next[track.kind])) next[track.kind]++;
      layer = next[track.kind]++;
      reserved[track.kind].add(layer);
    }
    const add = (number: number, clips: T['clips']) => {
      const existing = groups[track.kind].get(number);
      if (existing) {
        if (existing.name !== track.name && !existing.name.split(' + ').includes(track.name)) existing.name += ` + ${track.name}`;
        existing.clips.push(...clips);
      } else groups[track.kind].set(number, { ...track, id: `${track.kind}-layer-${number}`, layer: number, clips: [...clips] } as T);
    };
    add(layer, []);
    for (const clip of track.clips) {
      const effective = clip.layer ?? layer;
      add(effective, [{ ...clip, layer: effective }]);
    }
  }
  const result: T[] = [];
  for (const kind of ['video', 'audio'] as const) {
    const entries = groups[kind];
    const maximum = Math.max(0, ...entries.keys());
    const first = entries.values().next().value;
    if (!first) continue;
    for (let layer = 1; layer <= maximum; layer++) {
      result.push(entries.get(layer) ?? { ...first, id: `${kind}-layer-${layer}`, kind, layer, name: 'Empty layer', clips: [] } as T);
    }
  }
  return result;
}
