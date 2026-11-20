import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../src/standalone/server';
import { probeMedia } from '../src/engine';

let directory: string, project: string, base: string, session: Awaited<ReturnType<typeof createStudioServer>>;
const source = `film "Server film" { resolution 160x90 fps 24 track video "Picture" { clip "red.mp4" from 0s to 1s at 0s } track audio "Sound" { clip "tone.wav" { at 0s gain -12dB } } }`;
function request(route: string, options: RequestInit = {}, authenticated = true): Promise<Response> {
  return fetch(base + route, {
    ...options,
    headers: { ...(authenticated ? { 'X-Cut-Token': session.token } : {}), ...options.headers }
  });
}
function post(route: string, value: unknown): Promise<Response> {
  return request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cut-http-'));
  project = path.join(directory, 'project');
  await mkdir(project);
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(project, 'node_modules'));
  await mkdir(path.join(project, 'output'));
  await writeFile(
    path.join(directory, 'assets', 'index.html'),
    '<!doctype html><script type="application/json" id="cut-bootstrap">__CUT_BOOTSTRAP__</script>'
  );
  await writeFile(path.join(project, 'film.cut'), source);
  await writeFile(path.join(project, '.secret'), 'hidden');
  await writeFile(path.join(project, 'node_modules', 'hidden.cut'), source);
  await writeFile(path.join(directory, 'outside.cut'), 'private');
  await writeFile(path.join(project, 'settings.json'), '{"privateSetting":true}');
  await symlink(path.join(directory, 'outside.cut'), path.join(project, 'escape.cut'));
  await symlink(directory, path.join(project, 'escape-dir'));
  await symlink(path.join(project, 'settings.json'), path.join(project, 'settings-link.cut'));
  await symlink(path.join(project, 'output'), path.join(project, 'output-alias'));
  const ffmpeg = process.env.CUT_FFMPEG || 'ffmpeg';
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
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
    path.join(project, 'red.mp4')
  ]);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    '-y',
    path.join(project, 'tone.wav')
  ]);
  session = await createStudioServer(project, { assetsDir: path.join(directory, 'assets') });
  await new Promise<void>((resolve) => session.server.listen(0, '127.0.0.1', resolve));
  const address = session.server.address();
  if (!address || typeof address === 'string') throw new Error('No local address');
  base = `http://127.0.0.1:${address.port}`;
}, 30000);
afterAll(async () => {
  if (session) await session.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('standalone local HTTP studio', () => {
  it('bootstraps the local session and protects every API and media route', async () => {
    const home = await request('/', {}, false);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(session.token);
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(home.headers.has('access-control-allow-origin')).toBe(false);
    expect((await request('/api/tree', {}, false)).status).toBe(401);
    expect((await request('/media/not-a-media-id', {}, false)).status).toBe(401);
    expect((await request('/api/tree', { headers: { 'X-Cut-Token': 'incorrect' } }, false)).status).toBe(401);
    expect((await request('/api/tree', { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await request('/api/tree?token=' + session.token, {}, false)).status).toBe(200);
  });
  it('lists project files while excluding hidden files, dependencies, outputs and symbolic links', async () => {
    const response = await request('/api/tree');
    const result = await response.json();
    expect(result.root).toBe(session.root);
    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: 'film.cut', name: 'film.cut', kind: 'cut' },
        { path: 'red.mp4', name: 'red.mp4', kind: 'video' },
        { path: 'tone.wav', name: 'tone.wav', kind: 'audio' }
      ])
    );
    expect(result.files.some((entry: { path: string }) => /hidden|secret|escape/.test(entry.path))).toBe(
      false
    );
  });
  it('rejects traversal and symlink escapes in reads, writes, media references and renders', async () => {
    for (const file of [
      '../outside.cut',
      path.join(directory, 'outside.cut'),
      'escape.cut',
      'escape-dir/outside.cut',
      '..\\outside.cut'
    ])
      expect((await request('/api/file?path=' + encodeURIComponent(file))).status).toBe(403);
    expect((await post('/api/save', { file: '../outside.cut', source: 'overwrite' })).status).toBe(403);
    expect((await post('/api/save', { file: 'escape-dir/new.cut', source: 'overwrite' })).status).toBe(403);
    expect((await post('/api/file', { file: 'film.cut' })).status).toBe(404);
    expect(
      (await post('/api/compile', { file: 'film.cut', source: source.replace('red.mp4', '../red.mp4') }))
        .status
    ).toBe(403);
    expect((await post('/api/render', { file: 'film.cut', source, output: '../outside.mp4' })).status).toBe(
      403
    );
    expect(
      (await post('/api/render', { file: 'film.cut', source, output: 'escape-dir/outside.mp4' })).status
    ).toBe(403);
    expect(await readFile(path.join(directory, 'outside.cut'), 'utf8')).toBe('private');
  });
  it('prevents a .cut symbolic link from reading or modifying a different file type inside the project', async () => {
    expect((await request('/api/file?path=settings-link.cut')).status).toBe(403);
    expect((await post('/api/save', { file: 'settings-link.cut', source: 'overwritten' })).status).toBe(403);
    expect((await post('/api/compile', { file: 'settings-link.cut', source })).status).toBe(403);
    expect(await readFile(path.join(project, 'settings.json'), 'utf8')).toBe('{"privateSetting":true}');
  });
  it('rejects render aliases that would overwrite the CUT document or referenced media', async () => {
    const files = [path.join(project, 'film.cut'), path.join(project, 'red.mp4')],
      originals = await Promise.all(files.map((file) => readFile(file)));
    for (const kind of ['symbolic', 'hard'])
      for (let index = 0; index < files.length; index++) {
        const name = `${kind}-protected-${index}.mp4`,
          output = path.join(project, name);
        if (kind === 'symbolic') await symlink(files[index], output);
        else await link(files[index], output);
        const response = await post('/api/render', { file: 'film.cut', source, output: name });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain('must not overwrite');
        expect(await readFile(files[index])).toEqual(originals[index]);
      }
  });
  it('reads and atomically saves CUT source with conflict detection', async () => {
    const file = await (await request('/api/file?path=film.cut')).json();
    expect(file.source).toBe(source);
    expect(file.mtime).toBeGreaterThan(0);
    const saved = await post('/api/save', {
      file: 'film.cut',
      source: source + '\n// saved',
      mtime: file.mtime
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).mtime).toBeGreaterThan(0);
    await utimes(path.join(project, 'film.cut'), new Date(), new Date(Date.now() + 2000));
    expect((await post('/api/save', { file: 'film.cut', source, mtime: file.mtime })).status).toBe(409);
    const created = await post('/api/save', { file: 'nested/new.cut', source });
    expect(created.status).toBe(200);
    expect(await readFile(path.join(project, 'nested/new.cut'), 'utf8')).toBe(source);
    expect((await post('/api/save', { file: 'red.mp4', source })).status).toBe(400);
  });
  it('rejects a stale content revision even if the saved timestamp matches', async () => {
    const file = 'versioned.cut';
    const { revision } = await (await post('/api/save', { file, source })).json();
    await writeFile(path.join(project, file), source + '\n// another editor');
    const current = await (await request('/api/file?path=' + file)).json();
    expect(current.revision).not.toEqual(revision);
    const stale = await post('/api/save', { file, source: 'stale', revision, mtime: current.mtime });
    expect(stale.status).toBe(409);
    expect(await readFile(path.join(project, file), 'utf8')).toBe(current.source);
  });
  it('serializes saves from concurrent tabs and rejects a stale writer', async () => {
    const current = await (await request('/api/file?path=film.cut')).json();
    const responses = await Promise.all([
      post('/api/save', { file: 'film.cut', source: source + '\n// tab A', mtime: current.mtime }),
      post('/api/save', { file: 'film.cut', source: source + '\n// tab B', mtime: current.mtime })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = await (await request('/api/file?path=film.cut')).json();
    expect([source + '\n// tab A', source + '\n// tab B']).toContain(saved.source);
    expect(saved.mtime).not.toBe(current.mtime);
    expect((await post('/api/save', { file: 'film.cut', source })).status).toBe(409);
    const creations = await Promise.all([
      post('/api/save', { file: 'nested/concurrent.cut', source: source + '\n// new A' }),
      post('/api/save', { file: 'nested/concurrent.cut', source: source + '\n// new B' })
    ]);
    expect(creations.map((response) => response.status).sort()).toEqual([200, 409]);
  });
  it('uses the shared compiler and provides source diagnostics for invalid media', async () => {
    const response = await post('/api/compile', { file: 'film.cut', source });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.timeline.name).toBe('Server film');
    expect(result.timeline.duration).toBe(35_280_000);
    expect(result.diagnostics).toEqual([]);
    const invalid = await (
      await post('/api/compile', { file: 'film.cut', source: source.replace('red.mp4', 'missing.mp4') })
    ).json();
    expect(invalid.timeline).toBeUndefined();
    expect(invalid.diagnostics[0].severity).toBe('error');
  });
  it('renders a current audible preview and streams authenticated media with byte ranges', async () => {
    const response = await post('/api/preview', { file: 'film.cut', source, position: 0 });
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.direct).toBe(false);
    expect(preview.from).toBe(0);
    expect(preview.to).toBe(1);
    expect(preview.sourceIn).toBe(0);
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    const all = await request(preview.src, {}, false);
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toBe('video/mp4');
    const bytes = Buffer.from(await all.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    const partial = await request(preview.src, { headers: { Range: 'bytes=10-29' } }, false);
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 10-29/${bytes.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(10, 30));
    const suffix = await request(preview.src, { headers: { Range: 'bytes=-8' } }, false);
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(-8));
    expect((await request(preview.src, { headers: { Range: `bytes=${bytes.length}-` } }, false)).status).toBe(
      416
    );
    expect((await request(preview.src.split('?')[0], {}, false)).status).toBe(401);
    const cached = await (await post('/api/preview', { file: 'film.cut', source, position: 0 })).json();
    expect(cached.cached).toBe(true);
  });
  it('exports a real MP4 through a progress job', async () => {
    const response = await post('/api/render', { file: 'film.cut', source });
    expect(response.status).toBe(202);
    const { id } = await response.json();
    let job: { state: string; fraction: number; output?: string; error?: string } = {
      state: 'rendering',
      fraction: 0
    };
    const deadline = Date.now() + 15000;
    while (job.state === 'rendering' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await (await request('/api/jobs/' + id)).json();
    }
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('complete');
    expect(job.fraction).toBe(1);
    expect(job.output).toBe('output/film.mp4');
    const info = await probeMedia(path.join(project, job.output!));
    expect(info.hasVideo && info.hasAudio).toBe(true);
    expect(info.duration).toBe(35_280_000);
  });
  it.each(['prproj', 'drp', 'xml'])(
    'writes a %s project through the studio and protects existing output',
    async (format) => {
      const output = 'output/sequence.' + format;
      const payload = { file: 'film.cut', source, format, output };
      const response = await post('/api/export', payload);
      expect(response.status).toBe(202);
      const { id } = await response.json();
      let job = await (await request('/api/jobs/' + id)).json();
      const deadline = Date.now() + 30000;
      while (job.state === 'rendering' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        job = await (await request('/api/jobs/' + id)).json();
      }
      expect(job.error).toBeUndefined();
      expect(job.state).toBe('complete');
      expect(job.output).toBe(output);
      const bytes = Buffer.from(await (await request(job.src)).arrayBuffer());
      if (format === 'drp') {
        expect(bytes.subarray(0, 2).toString()).toBe('PK');
      } else {
        const xml = format === 'prproj' ? gunzipSync(bytes).toString() : bytes.toString();
        expect(xml).toContain(format === 'prproj' ? '<PremiereData' : '<xmeml');
      }
      expect(await (await post('/api/export', payload)).json()).toEqual({ exists: true });
      expect(await readFile(path.join(project, output))).toEqual(bytes);
    },
    35000
  );
  it('rejects unsupported project formats, output suffixes and project paths outside the folder', async () => {
    const payload = { file: 'film.cut', source, format: 'prproj' };
    expect((await post('/api/export', { ...payload, output: 'bad.xml' })).status).toBe(400);
    expect((await post('/api/export', { ...payload, format: 'avi' })).status).toBe(400);
    expect((await post('/api/export', { ...payload, output: '../outside.prproj' })).status).toBe(403);
  });
  it('prevents concurrent render jobs from silently replacing the same destination', async () => {
    const longer = source.replace(
      'at 0s } track audio',
      'at 0s clip "red.mp4" from 0s to 1s at 119s } track audio'
    );
    const responses = await Promise.all([
      post('/api/render', { file: 'film.cut', source: longer, output: 'output/concurrent.mp4' }),
      post('/api/render', { file: 'film.cut', source: longer, output: 'output-alias/concurrent.mp4' })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const accepted = responses.find((response) => response.status === 202)!;
    const { id } = await accepted.json();
    expect((await post('/api/jobs/' + id + '/cancel', {})).status).toBe(200);
    let job = await (await request('/api/jobs/' + id)).json();
    const deadline = Date.now() + 3000;
    while (job.state === 'rendering' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await (await request('/api/jobs/' + id)).json();
    }
    expect(job.state).toBe('cancelled');
  });
  it('supports cancelling export jobs without writing a completed file', async () => {
    const response = await post('/api/render', { file: 'film.cut', source, output: 'output/cancelled.mp4' });
    const { id } = await response.json();
    expect((await post('/api/jobs/' + id + '/cancel', {})).status).toBe(200);
    let job = await (await request('/api/jobs/' + id)).json();
    const deadline = Date.now() + 3000;
    while (job.state === 'rendering' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await (await request('/api/jobs/' + id)).json();
    }
    expect(job.state).toBe('cancelled');
    await expect(stat(path.join(project, 'output/cancelled.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
