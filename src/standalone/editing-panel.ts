import type { Film, Timeline } from '../core/types';
import type { EditOperation } from '../project/edits';
import { parseCut } from '../core/parser';
import { parseTime as readTime, ticksToSeconds } from '../core/time';

type Page = 'Clip' | 'Footage' | 'Scenes' | 'Review';
interface ShotReview {
  label: string;
  image?: string;
  audio?: string;
  movie?: string;
  frames: { seconds: number; timecode: string }[];
  from: number;
  to: number;
}
interface Context {
  file: string;
  source: string;
  saved: string;
  position: number;
  selected?: string;
  timeline?: Timeline;
  files: { path: string; kind: string }[];
  request<T>(action: string, input: unknown, signal?: AbortSignal): Promise<T>;
  change(
    source: string,
    changes: { from: number; to: number; insert: string }[]
  ): void;
  copy(name: string): Promise<void>;
  openScene(path: string): void;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}
function input(value = '', type = 'text') {
  const i = el('input');
  i.type = type;
  i.value = value;
  i.spellcheck = false;
  return i;
}
function select(options: [string, string][], value?: string) {
  const s = el('select');
  for (const [v, n] of options) s.add(new Option(n, v));
  if (value && options.some((o) => o[0] === value)) s.value = value;
  return s;
}
function label(text: string, field: HTMLElement) {
  const l = el('label');
  l.append(el('span', text), field);
  return l;
}
function row(...items: HTMLElement[]) {
  const d = el('div');
  d.className = 'editing-row';
  d.append(...items);
  return d;
}
function button(text: string, click: () => void, primary = false) {
  const b = el('button', text);
  b.type = 'button';
  if (primary) b.className = 'dialog-primary';
  b.onclick = click;
  return b;
}
function names(files: string[]): [string, string][] {
  return files.map((f) => [f, f]);
}

export function openEditing(
  context: Context,
  initial: Page = 'Clip',
  initialAsset?: string
) {
  document.querySelector<HTMLDialogElement>('.editing-dialog')?.close();
  const dialog = el('dialog');
  dialog.className = 'export-dialog editing-dialog';
  dialog.setAttribute('aria-label', 'Edit and review');
  const header = el('header'),
    tabs = el('nav'),
    content = el('section'),
    status = el('p'),
    output = el('section');
  tabs.setAttribute('aria-label', 'Editing tools');
  status.setAttribute('role', 'status');
  status.className = 'editing-status';
  output.className = 'editing-results';
  header.append(
    el('h2', 'Edit & review'),
    button('Done', () => dialog.close())
  );
  dialog.append(header, tabs, content, status, output);
  document.body.append(dialog);
  const clips = parseCut(context.source).film;
  const filmFiles = context.files
    .filter((f) => f.kind === 'cut')
    .map((f) => f.path);
  const mediaFiles = context.files
    .filter((f) => f.kind === 'video' || f.kind === 'audio')
    .map((f) => f.path);
  const clock = (s: number) => String(Number(s.toFixed(7))) + 's';
  let page = initial,
    active: AbortController | undefined;
  let assetName = initialAsset || mediaFiles[0] || '';
  function stop() {
    active?.abort();
    active = undefined;
    for (const m of Array.from(output.querySelectorAll('video,audio')))
      (m as HTMLMediaElement).pause();
  }
  function clear() {
    stop();
    status.textContent = '';
    output.replaceChildren();
  }
  async function job<T>(
    message: string,
    work: (s: AbortSignal) => Promise<T>,
    show: (v: T) => void
  ) {
    clear();
    const controller = new AbortController();
    active = controller;
    status.textContent = message;
    try {
      const v = await work(controller.signal);
      if (controller.signal.aborted) return;
      status.textContent = '';
      show(v);
    } catch (e) {
      if (!controller.signal.aborted)
        status.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  function edit(operation: EditOperation) {
    void job(
      'Checking edit…',
      (s) =>
        context.request<{
          source: string;
          changes: { from: number; to: number; insert: string }[];
        }>(
          'cut_edit',
          { file: context.file, source: context.source, operation },
          s
        ),
      (v) => {
        context.change(v.source, v.changes);
        dialog.close();
      }
    );
  }
  function display(
    reviews: ShotReview[],
    jump?: (s: number) => void,
    container = output
  ) {
    const grid = el('div');
    grid.className = 'review-grid';
    const players: HTMLVideoElement[] = [];
    for (const r of reviews) {
      const section = el('article');
      section.append(el('h3', r.label));
      if (r.movie) {
        const v = el('video');
        v.controls = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.src = r.movie;
        players.push(v);
        section.append(v);
      } else if (r.audio) {
        const a = el('audio');
        a.controls = true;
        a.src = r.audio;
        section.append(a);
      }
      if (r.image) {
        const img = el('img');
        img.src = r.image;
        img.alt = 'Frames with source timecodes for ' + r.label;
        section.append(img);
      }
      if (jump && r.frames.length) {
        section.append(
          row(...r.frames.map((f) => button(f.timecode, () => jump(f.seconds))))
        );
      }
      grid.append(section);
    }
    container.append(grid);
    if (players.length === 2) {
      container.prepend(
        button(
          'Play A then B',
          () => {
            const [a, b] = players;
            a.pause();
            b.pause();
            a.currentTime = 0;
            b.currentTime = 0;
            a.onended = () => {
              b.currentTime = 0;
              void b.play().catch((e) => (status.textContent = e.message));
            };
            void a.play().catch((e) => (status.textContent = e.message));
          },
          true
        )
      );
    }
  }
  function take(file: string, start: number, host = output) {
    void job(
      'Preparing excerpt…',
      (s) =>
        context.request<{ reviews: ShotReview[] }>(
          'cut_audition',
          { file, from: start, seconds: 5 },
          s
        ),
      (v) => display(v.reviews, undefined, host)
    );
  }
  function clipPage(film?: Film) {
    if (!context.file || !film) {
      content.append(el('p', 'Open a CUT film to edit its clips.'));
      return;
    }
    const choices = film.tracks.flatMap((t) =>
      t.clips.map((c) => ({
        c,
        kind: t.kind,
        lane: (t.kind === 'audio' ? 'A' : 'V') + (c.layer || t.layer)
      }))
    );
    const shot = select(
      choices.map(({ c, lane }) => [
        c.id,
        lane + ' · ' + (c.name ? c.name + ' · ' : '') + c.path
      ]),
      context.selected
    );
    if (!choices.length) {
      content.append(
        el('p', 'Add a take from Footage or a reusable film from Scenes.')
      );
      return;
    }
    const action = select(
      names([
        'Timing & layer',
        'Trim',
        'Split',
        'Swap take',
        'Close gap',
        'Picture & sound'
      ])
    );
    const fields = el('div');
    fields.className = 'editing-fields';
    content.append(label('Clip', shot), label('Edit', action), fields);
    function draw() {
      clear();
      fields.replaceChildren();
      const {
        c,
        kind,
        lane: currentLane
      } = choices.find((x) => x.c.id === shot.value)!;
      const target = c.name || c.id,
        submit = (text: string, f: () => EditOperation) =>
          button(text, () => edit(f()), true);
      if (action.value === 'Timing & layer') {
        const name = input(c.name || ''),
          layer = input(String(c.layer || 1), 'number');
        const at = input(
          c.link
            ? (c.link.edge === 'end'
                ? 'after ' + c.link.target
                : c.link.target + '.start') +
                (c.link.offset
                  ? (c.link.offset < 0 ? ' - ' : ' + ') +
                    clock(Math.abs(ticksToSeconds(c.link.offset)))
                  : '')
            : clock(ticksToSeconds(c.at))
        );
        fields.append(
          row(label('Shot name', name), label('Layer', layer)),
          label('Placement', at),
          el('small', 'Use 3s, after entrance, or entrance.start - 8f.'),
          submit('Apply timing', () => ({
            op: 'place',
            target,
            name: name.value || undefined,
            layer: Number(layer.value),
            at: at.value
          }))
        );
      } else if (action.value === 'Trim') {
        const edge = select([
            ['out', 'End'],
            ['in', 'Start']
          ]),
          frames = input('-3', 'number');
        fields.append(
          row(
            label('Source boundary', edge),
            label('Change in frames', frames)
          ),
          submit('Trim clip', () => ({
            op: 'trim',
            target,
            edge: edge.value as 'in' | 'out',
            frames: Number(frames.value)
          }))
        );
      } else if (action.value === 'Split') {
        const at = input(clock(context.position));
        fields.append(
          label('Film time', at),
          submit('Split at time', () => ({ op: 'split', target, at: at.value }))
        );
      } else if (action.value === 'Swap take') {
        const asset = select(names(mediaFiles));
        fields.append(
          label('Replacement take', asset),
          submit('Swap take', () => ({
            op: 'swap',
            target,
            asset: asset.value
          }))
        );
      } else if (action.value === 'Close gap') {
        const lanes = input(currentLane);
        fields.append(
          label('Layers to move', lanes),
          el('small', 'Separate layer names with commas, such as V1, A2.'),
          submit('Close preceding gap', () => ({
            op: 'close_gap',
            target,
            lanes: lanes.value
              .toUpperCase()
              .split(/[,\s]+/)
              .filter(Boolean)
          }))
        );
      } else if (kind === 'video') {
        const x = input(String(c.x ?? 0), 'number'),
          y = input(String(c.y ?? 0), 'number'),
          zoom = input(String(c.scale ?? 1), 'number'),
          alpha = input(String(c.opacity), 'number'),
          crop = input((c.crop || [0, 0, 0, 0]).join(','));
        fields.append(
          row(label('X offset (px)', x), label('Y offset (px)', y)),
          row(label('Scale factor', zoom), label('Opacity (0–1)', alpha)),
          label('Crop (left, top, right, bottom in source px)', crop),
          submit('Apply framing', () => ({
            op: 'effects',
            target,
            values: {
              x: Number(x.value),
              y: Number(y.value),
              scale: Number(zoom.value),
              opacity: Number(alpha.value),
              crop: crop.value.split(',').map(Number) as [
                number,
                number,
                number,
                number
              ]
            }
          }))
        );
      } else {
        const gain = input(String(c.gain), 'number'),
          fadeIn = input(clock(ticksToSeconds(c.fadeIn))),
          fadeOut = input(clock(ticksToSeconds(c.fadeOut)));
        const duck = select(
            [
              ['', 'Off'],
              ...film!.tracks
                .filter(
                  (t) =>
                    t.kind === 'audio' && t.layer !== c.layer && t.clips.length
                )
                .map(
                  (t) =>
                    [String(t.layer), 'A' + t.layer + ' · ' + t.name] as [
                      string,
                      string
                    ]
                )
            ],
            c.duck ? String(c.duck.layer) : undefined
          ),
          db = input(String(c.duck?.db ?? -12), 'number');
        fields.append(
          label('Gain (dB)', gain),
          row(label('Fade in', fadeIn), label('Fade out', fadeOut)),
          row(
            label('Duck under dialogue layer', duck),
            label('Attenuation (dB)', db)
          ),
          submit('Apply sound', () => ({
            op: 'effects',
            target,
            values: {
              gain: Number(gain.value),
              fadeIn: fadeIn.value,
              fadeOut: fadeOut.value,
              duck: duck.value
                ? { layer: Number(duck.value), db: Number(db.value) }
                : null
            }
          }))
        );
      }
    }
    shot.onchange = draw;
    action.onchange = draw;
    draw();
  }
  function footage() {
    const asset = select(names(mediaFiles), assetName),
      start = input('0', 'number');
    asset.onchange = () => {
      assetName = asset.value;
      clear();
    };
    const browse = () => {
      void job(
        'Sampling source frames…',
        (s) =>
          context.request<{ reviews: ShotReview[] }>(
            'cut_contact_sheet',
            { file: asset.value, count: 8 },
            s
          ),
        (v) =>
          display(v.reviews, (t) => {
            start.value = String(t);
            take(asset.value, t);
          })
      );
    };
    if (mediaFiles.length)
      content.append(
        label('Source take', asset),
        row(
          button('Contact sheet', browse),
          label('Source seconds', start),
          button('Audition 5s', () => take(asset.value, Number(start.value)))
        )
      );
    const mode = select(names(['Video', 'Audio', 'Title', 'Caption'])),
      text = input(''),
      at = input(clock(context.position)),
      length = input('3s'),
      layer = input('1', 'number');
    const txt = label('On-screen text', text);
    function update() {
      txt.hidden = !['Title', 'Caption'].includes(mode.value);
    }
    mode.onchange = update;
    update();
    const insert = el('details');
    insert.append(
      el('summary', 'Add to film'),
      row(
        label('Kind', mode),
        label('Layer', layer),
        label('Placement', at),
        label('Duration', length)
      ),
      txt,
      button(
        'Insert into CUT',
        () => {
          const graphic = !txt.hidden,
            from = graphic ? 0 : Number(start.value);
          if (!graphic && !asset.value) {
            status.textContent = 'Choose a source take.';
            return;
          }
          // in/out below are source-relative; addition uses the film’s exact time parser.
          try {
            const fps = clips?.fps || { num: 24, den: 1 },
              duration = readTime(length.value, fps);
            edit({
              op: 'insert',
              kind: mode.value.toLowerCase() as
                | 'audio'
                | 'video'
                | 'title'
                | 'caption',
              value: graphic ? text.value : asset.value,
              at: at.value,
              layer: Number(layer.value),
              in: clock(from),
              out: clock(from + ticksToSeconds(duration))
            });
          } catch (e) {
            status.textContent = String(e);
          }
        },
        true
      )
    );
    if (context.file) content.append(insert);
    const query = input(''),
      scope = select([
        ['all', 'Entire project'],
        ['one', 'Selected take']
      ]);
    query.placeholder = 'Words spoken in the take';
    const search = (index: boolean) => {
      void job(
        index ? 'Indexing dialogue locally…' : 'Searching dialogue…',
        (s) =>
          context.request<{
            matches: { file: string; from: number; to: number; text: string }[];
            total: number;
            searched: number;
            unindexed: string[];
            errors: { file: string; message: string }[];
          }>(
            'cut_search_dialogue',
            {
              query: query.value,
              file: scope.value === 'one' ? asset.value : undefined,
              index
            },
            s
          ),
        (v) => {
          status.textContent =
            v.total +
            ' matches · ' +
            v.searched +
            ' indexed · ' +
            v.unindexed.length +
            ' waiting for indexing';
          for (const e of v.errors)
            output.append(el('p', e.file + ' — ' + e.message));
          for (const hit of v.matches) {
            const entry = el('article');
            entry.className = 'dialogue-hit';
            entry.append(
              el(
                'small',
                hit.file +
                  ' · ' +
                  hit.from.toFixed(2) +
                  '–' +
                  hit.to.toFixed(2) +
                  ' s'
              ),
              el('p', hit.text),
              button('Hear line', () => {
                active?.abort();
                active = new AbortController();
                const s = active.signal;
                context
                  .request<{ reviews: ShotReview[] }>(
                    'cut_audition',
                    {
                      file: hit.file,
                      from: Math.max(0, hit.from - 0.35),
                      seconds: Math.min(15, hit.to - hit.from + 0.8)
                    },
                    s
                  )
                  .then((r) => {
                    if (s.aborted) return;
                    entry.querySelector('.review-grid')?.remove();
                    display(r.reviews, undefined, entry);
                  })
                  .catch((e) => {
                    if (!s.aborted) status.textContent = e.message;
                  });
              })
            );
            output.append(entry);
          }
        }
      );
    };
    content.append(
      el('h3', 'Spoken dialogue'),
      row(label('Search', query), label('Look in', scope)),
      row(
        button('Search dialogue', () => search(false), true),
        button('Index dialogue', () => search(true))
      ),
      el(
        'small',
        'Indexing uses a local speech model. The first download is 78 MB. SRT and VTT sidecars are searchable immediately.'
      )
    );
    query.onkeydown = (e) => {
      if (e.key === 'Enter') search(false);
    };
  }
  function scenes() {
    const other = filmFiles.filter((f) => f !== context.file),
      file = select(names(other)),
      name = input('opening'),
      at = input(clock(context.position));
    content.append(
      el('h3', 'Reusable scene'),
      label('Scene file', file),
      row(label('Instance name', name), label('Placement', at)),
      button(
        'Insert scene',
        () =>
          edit({
            op: 'insert',
            kind: 'scene',
            value: file.value,
            name: name.value,
            at: at.value
          }),
        true
      )
    );
    if (clips?.scenes?.length) {
      const existing = select(
          clips.scenes.map((c) => [c.id, (c.name || c.id) + ' · ' + c.path])
        ),
        replacement = select(names(other));
      content.append(
        row(
          label('Existing scene', existing),
          label('Replace with', replacement)
        ),
        button('Open scene source', () => {
          const ref = clips!.scenes!.find((c) => c.id === existing.value)!;
          dialog.close();
          context.openScene(ref.path);
        }),
        button('Replace scene', () =>
          edit({ op: 'swap', target: existing.value, asset: replacement.value })
        )
      );
    }
    const alternate = input(
      context.file
        .split('/')
        .at(-1)
        ?.replace(/\.cut$/i, ' - alternate.cut') || 'alternate.cut'
    );
    content.append(
      el('h3', 'Alternate cut'),
      label('New film in the same folder', alternate),
      button(
        'Save alternate',
        () =>
          void job(
            'Saving alternate…',
            () => context.copy(alternate.value),
            () => {
              status.textContent =
                'Saved ' +
                alternate.value +
                '. It is available in the project explorer.';
            }
          )
      )
    );
  }
  function review() {
    const cue = input(clock(context.position)),
      seconds = input('5', 'number');
    const opts: [string, string][] = [['', 'Current edit']];
    if (context.source !== context.saved)
      opts.push([':saved', 'Compare to last save']);
    for (const f of filmFiles.filter((f) => f !== context.file))
      opts.push([f, 'Compare to ' + f]);
    const against = select(opts);
    content.append(
      row(
        label('Film time or named cue', cue),
        label('Excerpt (seconds)', seconds)
      ),
      label('Comparison', against),
      button(
        'Render review',
        () => {
          const payload = {
            file: context.file,
            source: context.source,
            cue: cue.value,
            seconds: Number(seconds.value),
            ...(against.value === ':saved'
              ? { alternateSource: context.saved }
              : against.value
                ? { alternateFile: against.value }
                : {})
          };
          void job(
            'Rendering picture and sound…',
            (s) =>
              context.request<{ reviews: ShotReview[] }>(
                'cut_review',
                payload,
                s
              ),
            (v) => display(v.reviews)
          );
        },
        true
      )
    );
  }
  function show(p: Page) {
    clear();
    page = p;
    content.replaceChildren();
    for (const b of Array.from(tabs.querySelectorAll('button')))
      b.setAttribute('aria-pressed', String(b.textContent === page));
    if (p === 'Footage') footage();
    else if (p === 'Scenes') scenes();
    else if (p === 'Review') review();
    else clipPage(clips);
  }
  for (const p of ['Clip', 'Footage', 'Scenes', 'Review'] as Page[])
    tabs.append(button(p, () => show(p)));
  dialog.addEventListener(
    'close',
    () => {
      stop();
      dialog.remove();
    },
    { once: true }
  );
  show(page);
  dialog.showModal();
}
