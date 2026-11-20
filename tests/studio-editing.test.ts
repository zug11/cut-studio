import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ProjectSession } from '../src/mcp/project';
import { frameToTicks, secondsToTicks } from '../src/core/time';
import { runStudioAction } from '../src/project/actions';

let root: string, project: ProjectSession;
const file = 'edit.cut',
  alternateFile = 'alternate.cut',
  fps = { num: 24, den: 1 };
const source = `film "A" { resolution 160x96 fps 24
  // Editorial note: keep the wide shot.
  track video "Picture" layer 1 {
    clip "red.mp4" as wide from 0s to 2s at 0s
    clip "blue.mp4" as reaction { in 0s out 1s after wide }
  }
  track audio "Voice" layer 1 { clip "quiet.wav" as voice { out 0.75s at reaction.start - 8f } }
  track audio "Music" layer 2 { clip "tone.wav" as score { out 3s at 0s duck A1 -12dB } }
}`;
const ff = (args: string[]) =>
  execFileSync(
    process.env.CUT_FFMPEG || 'ffmpeg',
    ['-nostdin', '-v', 'error', ...args],
    { maxBuffer: 8 * 1024 * 1024 }
  );
const pixels = (file: string, at: number, fmt = 'rgb24') =>
  ff([
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '1',
    '-pix_fmt',
    fmt,
    '-f',
    'rawvideo',
    'pipe:1'
  ]);
function rms(file: string, t: number) {
  const b = ff([
    '-ss',
    String(t),
    '-i',
    file,
    '-t',
    '0.12',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1'
  ]);
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum += b.readFloatLE(i) ** 2;
  return Math.sqrt(sum / (b.length / 4));
}
async function timeline(text: string, doc = file) {
  const compiled = await project.timeline({ file: doc, source: text });
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual(
    []
  );
  return compiled.timeline!;
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cut-edit-suite-'));
  for (const color of ['red', 'blue'])
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=' + color + ':s=160x96:r=24:d=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(root, color + '.mp4')
    ]);
  for (const [name, filter] of [
    ['tone', 'sine=f=440:r=48000:d=4'],
    ['quiet', 'anullsrc=r=48000:cl=mono:d=4']
  ])
    ff([
      '-f',
      'lavfi',
      '-i',
      filter,
      '-c:a',
      'pcm_s16le',
      path.join(root, name + '.wav')
    ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=80x48',
    '-frames:v',
    '1',
    path.join(root, 'card.png')
  ]);
  await writeFile(
    path.join(root, 'quiet.vtt'),
    'WEBVTT\n\n00:00:00.080 --> 00:00:00.550\nI knew.\n'
  );
  await writeFile(path.join(root, file), source);
  await writeFile(
    path.join(root, alternateFile),
    source.replace('clip "blue.mp4"', 'clip "red.mp4"')
  );
  project = await new ProjectSession(root).initialize();
});
afterAll(async () => {
  project?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
describe('shared editing, review and Premiere handoff', () => {
  it('ripples named links by exact frames, preserves pinned music and restores saved source with one undo', async () => {
    const before = await project.readSource({ path: file });
    const operation = {
      op: 'trim',
      target: 'wide',
      edge: 'out',
      frames: -3
    } as const;
    const preview = await project.edit({ file, operation });
    expect(preview.source).toContain('// Editorial note: keep the wide shot.');
    expect((await project.readSource({ path: file })).source).toBe(source);
    const edit = await project.edit({
      file,
      operation,
      apply: true,
      expectedRevision: before.revision
    });
    const clips = (await timeline(edit.source)).tracks.flatMap((t) => t.clips);
    expect(clips.find((c) => c.name === 'reaction')?.at).toBe(
      frameToTicks(45, fps)
    );
    expect(clips.find((c) => c.name === 'voice')?.at).toBe(
      frameToTicks(37, fps)
    );
    expect(clips.find((c) => c.name === 'score')?.at).toBe(0);
    await expect(
      project.edit({
        file,
        operation,
        apply: true,
        expectedRevision: before.revision
      })
    ).rejects.toThrow(/latest/);
    await project.save(edit.undo!);
    expect((await project.readSource({ path: file })).source).toBe(source);
  });
  it('splits concise code and keeps links attached to the correct half, renames, swaps, and closes selected gaps', async () => {
    const half = await project.edit({
      file,
      operation: { op: 'split', target: 'wide', at: '24f' }
    });
    expect(half.source).toMatch(/wide_tail\.end/);
    const renamed = await project.edit({
      file,
      source: half.source,
      operation: { op: 'place', target: 'wide', name: 'open' }
    });
    const swap = await project.edit({
      file,
      source: renamed.source,
      operation: { op: 'swap', target: 'wide_tail', asset: 'blue.mp4' }
    });
    expect(swap.source).toContain('"blue.mp4" as wide_tail');
    const clips = (await timeline(swap.source)).tracks.flatMap((t) => t.clips);
    expect(clips.find((c) => c.name === 'reaction')?.at).toBe(
      secondsToTicks(2)
    );
    const gap = source
      .replace('after wide', 'at 3s')
      .replace('at reaction.start - 8f', 'at 3s');
    const closed = await project.edit({
      file,
      source: gap,
      operation: { op: 'close_gap', target: 'reaction', lanes: ['V1', 'A1'] }
    });
    const after = (await timeline(closed.source)).tracks.flatMap(
      (t) => t.clips
    );
    expect(after.find((c) => c.name === 'reaction')?.at).toBe(
      secondsToTicks(2)
    );
    expect(after.find((c) => c.name === 'voice')?.at).toBe(secondsToTicks(2));
    expect(after.find((c) => c.name === 'score')?.at).toBe(0);
  });
  it('resolves forward references, rejects bad timing and constrains recursive scene files', async () => {
    const forward = source
      .replace('from 0s to 2s at 0s', 'from 0s to 2s at reaction.start - 2s')
      .replace('after wide', 'at 2s');
    expect((await timeline(forward)).duration).toBe(secondsToTicks(3));
    for (const text of [
      forward.replace('at 2s', 'after wide'),
      source.replace('after wide', 'after missing'),
      source.replace('as reaction', 'as wide')
    ]) {
      expect((await project.check({ file, source: text })).valid).toBe(false);
    }
    const scene =
      'film "Scene" { resolution 160x96 fps 24 scene "edit.cut" as intro { at 1s } }';
    const parent = await timeline(scene, 'parent.cut');
    expect(parent.duration).toBe(secondsToTicks(4));
    expect(parent.dependencies).toContain(path.join(project.root, file));
    expect(parent.tracks.flatMap((t) => t.clips)[0].originFile).toBe(
      path.join(project.root, file)
    );
    await expect(
      project.check({
        file,
        source: scene.replace('edit.cut', '../outside.cut')
      })
    ).rejects.toThrow(/outside/);
    expect((await project.check({ file, source: scene })).valid).toBe(false);
  });
  it('reviews a proposed shared scene inside two parent timelines before any source is written', async () => {
    const scene = 'intro.cut',
      parent = 'assembly.cut';
    const intro =
      'film "Intro" { resolution 160x96 fps 24 track video "Picture" layer 1 { clip "red.mp4" as wide from 0s to 2s at 0s } }';
    const assembly =
      'film "Assembly" { resolution 160x96 fps 24 scene "intro.cut" as opening { at 0s } track video "Picture" layer 1 { clip "blue.mp4" as reaction { out 1s after opening } } }';
    await writeFile(path.join(root, scene), intro);
    await writeFile(path.join(root, parent), assembly);
    const proposal = await project.edit({
      file: scene,
      operations: [
        { op: 'trim', target: 'wide', edge: 'out', frames: -3 },
        { op: 'effects', target: 'wide', values: { opacity: 0.8 } }
      ]
    });
    expect(proposal.namedTimingChanges[0]).toMatchObject({
      name: 'wide',
      before: { end: frameToTicks(48, fps) },
      after: { end: frameToTicks(45, fps) }
    });
    const result = await runStudioAction(
      project,
      'cut_review',
      {
        file: parent,
        cue: 'reaction.start',
        seconds: 0.75,
        alternateSceneSources: { [scene]: proposal.source }
      },
      new AbortController().signal
    );
    expect(result.reviews!.map((x) => x.media.cue?.frame)).toEqual([48, 45]);
    expect((await project.readSource({ path: scene })).source).toBe(intro);
    await expect(
      project.timeline({
        file: parent,
        sceneSources: { '../escape.cut': proposal.source }
      })
    ).rejects.toThrow();
  });

  it('returns real before/after frames and audio for both versions, source contact sheets and transcript excerpts', async () => {
    const signal = new AbortController().signal;
    const review = await runStudioAction(
      project,
      'cut_review',
      { file, cue: 'reaction.start', seconds: 2, alternateFile },
      signal
    );
    expect(review.reviews).toHaveLength(2);
    const [a, b] = review.reviews!.map((x) => x.media);
    const before = pixels(a.movie!, 0.95),
      after = pixels(a.movie!, 1.05),
      alternate = pixels(b.movie!, 1.05);
    expect(before[0]).toBeGreaterThan(210);
    expect(after[2]).toBeGreaterThan(210);
    expect(alternate[0]).toBeGreaterThan(210);
    expect(a.frames.map((f) => f.seconds)).toContain(47 / 24);
    expect((await readFile(a.image!)).subarray(1, 4).toString()).toBe('PNG');
    expect(rms(a.audio!, 0.2)).toBeGreaterThan(0.02);
    const sheet = await project.sheet('red.mp4', 3);
    expect(sheet.frames).toHaveLength(3);
    const dialogue = await project.dialogue('knew', 'quiet.wav');
    expect(dialogue.matches[0]).toMatchObject({
      from: 0.08,
      to: 0.55,
      text: 'I knew.'
    });
    expect(
      (await project.audition('quiet.wav', 0.08, 0.47)).audio
    ).toBeTruthy();
    expect((await project.audition('card.png')).frames).toHaveLength(1);
  });
  it('matches still framing, drawn text, and ducking in exported media and keeps Premiere layers separate', async () => {
    const card = await project.edit({
      file,
      operation: {
        op: 'insert',
        kind: 'video',
        name: 'card',
        value: 'card.png',
        at: '0s',
        out: '3s',
        layer: 2
      }
    });
    const framed = await project.edit({
      file,
      source: card.source,
      operation: {
        op: 'effects',
        target: 'card',
        values: { scale: 0.5, x: 30, y: 0, crop: [2, 0, 2, 0] }
      }
    });
    const titled = await project.edit({
      file,
      source: framed.source,
      operation: {
        op: 'insert',
        kind: 'title',
        name: 'type',
        value: 'CUT',
        at: '0s',
        out: '1s',
        layer: 3
      }
    });
    const captioned = await project.edit({
      file,
      source: titled.source,
      operation: {
        op: 'insert',
        kind: 'caption',
        value: 'A line.',
        at: '1s',
        out: '1s',
        layer: 3
      }
    });
    const plan = await project.exportPlan({ file, source: captioned.source });
    expect(plan.editable).toBe(3);
    expect(plan.rendered).toHaveLength(4);
    const movie = await project.export({
      file,
      source: captioned.source,
      output: 'out.mp4'
    });
    const buf = pixels(movie.absolutePath, 0.5),
      at = (x: number, y: number) =>
        Array.from(buf.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3));
    expect(at(5, 5)[0]).toBeGreaterThan(210);
    expect(at(105, 40)[2]).toBeGreaterThan(210);
    const ratio = rms(movie.absolutePath, 1.9) / rms(movie.absolutePath, 0.4);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
    const premiere = await project.export({
      file,
      source: captioned.source,
      output: 'handoff.prproj'
    });
    const xml = gunzipSync(await readFile(premiere.absolutePath)).toString();
    expect(xml).toContain('<PremiereData');
    expect(xml).toContain('CUT Linked Media');
    const folder = (await readdir(root)).find((f) =>
      f.startsWith('CUT Linked Media')
    )!;
    const media = await readdir(path.join(root, folder));
    expect(media).toHaveLength(4);
    const layer = (suffix: string) =>
      path.join(root, folder, media.find((x) => x.endsWith(suffix))!);
    const rgba = pixels(layer('card.mov'), 0.5, 'rgba');
    expect(rgba[(5 * 160 + 5) * 4 + 3]).toBeLessThan(5);
    expect(rgba[(40 * 160 + 105) * 4 + 3]).toBeGreaterThan(245);
    const title = pixels(layer('type.mov'), 0.1, 'rgba');
    expect(Math.max(...title.filter((_, i) => i % 4 === 3))).toBeGreaterThan(
      210
    );
    expect(
      rms(layer('score.wav'), 1.9) / rms(layer('score.wav'), 0.4)
    ).toBeCloseTo(0.25, 1);
  });
});
