import { quantizeToFrame } from './time';
import type { Clip, Diagnostic, Film } from './types';

export interface PlacedItem extends Clip {
  duration: number;
  end: number;
}

/** Resolve authored references after source durations and frame-accurate trims are known. */
export function placeItems(
  items: { item: PlacedItem; picture: boolean }[],
  film: Film,
  diagnostics: Diagnostic[]
) {
  const named = new Map<string, (typeof items)[number]>();
  const resolved = new Set<PlacedItem>();
  const issue = (item: Clip, message: string) =>
    diagnostics.push({
      severity: 'error',
      code: 'TIMING_LINK',
      message,
      range: item.fields.at || item.range
    });
  for (const entry of items) {
    const name = entry.item.name;
    if (!name) continue;
    if (named.has(name))
      issue(entry.item, 'Shot or scene name is used more than once: ' + name);
    else named.set(name, entry);
  }
  // Walk iteratively so a long chain of cuts does not exhaust the call stack.
  for (const entry of items) {
    const chain: typeof items = [];
    const seen = new Set<PlacedItem>();
    let cursor: (typeof items)[number] | undefined = entry;
    while (cursor && !resolved.has(cursor.item)) {
      const item: PlacedItem = cursor.item;
      if (seen.has(item)) {
        issue(item, 'Circular timing link involving ' + (item.name || item.id));
        break;
      }
      seen.add(item);
      chain.push(cursor);
      if (!item.link) break;
      cursor = named.get(item.link.target);
      if (!cursor)
        issue(
          item,
          'Unknown shot or scene in timing link: ' + item.link.target
        );
    }
    for (const { item, picture } of chain.reverse()) {
      const ref = item.link && named.get(item.link.target)?.item;
      if (ref && item.link) {
        const time =
          (item.link.edge === 'end' ? ref.end : ref.at) + item.link.offset;
        if (!Number.isSafeInteger(time) || time < 0)
          issue(item, 'Linked placement falls outside the film timeline.');
        else item.at = picture ? quantizeToFrame(time, film.fps) : time;
      }
      item.end = item.at + item.duration;
      if (!Number.isSafeInteger(item.end))
        issue(item, 'Linked clip end exceeds the supported timeline.');
      resolved.add(item);
    }
  }
}
