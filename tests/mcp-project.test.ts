import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { ProjectSession } from '../src/mcp/project';
import { ProjectPaths } from '../src/project/paths';
import { compile } from '../src/core/compiler';
import { probeMedia } from '../src/engine';

let directory: string;
let root: string;
let session: ProjectSession;
const source = `film "MCP acceptance" {
  resolution 160x90
  fps 24
  track video "Picture" { clip "media/red.mp4" from 0s to 1s at 0s }
  track audio "Tone" { clip "media/tone.wav" { at 0s gain -12dB } }
}`;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cut-project-mcp-'));
  root = path.join(directory, 'project');
  await mkdir(path.join(root, 'media'), { recursive: true });
  await mkdir(path.join(root, 'nested'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'film.cut'), source);
  await writeFile(path.join(root, '.private.cut'), source);
  await writeFile(path.join(root, 'node_modules', 'ignore.cut'), source);
  await writeFile(path.join(directory, 'outside.cut'), 'private CUT source');
  await writeFile(path.join(root, 'config.json'), 'private configuration');
  await symlink(
    path.join(directory, 'outside.cut'),
    path.join(root, 'escape.cut')
  );
  await symlink(directory, path.join(root, 'outside-folder'));
  await symlink(
    path.join(root, 'config.json'),
    path.join(root, 'config-link.cut')
  );
  await symlink(path.join(root, 'film.cut'), path.join(root, 'film-link.cut'));
  await symlink(
    path.join(directory, 'missing.cut'),
    path.join(root, 'dangling.cut')
  );
  await symlink(path.join(root, 'nested'), path.join(root, 'nested-alias'));
  const ffmpeg = process.env.CUT_FFMPEG || 'ffmpeg';
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=24:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-y',
    path.join(root, 'media', 'red.mp4')
  ]);
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    '-y',
    path.join(root, 'media', 'tone.wav')
  ]);
  await copyFile(
    path.join(root, 'media', 'red.mp4'),
    path.join(directory, 'outside.mp4')
  );
  await symlink(
    path.join(directory, 'outside.mp4'),
    path.join(root, 'media', 'escape.mp4')
  );
  await symlink(
    path.join(root, 'config.json'),
    path.join(root, 'media', 'config.mp4')
  );
  session = await new ProjectSession(root).initialize();
}, 30000);

afterAll(async () => {
  session?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('project-scoped MCP domain operations', () => {
  it('lists only project source and media with bounded, explicit truncation', async () => {
    const result = await session.listFiles();
    expect(result.root).toBe(session.root);
    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: 'film.cut', name: 'film.cut', kind: 'cut' },
        { path: 'media/red.mp4', name: 'red.mp4', kind: 'video' },
        { path: 'media/tone.wav', name: 'tone.wav', kind: 'audio' }
      ])
    );
    expect(
      result.files.some((file) => /private|ignore|escape|link/.test(file.path))
    ).toBe(false);
    const limited = await (
      await ProjectPaths.open(root)
    ).listFiles({ limit: 1 });
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });

  it('reads exact source revisions and permits confined CUT links and explicit dotfiles', async () => {
    const result = await session.readSource({ path: 'film.cut' });
    expect(result.source).toBe(source);
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
    expect((await session.readSource({ path: 'film-link.cut' })).revision).toBe(
      result.revision
    );
    expect((await session.readSource({ path: '.private.cut' })).source).toBe(
      source
    );
  });

  it('rejects traversal, outside and dangling links, and links to non-CUT files', async () => {
    for (const file of [
      '../outside.cut',
      path.join(directory, 'outside.cut'),
      'escape.cut',
      'outside-folder/outside.cut',
      'config-link.cut',
      'dangling.cut'
    ]) {
      await expect(session.readSource({ path: file })).rejects.toMatchObject({
        status: 403
      });
    }
    await expect(
      session.save({ file: 'outside-folder/new.cut', source, create: true })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      session.save({ file: 'dangling.cut', source, create: true })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      session.check({
        file: 'film.cut',
        source: source.replace('media/red.mp4', 'media/escape.mp4')
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      session.check({
        file: 'film.cut',
        source: source.replace('media/red.mp4', 'media/config.mp4')
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    expect(await readFile(path.join(directory, 'outside.cut'), 'utf8')).toBe(
      'private CUT source'
    );
  });

  it('shares the real compiler and reports malformed source or missing assets', async () => {
    expect(await session.check({ file: 'film.cut' })).toMatchObject({
      valid: true,
      diagnostics: []
    });
    const timeline = await session.timeline({ file: 'film.cut' });
    expect(timeline.timeline?.tracks).toHaveLength(2);
    expect(timeline.timeline?.duration).toBe(35280000);
    const malformed = await session.check({
      file: 'film.cut',
      source: source.replace('to 1s', 'to bananas')
    });
    expect(malformed.valid).toBe(false);
    expect(
      malformed.diagnostics.some(
        (diagnostic) => diagnostic.severity === 'error'
      )
    ).toBe(true);
    const missing = await session.check({
      file: 'film.cut',
      source: source.replace('media/red.mp4', 'media/missing.mp4')
    });
    expect(missing.valid).toBe(false);
    expect(
      missing.diagnostics.some(
        (diagnostic) => diagnostic.code === 'MEDIA_ERROR'
      )
    ).toBe(true);
  });

  it('serializes revision-based updates and exclusive creation across independent sessions', async () => {
    const second = await new ProjectSession(root).initialize();
    const original = await session.readSource({ path: 'film.cut' });
    const updates = await Promise.allSettled([
      session.save({
        file: 'film.cut',
        source: source + '\n// editor A',
        expectedRevision: original.revision
      }),
      second.save({
        file: 'film-link.cut',
        source: source + '\n// editor B',
        expectedRevision: original.revision
      })
    ]);
    expect(
      updates.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      updates.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    await expect(
      session.save({ file: 'film.cut', source })
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' });
    const creates = await Promise.allSettled([
      session.save({
        file: 'nested/new.cut',
        source: source.replaceAll('media/', '../media/'),
        create: true
      }),
      second.save({
        file: 'nested-alias/new.cut',
        source: source.replaceAll('media/', '../media/'),
        create: true
      })
    ]);
    expect(
      creates.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      creates.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(
      (await session.readSource({ path: 'nested/new.cut' })).revision
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('can save drafts while returning diagnostics and rejecting out-of-project references', async () => {
    const draft = await session.save({
      file: 'draft.cut',
      source: 'film "Draft" { fps bananas }',
      create: true
    });
    expect(
      draft.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ).toBe(true);
    await expect(
      session.save({
        file: 'unsafe.cut',
        source: source.replace('media/red.mp4', '../outside.mp4'),
        create: true
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('exports new real MP4, native Resolve, Premiere and XML files without changing source', async () => {
    const before = await session.readSource({ path: 'film.cut' });
    for (const format of ['mp4', 'drp', 'prproj', 'xml'] as const) {
      const result = await session.export({
        file: 'film.cut',
        output: `output/movie.${format}`,
        format
      });
      expect(result.path).toBe(`output/movie.${format}`);
      expect((await stat(result.absolutePath)).size).toBeGreaterThan(100);
      await expect(
        session.export({ file: 'film.cut', output: result.path, format })
      ).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
      if (format === 'mp4')
        expect((await probeMedia(result.absolutePath)).hasVideo).toBe(true);
      if (format === 'drp')
        expect((await readFile(result.absolutePath)).subarray(0, 2).toString()).toBe('PK');
      if (format === 'prproj')
        expect(
          gunzipSync(await readFile(result.absolutePath)).toString()
        ).toContain('<PremiereData');
      if (format === 'xml')
        expect(await readFile(result.absolutePath, 'utf8')).toContain('<xmeml');
    }
    expect((await session.readSource({ path: 'film.cut' })).revision).toBe(
      before.revision
    );
  });

  it('publishes exactly one of two concurrent exports through equivalent parent links', async () => {
    const results = await Promise.allSettled([
      session.export({ file: 'film.cut', output: 'nested/racing.xml' }),
      session.export({ file: 'film.cut', output: 'nested-alias/racing.xml' })
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(
      await readFile(path.join(root, 'nested/racing.xml'), 'utf8')
    ).toContain('<xmeml');
    expect(
      (await readdir(path.join(root, 'nested'))).some((file) =>
        file.startsWith('.cut-export-')
      )
    ).toBe(false);
  });

  it('restricts playlist demuxers even when disguised as a normal media file', async () => {
    const disguised = path.join(root, 'media', 'playlist.mp4');
    await writeFile(
      disguised,
      `ffconcat version 1.0\nfile '${path.join(directory, 'outside.mp4')}'\n`
    );
    const dangerous = source.replace('media/red.mp4', 'media/playlist.mp4');
    // A broad, unconfined probe may accept the playlist. Its cache must not bypass confined probing.
    await compile(dangerous, path.join(root, 'film.cut'));
    const result = await session.check({ file: 'film.cut', source: dangerous });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) =>
        /whitelist|not allowed|invalid data|not on/i.test(diagnostic.message)
      )
    ).toBe(true);
    await writeFile(path.join(root, 'media', 'playlist.m3u8'), '#EXTM3U\n');
    await expect(
      session.check({
        file: 'film.cut',
        source: source.replace('media/red.mp4', 'media/playlist.m3u8')
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('cancels operations without publishing an output', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.export({
        file: 'film.cut',
        output: 'cancelled.mp4',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      session.save({
        file: 'cancelled.cut',
        source,
        create: true,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(root)).not.toContain('cancelled.mp4');
    expect(await readdir(root)).not.toContain('cancelled.cut');
  });
});
