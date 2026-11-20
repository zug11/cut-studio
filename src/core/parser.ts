import type { Clip, Diagnostic, Film, ParseResult, Position, Rational, SourceRange, Track } from './types';
import { parseTime } from './time';
import { arrangeLayers, MAX_LAYERS } from './layers';

type Token = { kind: 'atom' | 'string' | '{' | '}' | 'eof'; text: string; range: SourceRange };
type TimeField = 'in' | 'out' | 'at' | 'fadeIn' | 'fadeOut';
const timeProperties: Partial<Record<string, TimeField>> = {
  in: 'in',
  out: 'out',
  at: 'at',
  fade_in: 'fadeIn',
  fade_out: 'fadeOut'
};
const propertyNames = ['in', 'out', 'at', 'after', 'layer', 'opacity', 'gain', 'fade_in', 'fade_out', 'x', 'y', 'scale', 'crop', 'duck'];
const elements = ['clip', 'title', 'caption', 'scene'];
const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A small recovering lexer/parser; all ranges refer to the original document. */
export function parseCut(source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const tokens: Token[] = [];
  let offset = 0,
    line = 0,
    column = 0;
  const position = (): Position => ({ offset, line, column });
  const advance = () => {
    const character = source[offset++];
    if (character === '\n') {
      line++;
      column = 0;
    } else column++;
    return character;
  };
  const issue = (
    code: string,
    message: string,
    range: SourceRange,
    severity: Diagnostic['severity'] = 'error'
  ) => diagnostics.push({ severity, code, message, range });
  while (offset < source.length) {
    if (/\s/.test(source[offset])) {
      advance();
      continue;
    }
    if (source[offset] === '#' || source.slice(offset, offset + 2) === '//') {
      while (offset < source.length && source[offset] !== '\n') advance();
      continue;
    }
    if (source.slice(offset, offset + 2) === '/*') {
      const start = position();
      advance();
      advance();
      while (offset < source.length && source.slice(offset, offset + 2) !== '*/') advance();
      if (offset >= source.length)
        issue('unterminated-comment', 'Unterminated block comment. Add */ to close it.', {
          start,
          end: position()
        });
      else {
        advance();
        advance();
      }
      continue;
    }
    const start = position();
    if (source[offset] === '{' || source[offset] === '}') {
      const text = advance();
      tokens.push({ kind: text as '{' | '}', text, range: { start, end: position() } });
      continue;
    }
    if (source[offset] === '"') {
      const begin = offset;
      advance();
      let closed = false;
      while (offset < source.length) {
        const character = advance();
        if (character === '\\') {
          if (offset < source.length) advance();
        } else if (character === '"') {
          closed = true;
          break;
        } else if (character === '\n' || character === '\r') break;
      }
      const raw = source.slice(begin, offset);
      let text = raw.slice(1, closed ? -1 : undefined);
      if (!closed)
        issue('unterminated-string', 'Unterminated string. Add a closing double quote.', {
          start,
          end: position()
        });
      else {
        try {
          text = JSON.parse(raw) as string;
        } catch {
          issue(
            'invalid-string',
            'Invalid string escape. Use forward slashes in media paths or escape a backslash as \\\\.',
            { start, end: position() }
          );
        }
      }
      tokens.push({ kind: 'string', text, range: { start, end: position() } });
      continue;
    }
    let text = '';
    while (offset < source.length && !/[\s{}"#]/.test(source[offset])) {
      if (source.slice(offset, offset + 2) === '//' || source.slice(offset, offset + 2) === '/*') break;
      text += advance();
    }
    if (text) tokens.push({ kind: 'atom', text, range: { start, end: position() } });
    else {
      advance();
      issue('unexpected-character', 'Unexpected character.', { start, end: position() });
    }
  }
  const end = position();
  tokens.push({ kind: 'eof', text: '', range: { start: end, end } });
  let index = 0;
  const current = () => tokens[index];
  const take = () => tokens[index++];
  const is = (text: string) => current().text === text;
  const eof = () => current().kind === 'eof';
  const expect = (text: string): Token | undefined => {
    if (is(text)) return take();
    issue(
      'expected-token',
      `Expected “${text}”${eof() ? ' before the end of the document' : `, found “${current().text}”`}.`,
      current().range
    );
    return undefined;
  };
  const string = (description: string): Token => {
    if (current().kind === 'string') return take();
    issue(
      'expected-string',
      `Expected a quoted ${description}, such as "${description === 'media path' ? 'footage/clip.mp4' : 'My Film'}".`,
      current().range
    );
    if (current().kind === 'atom' && !['track', 'clip', 'film', 'resolution', 'fps'].includes(current().text))
      return take();
    return { kind: 'string', text: '', range: current().range };
  };
  const value = (name: string): Token | undefined => {
    if (
      current().kind === 'atom' &&
      ![...propertyNames, 'clip', 'track', 'resolution', 'fps'].includes(current().text)
    )
      return take();
    issue('missing-value', `Expected a value after “${name}”.`, current().range);
    return undefined;
  };
  const pending: { clip: Clip; field: TimeField; token: Token }[] = [];
  const offsets: { clip: Clip; sign: number; token: Token }[] = [];
  const parseLayer = (token: Token): number | undefined => {
    const layer = Number(token.text);
    if (!/^\d+$/.test(token.text) || !Number.isSafeInteger(layer) || layer < 1 || layer > MAX_LAYERS) {
      issue('invalid-layer', `Layer must be a whole number from 1 to ${MAX_LAYERS}, such as layer 3. Video and audio have separate layer numbers.`, token.range);
      return;
    }
    return layer;
  };
  let clipCounter = 0;
  const parseClip = (kind: Track['kind']): Clip => {
    const begin = take();
    const path = string('media path');
    const clip: Clip = {
      id: `clip-${clipCounter++}`,
      path: path.text,
      in: 0,
      at: 0,
      opacity: 1,
      gain: 0,
      fadeIn: 0,
      fadeOut: 0,
      range: { start: begin.range.start, end: path.range.end },
      statements: {}, fields: { path: path.range }
    };
    if (begin.text !== 'clip') clip.element = begin.text as Clip['element'];
    if (is('as')) {
      take();
      const alias = value('as');
      if (!alias || !identifier.test(alias.text)) issue('invalid-name', 'Use a name such as entrance after as.', alias?.range || path.range);
      else { clip.name = alias.text; clip.fields.name = alias.range; clip.range.end = alias.range.end; }
    }
    if (!clip.path.trim()) issue('empty-path', 'Media path cannot be empty.', path.range);
    if (clip.path.includes('\0'))
      issue('invalid-path', 'Media paths cannot contain a null character.', path.range);
    const seen = new Set<string>();
    const readProperty = (property: Token, override?: TimeField) => {
      const name = property.text;
      if (name === 'after' || name === 'at' && /^[A-Za-z_][\w-]*\.(start|end)$/.test(current().text)) {
        const ref = value(name);
        if (!ref) return;
        const match = name === 'after' ? [ref.text, ref.text, 'end'] : /^([\w-]+)\.(start|end)$/.exec(ref.text);
        if (!match || !identifier.test(match[1])) { issue('invalid-link', 'Use after shot or at shot.start / shot.end.', ref.range); return; }
        if (seen.has('at')) issue('duplicate-property', 'Use one placement per item.', property.range);
        seen.add('at');
        clip.link = {target: match[1], edge: match[2] as 'start' | 'end', offset: 0};
        let end = ref.range.end;
        if (is('+') || is('-')) {
          const sign = take().text === '-' ? -1 : 1;
          const delta = value('offset');
          if (delta) { offsets.push({clip, sign, token: delta}); end = delta.range.end; }
        }
        clip.statements!.at = {start:property.range.start,end};
        clip.fields.at = {start: ref.range.start, end};
        clip.range.end = end;
        return;
      }
      if (['x','y','scale','crop','duck'].includes(name)) {
        const field = name as 'x'|'y'|'scale'|'crop'|'duck';
        const token = value(name);
        if (!token) return;
        if (seen.has(field)) issue('duplicate-property', 'Property occurs twice: ' + name, property.range);
        seen.add(field);
        let end = token.range.end;
        if ((field === 'duck') !== (kind === 'audio')) issue('invalid-property', 'Use duck on audio and framing on picture.', property.range);
        if (field === 'crop') {
          const margins = token.text.split(',').map(Number);
          if (!/^\d+,\d+,\d+,\d+$/.test(token.text) || margins.some(n=>!Number.isSafeInteger(n))) issue('invalid-crop','Specify source pixels as left,top,right,bottom.', token.range);
          else clip.crop = margins;
        } else if (field === 'duck') {
          const level = value('duck level');
          if (level) end = level.range.end;
          if (!/^A[1-9]\d*$/i.test(token.text) || Number(token.text.slice(1)) > MAX_LAYERS || !level || !/^-(?:\d+(?:\.\d+)?|\.\d+)dB$/.test(level.text) || Number(level.text.slice(0,-2)) < -96)
            issue('invalid-duck','Use duck A1 -12dB to lower this clip while dialogue on A1 plays.', token.range);
          else clip.duck = { layer: Number(token.text.slice(1)), db: Number(level.text.slice(0,-2)) };
        } else {
          const n = Number(token.text);
          if (!Number.isFinite(n) || (field === 'scale' ? n <= 0 || n > 8 : Math.abs(n) > 32768)) issue('invalid-transform','Use a finite pixel offset or a scale greater than 0 and at most 8.',token.range);
          else clip[field] = n;
        }
        clip.statements![field] = {start:property.range.start,end};
        clip.fields[field] = {start: token.range.start, end};
        clip.range.end = end;
        return;
      }
      const field =
        override ??
        timeProperties[name] ??
        (name === 'gain' ? 'gain' : name === 'opacity' ? 'opacity' : name === 'layer' ? 'layer' : undefined);
      if (!field) {
        issue(
          'unknown-property',
          `Unknown clip property “${name}”. Expected ${propertyNames.join(', ')}.`,
          property.range
        );
        // Skip a single value, but preserve the next real property or clip.
        if (current().kind === 'atom' && ![...propertyNames, 'clip', 'track'].includes(current().text))
          take();
        return;
      }
      const token = value(name);
      if (!token) return;
      if (seen.has(field))
        issue('duplicate-property', `Clip property “${name}” is defined more than once.`, property.range);
      seen.add(field);
      clip.fields[field] = token.range;
      clip.statements![field] = {start:property.range.start,end:token.range.end};
      clip.range.end = token.range.end;
      if (kind === 'audio' && field === 'opacity')
        issue('invalid-property', 'Opacity applies to video clips only.', property.range);
      if (kind === 'video' && ['gain', 'fadeIn', 'fadeOut'].includes(field))
        issue(
          'invalid-property',
          'Gain and fades apply to audio tracks. Add the media to an audio track to use its sound.',
          property.range
        );
      if (field in { in: 1, out: 1, at: 1, fadeIn: 1, fadeOut: 1 })
        pending.push({ clip, field: field as TimeField, token });
      else if (field === 'opacity') {
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token.text) || Number(token.text) < 0 || Number(token.text) > 1)
          issue('invalid-opacity', 'Opacity must be a number from 0 to 1.', token.range);
        else clip.opacity = Number(token.text);
      } else if (field === 'gain') {
        if (
          !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)dB$/.test(token.text) ||
          !Number.isFinite(Number(token.text.slice(0, -2)))
        )
          issue('invalid-gain', 'Gain must be in decibels, such as -12dB or 0dB.', token.range);
        else clip.gain = Number(token.text.slice(0, -2));
      } else if (field === 'layer') {
        clip.layer = parseLayer(token);
      }
    };
    if (is('{')) {
      take();
      while (!eof() && !is('}') && !elements.includes(current().text) && !is('track')) {
        const property = take();
        if (property.kind !== 'atom') {
          issue('expected-property', 'Expected a clip property, such as in, out, or at.', property.range);
          continue;
        }
        readProperty(property);
      }
      const close = expect('}');
      if (close) clip.range.end = close.range.end;
    } else if (is('from')) {
      const from = take();
      readProperty(from, 'in');
      const to = expect('to');
      if (to) readProperty(to, 'out');
      const at = is('after') ? take() : expect('at');
      if (at) readProperty(at, 'at');
      while (propertyNames.includes(current().text)) readProperty(take());
    } else {
      issue(
        'expected-clip-body',
        'Expected a clip block { in … out … at … } or “from … to … at …”.',
        current().range
      );
    }
    return clip;
  };
  const parseTrack = (number: number): Track => {
    const begin = take();
    let kind: Track['kind'] = 'video';
    if (is('video') || is('audio')) kind = take().text as Track['kind'];
    else {
      issue('invalid-track-kind', 'Track kind must be video or audio.', current().range);
      if (current().kind === 'atom') take();
    }
    const name = string('track name');
    const track: Track = {
      id: `track-${number}`,
      kind,
      name: name.text,
      clips: [],
      range: { start: begin.range.start, end: name.range.end }
    };
    while (is('layer')) {
      const property = take();
      const token = value('layer');
      if (track.layer !== undefined) issue('duplicate-property', 'Track layer is defined more than once.', property.range);
      if (token) track.layer = parseLayer(token);
    }
    if (!expect('{')) return track;
    while (!eof() && !is('}') && !is('track')) {
      if (['clip','title','caption'].includes(current().text)) {
        if (kind !== 'video' && !is('clip')) issue('invalid-track-kind','Put titles and captions on a video track.',current().range);
        track.clips.push(parseClip(kind));
      }
      else {
        const unexpected = take();
        issue('expected-clip', 'Expected a clip declaration inside this track.', unexpected.range);
      }
    }
    const close = expect('}');
    if (close) track.range.end = close.range.end;
    return track;
  };
  if (!is('film')) {
    issue('expected-film', 'A CUT document starts with film "Film name" { … }.', current().range);
    return { diagnostics };
  }
  const begin = take();
  const name = string('film name');
  const film: Film = {
    name: name.text,
    resolution: { width: 1920, height: 1080 },
    fps: { num: 24, den: 1 },
    tracks: [],
    range: { start: begin.range.start, end: name.range.end }
  };
  const filmProperties = new Set<string>();
  if (expect('{')) {
    while (!eof() && !is('}')) {
      if (is('scene')) {
        const scene = parseClip('video');
        if (Object.keys(scene.fields).some(key => !['path','name','at'].includes(key))) issue('scene-property','A scene accepts a name and placement. Edit its CUT file to change its contents.',scene.range);
        (film.scenes ??= []).push(scene);
        continue;
      }
      if (is('track')) {
        film.tracks.push(parseTrack(film.tracks.length));
        continue;
      }
      const property = take();
      if (property.text === 'fps' || property.text === 'resolution') {
        if (filmProperties.has(property.text))
          issue(
            'duplicate-property',
            `Film property “${property.text}” is defined more than once.`,
            property.range
          );
        filmProperties.add(property.text);
        const token = value(property.text);
        if (!token) continue;
        if (property.text === 'resolution') {
          let resolution = token.text;
          if (/^\d+$/.test(resolution) && is('x')) {
            take();
            const height = value('height');
            if (height) resolution += `x${height.text}`;
          }
          const match = /^(\d+)x(\d+)$/.exec(resolution);
          if (
            !match ||
            !Number.isSafeInteger(Number(match[1])) ||
            !Number.isSafeInteger(Number(match[2])) ||
            Number(match[1]) < 2 ||
            Number(match[2]) < 2 ||
            Number(match[1]) > 16384 ||
            Number(match[2]) > 16384 ||
            Number(match[1]) % 2 ||
            Number(match[2]) % 2
          ) {
            issue(
              'invalid-resolution',
              'Resolution must use even dimensions from 2 to 16384, such as 1920x1080.',
              token.range
            );
          } else film.resolution = { width: Number(match[1]), height: Number(match[2]) };
        } else {
          let text = token.text;
          if (/^\d+$/.test(text) && is('/')) {
            take();
            const denominator = value('fps denominator');
            if (denominator) text += `/${denominator.text}`;
          }
          const rational = /^(\d+)(?:\/(\d+))?$/.exec(text);
          const decimal = /^(\d+)\.(\d{1,6})$/.exec(text);
          let fps: Rational | undefined;
          if (rational) fps = { num: Number(rational[1]), den: Number(rational[2] ?? 1) };
          else if (decimal) fps = { num: Number(decimal[1] + decimal[2]), den: 10 ** decimal[2].length };
          if (
            !fps ||
            !Number.isSafeInteger(fps.num) ||
            !Number.isSafeInteger(fps.den) ||
            fps.num <= 0 ||
            fps.den <= 0 ||
            fps.num / fps.den > 1000 ||
            fps.num / fps.den < 1
          )
            issue(
              'invalid-fps',
              'FPS must be between 1 and 1000. Use 24, 29.97, or a precise rational such as 30000/1001.',
              token.range
            );
          else {
            const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
            const divisor = gcd(fps.num, fps.den);
            film.fps = { num: fps.num / divisor, den: fps.den / divisor };
          }
        }
      } else {
        issue(
          'unknown-property',
          `Unknown film property “${property.text}”. Expected resolution, fps, or track.`,
          property.range
        );
        if (current().kind === 'atom' && !['resolution', 'fps', 'track'].includes(current().text)) take();
      }
    }
    const close = expect('}');
    if (close) film.range.end = close.range.end;
  }
  if (!eof())
    issue(
      'unexpected-content',
      'Unexpected content after the film. Each .cut file defines one film.',
      current().range
    );
  // Defer time interpretation until the complete film frame rate has been read.
  for (const { clip, field, token } of pending) {
    try {
      clip[field] = parseTime(token.text, film.fps);
    } catch (error) {
      issue('invalid-time', error instanceof Error ? error.message : String(error), token.range);
    }
  }
  for (const {clip, sign, token} of offsets) {
    try { clip.link!.offset = sign * parseTime(token.text, film.fps); }
    catch (error) { issue('invalid-time', error instanceof Error ? error.message : String(error), token.range); }
  }
  // Canonical grouping is also used before probing, so editor lanes move on every keystroke.
  film.tracks = arrangeLayers(film.tracks);
  for (const track of film.tracks) {
    if (track.layer! > MAX_LAYERS) issue('invalid-layer', `A film supports up to ${MAX_LAYERS} ${track.kind} layers. Combine declarations on an existing numbered layer.`, track.range);
    for (const clip of track.clips) {
      if (clip.out !== undefined && clip.out <= clip.in)
        issue(
          'invalid-range',
          'Source out must be after in. The out boundary is exclusive.',
          clip.fields.out ?? clip.range
        );
    }
    // Video bounds resolve on the output frame grid in the shared compiler. Comparing raw
    // decimal positions here would reject clips that become adjacent after quantization.
    if (track.kind === 'video') continue;
    const sorted = track.clips
      .filter((clip) => !clip.link && clip.out !== undefined && clip.out > clip.in)
      .sort((a, b) => a.at - b.at);
    let previous: Clip | undefined;
    let previousEnd = -1;
    for (const clip of sorted) {
      const end = clip.at + clip.out! - clip.in;
      if (previous && clip.at < previousEnd)
        issue(
          'overlap',
          `Clip overlaps “${previous.path}” on audio layer A${track.layer} (“${track.name}”). Assign simultaneous clips to different layers.`,
          clip.fields.at ?? clip.range
        );
      if (end > previousEnd) {
        previous = clip;
        previousEnd = end;
      }
    }
  }
  return { film, diagnostics };
}
