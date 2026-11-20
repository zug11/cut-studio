import path from 'node:path';
import * as z from 'zod/v4';
import { frameToTicks, parseTime, quantizeToFrame } from '../core/time';
import type { Clip, Film, ResolvedClip, Timeline } from '../core/types';
import { ffmpegSeconds } from '../engine/render';

const key = z.string().min(1).max(256);
const position = z.string().min(1).max(160);
const alias = z.string().regex(/^[A-Za-z_][\w-]*$/);
const relative = z.string().min(1).max(4096);
const lane = z.string().regex(/^[VA](?:[1-9]\d*)$/);
const picture = z
  .object({
    x: z.number().int().min(-32768).max(32768).optional(),
    y: z.number().int().min(-32768).max(32768).optional(),
    scale: z.number().positive().max(8).optional(),
    crop: z
      .tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative()
      ])
      .optional(),
    opacity: z.number().min(0).max(1).optional(),
    gain: z.number().min(-96).max(15).optional(),
    duck: z
      .object({
        layer: z.number().int().min(1).max(256),
        db: z.number().min(-96).max(-0.01)
      })
      .nullable()
      .optional(),
    fadeIn: position.optional(),
    fadeOut: position.optional()
  })
  .strict();
export const editSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('trim'),
      target: key,
      edge: z.enum(['in', 'out']),
      frames: z.number().int().min(-10000000).max(10000000)
    })
    .strict(),
  z.object({ op: z.literal('split'), target: key, at: position }).strict(),
  z
    .object({
      op: z.literal('place'),
      target: key,
      at: position.optional(),
      layer: z.number().int().min(1).max(256).optional(),
      name: alias.optional()
    })
    .strict(),
  z.object({ op: z.literal('swap'), target: key, asset: relative }).strict(),
  z
    .object({
      op: z.literal('close_gap'),
      target: key,
      lanes: z.array(lane).min(1).max(512)
    })
    .strict(),
  z.object({ op: z.literal('effects'), target: key, values: picture }).strict(),
  z
    .object({
      op: z.literal('insert'),
      kind: z.enum(['video', 'audio', 'title', 'caption', 'scene']),
      value: z.string().min(1).max(4096),
      name: alias.optional(),
      layer: z.number().int().min(1).max(256).optional(),
      at: position,
      in: position.optional(),
      out: position.optional()
    })
    .strict()
]);
export type EditOperation = z.infer<typeof editSchema>;
type Change = { from: number; to: number; insert: string };
const stamp = (ticks: number) => ffmpegSeconds(ticks).replace(/\.?0+$/, '') + 's';
const fieldNames: Record<string, string> = {
  fadeIn: 'fade_in',
  fadeOut: 'fade_out'
};
const laneOf = (kind: string, layer: number | undefined) =>
  (kind === 'video' ? 'V' : 'A') + (layer || 1);
function uniqueName(base: string, names: Set<string>) {
  let name = base,
    n = 2;
  while (names.has(name)) name = base + '_' + n++;
  return name;
}
function placement(input: string, fps: Film['fps']) {
  const text = input.trim();
  if (/^after [A-Za-z_][\w-]*(?: [+-] [\w:.]+)?$/.test(text)) return text;
  if (/^[A-Za-z_][\w-]*\.(start|end)(?: [+-] [\w:.]+)?$/.test(text))
    return 'at ' + text;
  parseTime(text, fps);
  return 'at ' + text;
}
function formatLink(link: NonNullable<Clip['link']>, delta = link.offset) {
  return (
    'at ' +
    link.target +
    '.' +
    link.edge +
    (delta ? (delta < 0 ? ' - ' : ' + ') + stamp(Math.abs(delta)) : '')
  );
}
function effectsOf(c: Clip) {
  const result: string[] = [];
  for (const k of [
    'x',
    'y',
    'scale',
    'opacity',
    'gain',
    'crop',
    'duck',
    'fadeIn',
    'fadeOut'
  ] as const) {
    const v = c[k];
    if (
      v === undefined ||
      (k === 'opacity' && v === 1) ||
      (k !== 'scale' && v === 0)
    )
      continue;
    result.push((fieldNames[k] || k) + ' ' + effectValue(k, v));
  }
  return result.join(' ');
}
function effectValue(key: string, value: unknown) {
  if (key === 'duck') {
    const d = value as NonNullable<Clip['duck']>;
    return 'A' + d.layer + ' ' + d.db + 'dB';
  }
  if (key === 'gain') return value + 'dB';
  if (key === 'crop') return (value as number[]).join(',');
  if ((key === 'fadeIn' || key === 'fadeOut') && typeof value === 'number')
    return stamp(value);
  return String(value);
}

/** Changes use parser token ranges. Formatting, comments, and unrelated declarations survive an edit. */
export function proposeEdit(
  source: string,
  film: Film,
  timeline: Timeline | undefined,
  op: EditOperation,
  documentPath: string
) {
  const changes: Change[] = [];
  const entries = film.tracks.flatMap((t) =>
    t.clips.map((c) => ({ c, kind: t.kind }))
  );
  const all = [...entries.map((e) => e.c), ...(film.scenes || [])];
  const names = new Set(all.flatMap((c) => (c.name ? [c.name] : [])));
  const quote = JSON.stringify;
  const asset = (value: string) => {
    if (
      path.isAbsolute(value) ||
      value.includes('\\') ||
      value.includes('\u0000') ||
      value.split('/').includes('..')
    )
      throw new Error('Choose a project-relative asset path.');
    return path.posix.relative(path.posix.dirname(documentPath), value);
  };
  const replace = (from: number, to: number, insert: string) =>
    changes.push({ from, to, insert });
  const addField = (c: Clip, text: string) => {
    const end = c.range.end.offset,
      block = source[end - 1] === '}';
    const at = block ? end - 1 : end;
    replace(at, at, ' ' + text + (block ? ' ' : ''));
  };
  const set = (c: Clip, field: keyof Clip['fields'], value: string) => {
    const range = c.fields[field];
    if (range) replace(range.start.offset, range.end.offset, value);
    else addField(c, (fieldNames[field] || field) + ' ' + value);
  };
  const setPosition = (c: Clip, text: string) => {
    const r = c.statements?.at;
    if (r) replace(r.start.offset, r.end.offset, text);
    else addField(c, text);
  };
  const filmEnd = film.range.end.offset - 1;
  if (op.op === 'insert') {
    const name = op.name ? ' as ' + op.name : '';
    if (op.name && names.has(op.name))
      throw new Error('This shot or scene name already exists.');
    const at = placement(op.at, film.fps);
    const visualText = op.kind === 'title' || op.kind === 'caption';
    const item = op.kind === 'scene' ? 'scene' : visualText ? op.kind : 'clip';
    const value = visualText ? op.value : asset(op.value);
    const trim = [op.in ? 'in ' + op.in : '', op.out ? 'out ' + op.out : '']
      .filter(Boolean)
      .join(' ');
    const declaration =
      item +
      ' ' +
      quote(value) +
      name +
      ' { ' +
      [trim, at].filter(Boolean).join(' ') +
      ' }';
    if (op.kind === 'scene')
      replace(filmEnd, filmEnd, '\n  ' + declaration + '\n');
    else {
      const kind = op.kind === 'audio' ? 'audio' : 'video',
        layer = op.layer || 1;
      const label =
        film.tracks.find((t) => t.kind === kind && t.layer === layer)?.name ||
        (kind === 'video' ? 'Picture' : 'Sound');
      replace(
        filmEnd,
        filmEnd,
        '\n  track ' +
          kind +
          ' ' +
          quote(label) +
          ' layer ' +
          layer +
          ' {\n    ' +
          declaration +
          '\n  }\n'
      );
    }
  } else {
    const c =
      all.find((c) => c.name === op.target) ||
      all.find((c) => c.id === op.target);
    if (!c)
      throw new Error(
        'Choose a clip or scene in this document. To edit inside a scene, open its CUT file.'
      );
    const resolved = timeline?.tracks
      .flatMap((t) => t.clips)
      .find((r) => r.id === c.id);
    const kind = entries.find((e) => e.c === c)?.kind;
    switch (op.op) {
      case 'swap': {
        if (c.element === 'title' || c.element === 'caption')
          throw new Error('Choose a media clip or scene to swap.');
        set(c, 'path', quote(asset(op.asset)));
        break;
      }
      case 'place': {
        if (op.name && c.name !== op.name) {
          if (names.has(op.name))
            throw new Error('This name is already in use.');
          if (c.fields.name) {
            set(c, 'name', op.name);
            for (const follower of all)
              if (follower.link?.target === c.name && c.name)
                setPosition(
                  follower,
                  formatLink({ ...follower.link!, target: op.name })
                );
          } else
            replace(
              c.fields.path!.end.offset,
              c.fields.path!.end.offset,
              ' as ' + op.name
            );
        }
        if (op.at) setPosition(c, placement(op.at, film.fps));
        if (op.layer !== undefined) set(c, 'layer', String(op.layer));
        break;
      }
      case 'effects':
        for (const [field, value] of Object.entries(op.values)) {
          if (value === null && field === 'duck') {
            const r = c.statements?.duck;
            if (r) replace(r.start.offset, r.end.offset, '');
          } else
            set(c, field as keyof Clip['fields'], effectValue(field, value));
        }
        break;
      case 'trim': {
        if (!resolved) throw new Error('Check the film before trimming.');
        const next = resolved[op.edge] + frameToTicks(op.frames, film.fps);
        if (next < 0) throw new Error('Trim would start before the source.');
        set(c, op.edge, stamp(next));
        break;
      }
      case 'split': {
        if (!resolved) throw new Error('Check the film before splitting.');
        const time = parseTime(op.at, film.fps),
          cut = kind === 'video' ? quantizeToFrame(time, film.fps) : time;
        const left = cut - resolved.at,
          right = resolved.end - cut;
        if (left <= 0 || right <= 0)
          throw new Error('Split inside the selected clip.');
        if (left < c.fadeIn || right < c.fadeOut)
          throw new Error(
            'Split outside the active fade, or shorten that fade first.'
          );
        const first = c.name || uniqueName('shot', names);
        names.add(first);
        const tail = uniqueName(first + '_tail', names);
        if (!c.name)
          replace(
            c.fields.path!.end.offset,
            c.fields.path!.end.offset,
            ' as ' + first
          );
        set(c, 'out', stamp(resolved.in + left));
        if (c.fadeOut) set(c, 'fadeOut', '0s');
        const properties = effectsOf({ ...c, fadeIn: 0 });
        const second =
          (c.element || 'clip') +
          ' ' +
          quote(c.path) +
          ' as ' +
          tail +
          ' { in ' +
          stamp(resolved.in + left) +
          ' out ' +
          stamp(resolved.out) +
          ' after ' +
          first +
          ' layer ' +
          resolved.layer +
          (properties ? ' ' + properties : '') +
          ' }';
        // Keep a trailing line comment on the original clip from swallowing the new declaration.
        replace(
          c.range.end.offset,
          c.range.end.offset,
          '\n    ' + second + '\n'
        );
        if (c.name)
          for (const follower of all)
            if (
              follower.link?.target === c.name &&
              follower.link.edge === 'end'
            )
              setPosition(
                follower,
                formatLink({ ...follower.link, target: tail })
              );
        break;
      }
      case 'close_gap': {
        if (!resolved || !timeline || !kind)
          throw new Error('Choose a clip following a gap.');
        const lane = timeline.tracks.find(
          (t) => t.kind === kind && t.layer === resolved.layer
        )!;
        if (!op.lanes.includes(laneOf(kind, lane.layer)))
          throw new Error('Include the selected clip’s layer.');
        const previousEnd = Math.max(
          0,
          ...lane.clips.filter((r) => r.end <= resolved.at).map((r) => r.end)
        );
        const gap = resolved.at - previousEnd;
        if (gap <= 0) throw new Error('There is no gap before this clip.');
        const moving = new Set<string>();
        for (const track of timeline.tracks.filter((t) =>
          op.lanes.includes(laneOf(t.kind, t.layer))
        ))
          for (const r of track.clips) {
            if (r.at < resolved.at && r.end > previousEnd)
              throw new Error(
                'There is media in this gap on another selected layer.'
              );
            if (r.at >= resolved.at) {
              if (r.sceneId)
                throw new Error(
                  'Move the containing scene or close its internal gaps in its own file.'
                );
              moving.add(r.id);
            }
          }
        const named = new Map(
          all.filter((item) => item.name).map((item) => [item.name!, item])
        );
        for (const item of all) {
          const delta = moving.has(item.id) ? -gap : 0;
          if (item.link) {
            const parent = named.get(item.link.target);
            const parentDelta = parent && moving.has(parent.id) ? -gap : 0;
            if (delta !== parentDelta)
              setPosition(
                item,
                formatLink(item.link, item.link.offset + delta - parentDelta)
              );
          } else if (delta) setPosition(item, 'at ' + stamp(item.at + delta));
        }
        break;
      }
    }
  }
  // Apply insertions at a shared boundary in their construction order.
  const sorted = changes.sort((a, b) => a.from - b.from || a.to - b.to);
  let end = 0,
    result = '';
  for (const change of sorted) {
    if (change.from < end)
      throw new Error(
        'The edit touches overlapping parts of this declaration.'
      );
    result += source.slice(end, change.from) + change.insert;
    end = change.to;
  }
  return { source: result + source.slice(end), changes: sorted };
}

/** Express a batch as one replacement against the original document for editors and undo. */
export function batchSourceChange(before: string, after: string): Change[] {
  let from = 0;
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from++;
  let left = before.length,
    right = after.length;
  while (left > from && right > from && before[left - 1] === after[right - 1]) {
    left--;
    right--;
  }
  return left === from && right === from
    ? []
    : [{ from, to: left, insert: after.slice(from, right) }];
}

function namedTimings(timeline?: Timeline) {
  const map = new Map<
    string,
    { at: number; end: number; layer?: string; in?: number; out?: number }
  >();
  if (timeline) {
    for (const track of timeline.tracks)
      for (const clip of track.clips) {
        if (clip.name && !clip.sceneId)
          map.set(clip.name, {
            at: clip.at,
            end: clip.end,
            layer: laneOf(track.kind, clip.layer),
            in: clip.in,
            out: clip.out
          });
      }
    for (const scene of timeline.scenes || [])
      if (scene.name && scene.out !== undefined)
        map.set(scene.name, { at: scene.at, end: scene.at + scene.out });
  }
  return map;
}

/** Include indirectly moved named clips so a caller can check ripple behavior without reading all tracks. */
export function namedTimingChanges(
  before: Timeline | undefined,
  after: Timeline
) {
  const original = namedTimings(before),
    current = namedTimings(after);
  return Array.from(new Set([...original.keys(), ...current.keys()])).flatMap(
    (name) => {
      const before = original.get(name) || null,
        after = current.get(name) || null;
      return JSON.stringify(before) === JSON.stringify(after)
        ? []
        : [{ name, before, after }];
    }
  );
}
