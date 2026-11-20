import { describe, expect, it } from 'vitest';
import { parseCut } from '../src/core/parser';
import { frameToTicks, parseTime } from '../src/core/time';

const wrap = (body: string) => `film "Test" { resolution 1920x1080 fps 24 ${body} }`;
const one = (body: string) => wrap(`track video "Main" { ${body} }`);
const errors = (text: string) =>
  parseCut(text).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

describe('CUT language', () => {
  it('resolves explicit video and audio layer numbers independently and preserves gaps', () => {
    const result = parseCut(wrap('track video "Top" layer 3 { clip "top.mp4" from 0s to 2s at 0s } track video "Bottom" layer 1 { clip "bottom.mp4" from 0s to 2s at 0s } track audio "Music" layer 2 { clip "a.wav" { at 0s } }'));
    expect(result.diagnostics).toEqual([]);
    expect(result.film!.tracks.map(track => [track.kind, track.layer, track.name])).toEqual([
      ['video', 1, 'Bottom'], ['video', 2, 'Empty layer'], ['video', 3, 'Top'], ['audio', 1, 'Empty layer'], ['audio', 2, 'Music']
    ]);
    expect(result.film!.tracks[2].clips[0].layer).toBe(3);
  });
  it('accepts block and concise clip layer overrides without moving their source blocks', () => {
    const result = parseCut(one('clip "a.mp4" { in 0s out 2s at 0s layer 3 } clip "b.mp4" from 0s to 2s at 0s layer 2'));
    expect(result.diagnostics).toEqual([]);
    expect(result.film!.tracks.map(track => [track.layer, track.clips.map(clip => clip.path)])).toEqual([[1, []], [2, ['b.mp4']], [3, ['a.mp4']]]);
    const clip = result.film!.tracks[2].clips[0];
    expect(clip.fields.layer).toBeDefined();
    expect(clip.range.start.offset).toBe(one('clip "a.mp4" { in 0s out 2s at 0s layer 3 } clip "b.mp4" from 0s to 2s at 0s layer 2').indexOf('clip'));
  });
  it('merges declarations and clip overrides on the same effective layer', () => {
    const result = parseCut(wrap('track audio "A" layer 2 { clip "a.wav" from 0s to 1s at 0s } track audio "B" layer 1 { clip "b.wav" from 0s to 1s at 1s layer 2 }'));
    expect(result.diagnostics).toEqual([]);
    expect(result.film!.tracks[1].clips.map(clip => clip.path)).toEqual(['a.wav', 'b.wav']);
    expect(result.film!.tracks[1].name).toBe('A + B');
    const overlap = parseCut(wrap('track audio "A" layer 2 { clip "a.wav" from 0s to 2s at 0s } track audio "B" layer 2 { clip "b.wav" from 0s to 1s at 1s }'));
    expect(overlap.diagnostics.some(d => d.code === 'overlap' && d.message.includes('A2'))).toBe(true);
  });
  it('keeps legacy declaration defaults and assigns mixed automatic tracks to free layers', () => {
    const legacy = parseCut(wrap('track video "First" {} track audio "Sound" {} track video "Second" {}'));
    expect(legacy.film!.tracks.map(track => [track.kind, track.layer, track.name])).toEqual([['video', 1, 'First'], ['video', 2, 'Second'], ['audio', 1, 'Sound']]);
    const mixed = parseCut(wrap('track video "Reserved" layer 1 {} track video "Automatic" {}'));
    expect(mixed.film!.tracks.map(track => [track.layer, track.name])).toEqual([[1, 'Reserved'], [2, 'Automatic']]);
  });
  it.each(['0', '-1', '1.5', '257', 'NaN'])('rejects invalid layer %s on tracks and clips', layer => {
    expect(errors(wrap(`track video "Main" layer ${layer} {}`)).some(d => d.code === 'invalid-layer')).toBe(true);
    expect(errors(one(`clip "a.mp4" { layer ${layer} }`)).some(d => d.code === 'invalid-layer')).toBe(true);
    expect(errors(one(`clip "a.mp4" from 0s to 1s at 0s layer ${layer}`)).some(d => d.code === 'invalid-layer')).toBe(true);
  });
  it('parses the complete multi-track film syntax', () => {
    const result = parseCut(`film "My Short Film" {
      resolution 1920x1080
      fps 24
      track video "Main" {
        clip "footage/opening.mp4" { in 1m00.052s out 1m14.750s at 0s }
        clip "footage/street.mp4" { in 3s out 10s at 14.708s }
      }
      track video "Overlay" { clip "footage/rain.mp4" { in 0s out 5s at 5s opacity 0.4 } }
      track audio "Music" { clip "audio/score.wav" { at 0s gain -12dB fade_in 2s fade_out 3s } }
      track audio "Dialogue" { clip "audio/voice.wav" { at 4s gain -3dB } }
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(result.film?.tracks).toHaveLength(4);
    expect(result.film?.tracks[0].clips[0].in).toBe(parseTime('60.052s'));
    expect(result.film?.tracks[1].clips[0].opacity).toBe(0.4);
    expect(result.film?.tracks[2].clips[0]).toMatchObject({
      in: 0,
      at: 0,
      gain: -12,
      fadeIn: parseTime('2s'),
      fadeOut: parseTime('3s')
    });
    expect(result.film?.tracks[2].clips[0].out).toBeUndefined();
  });
  it('normalizes block and concise clips identically', () => {
    const a = parseCut(one('clip "interview.mp4" { in 1m00.052s out 1m14.750s at 0s }')).film!.tracks[0]
      .clips[0];
    const b = parseCut(one('clip "interview.mp4" from 1m00.052s to 1m14.750s at 0s')).film!.tracks[0]
      .clips[0];
    const values = ({ range, fields, statements, ...rest }: typeof a) => rest;
    expect(values(a)).toEqual(values(b));
  });
  it('accepts flexible whitespace, comments, escaped strings, and defaults', () => {
    const result = parseCut(
      `// line comment
    film "A \\"quoted\\" title" { # title
      /* multiline
         comment */
      track audio "Music" { clip "audio/a.wav" { at 0s } }
    }`.replaceAll('\\\\"', '\\"')
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.film?.resolution).toEqual({ width: 1920, height: 1080 });
    expect(result.film?.fps).toEqual({ num: 24, den: 1 });
    expect(result.film?.tracks[0].clips[0].gain).toBe(0);
  });
  it('interprets frame counts using fps even when fps follows the tracks', () => {
    const result = parseCut(
      `film "Frames" { track video "Main" { clip "a.mp4" from 24f to 48f at 00:00:01:00 } fps 24000/1001 }`
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.film?.tracks[0].clips[0].in).toBe(frameToTicks(24, { num: 24000, den: 1001 }));
    expect(result.film?.tracks[0].clips[0].at).toBe(frameToTicks(24, { num: 24000, den: 1001 }));
  });
  it('accepts separated resolution and rational tokens and exact decimal fps', () => {
    expect(parseCut('film "Test" { resolution 1280 x 720 fps 30000 / 1001 }').film?.fps).toEqual({
      num: 30000,
      den: 1001
    });
    expect(parseCut('film "Test" { fps 23.976 }').film?.fps).toEqual({ num: 2997, den: 125 });
  });
  it('retains accurate zero-based ranges for source navigation and field diagnostics', () => {
    const source = `film "Test" {\n  track video "Main" {\n    clip "a.mp4" {\n      in 1s\n      out bad\n      at 0s\n    }\n  }\n}`;
    const result = parseCut(source);
    const clip = result.film!.tracks[0].clips[0];
    expect(clip.range.start).toEqual({ line: 2, column: 4, offset: source.indexOf('clip') });
    const invalid = result.diagnostics.find((diagnostic) => diagnostic.code === 'invalid-time')!;
    expect(invalid.range.start).toEqual({ line: 4, column: 10, offset: source.indexOf('bad') });
    expect(source.slice(clip.range.start.offset, clip.range.end.offset)).toContain('at 0s');
  });
  it('rejects exact same-track audio overlaps but permits adjacency and cross-track layers', () => {
    const audio = (body: string) => wrap(`track audio "Music" { ${body} }`);
    expect(
      errors(audio('clip "a.wav" from 0s to 2s at 0s clip "b.wav" from 0s to 2s at 1s')).some(
        (d) => d.code === 'overlap'
      )
    ).toBe(true);
    expect(errors(audio('clip "a.wav" from 0s to 2s at 0s clip "b.wav" from 0s to 2s at 2s'))).toEqual([]);
    expect(
      errors(
        wrap(
          'track video "A" { clip "a.mp4" from 0s to 2s at 0s } track video "B" { clip "b.mp4" from 0s to 2s at 0s }'
        )
      )
    ).toEqual([]);
  });
  it('defers video overlap checks until the compiler resolves the output frame grid', () => {
    // 0.999s rounds to 1s at 24fps: these clips become exactly adjacent.
    expect(errors(one('clip "a.mp4" from 0s to 1s at 0s clip "b.mp4" from 0s to 1s at 0.999s'))).toEqual([]);
  });
  it.each([
    ['clip "a.mp4" { in 3s out 2s }', 'invalid-range'],
    ['clip "a.mp4" { at -1s }', 'invalid-time'],
    ['clip "a.mp4" { at 0s at 1s }', 'duplicate-property'],
    ['clip "a.mp4" { opacity 1.5 }', 'invalid-opacity'],
    ['clip "a.mp4" { magical 2s }', 'unknown-property'],
    ['clip "a.mp4" { at }', 'missing-value'],
    ['clip "a.mp4" { gain -12dB }', 'invalid-property'],
    ['clip "" { at 0s }', 'empty-path']
  ])('reports useful errors for %s', (body, code) => {
    expect(errors(one(body)).some((diagnostic) => diagnostic.code === code)).toBe(true);
  });
  it('validates audio gain, video opacity, resolution, fps, duplicate and unknown film properties', () => {
    expect(
      errors(wrap('track audio "Music" { clip "a.wav" { gain -12 } }')).some((d) => d.code === 'invalid-gain')
    ).toBe(true);
    expect(
      errors(wrap('track audio "Music" { clip "a.wav" { opacity .5 } }')).some(
        (d) => d.code === 'invalid-property'
      )
    ).toBe(true);
    expect(errors('film "Test" { resolution 1919x1080 fps 0 }').map((d) => d.code)).toEqual([
      'invalid-resolution',
      'invalid-fps'
    ]);
    expect(errors('film "Test" { fps 24 fps 30 title "x" }').map((d) => d.code)).toEqual([
      'duplicate-property',
      'unknown-property',
      'unknown-property'
    ]);
  });
  it('recovers from malformed bodies without losing subsequent tracks', () => {
    const result = parseCut(
      'film "Test" { track video "A" { clip "a.mp4" { at 1s track audio "B" { clip "b.wav" { at 0s } } }'
    );
    expect(result.film?.tracks).toHaveLength(2);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it.each([
    '',
    'track video "A" {}',
    'film "X" {',
    'film "X" {} garbage',
    'film "X" { /* missing close',
    'film "X\n { }'
  ])('reports malformed document %j', (source) => {
    expect(errors(source).length).toBeGreaterThan(0);
  });
});
