import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const source = `film "MCP fixture" {
  resolution 160x90
  fps 24
  track video "Top" layer 3 { clip "source with spaces.mp4" { in 0.25s out 1.25s at 0s opacity 0.5 } }
  track video "Bottom" layer 1 { clip "source with spaces.mp4" from 0s to 1s at 0s }
  track audio "Score" layer 2 { clip "source with spaces.mp4" { in 0.25s out 1.25s at 0s gain -6dB } }
}`;
type Json = Record<string, any>;
function data(result: CallToolResult): Json {
  return result.structuredContent as Json;
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}
async function until(condition: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function processResult(
  args: string[],
  endInput = true
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (endInput) child.stdin.end();
  });
}

describe('official MCP SDK over actual local stdio', () => {
  let directory: string, root: string, bundle: string, outside: string;
  let client: Client, transport: StdioClientTransport;
  const protocolErrors: string[] = [];
  let stderr = '';
  const call = (name: string, args: Json = {}) => client.callTool({ name, arguments: args });
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'CUT MCP integration '));
    root = path.join(directory, 'selected project');
    outside = path.join(directory, 'outside');
    await Promise.all([mkdir(root), mkdir(outside), mkdir(path.join(directory, 'runtime'))]);
    bundle = path.join(directory, 'runtime', 'mcp.mjs');
    await build({
      entryPoints: ['src/mcp/server.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import {createRequire as __cutCreateRequire} from 'node:module'; import {fileURLToPath as __cutFileURL} from 'node:url'; import {dirname as __cutDirname} from 'node:path'; const require=__cutCreateRequire(import.meta.url); const __dirname=__cutDirname(__cutFileURL(import.meta.url));"
      }
    });
    await cp('resources/resolve', path.join(directory, 'runtime', 'resolve'), { recursive: true });
    await cp('resources/premiere', path.join(directory, 'runtime', 'premiere'), {
      recursive: true
    });
    await mkdir(path.join(directory,'runtime/graphics'));
    await cp('node_modules/@resvg/resvg-wasm/index_bg.wasm',path.join(directory,'runtime/graphics/resvg.wasm'));
    execFileSync(process.env.CUT_FFMPEG || 'ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=24:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path.join(root, 'source with spaces.mp4')
    ]);
    await writeFile(path.join(root, 'film.cut'), source);
    await writeFile(
      path.join(outside, 'private.cut'),
      'Outside source must not be read or overwritten.'
    );
    await symlink(outside, path.join(root, 'escape'));
    await symlink(path.join(outside, 'private.cut'), path.join(root, 'escape.cut'));
    await symlink(path.join(root, 'source with spaces.mp4'), path.join(root, 'wrong-kind.cut'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--project', root],
      cwd: outside,
      stderr: 'pipe',
      env: getDefaultEnvironment()
    });
    transport.stderr?.on('data', (value) => {
      stderr += value.toString();
    });
    client = new Client(
      { name: 'cut-studio-integration-client', version: '1.0.0' },
      { capabilities: {} }
    );
    client.onerror = (error) => {
      protocolErrors.push(error.message);
    };
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`MCP connection failed: ${String(error)}\n${stderr}`);
    }
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('negotiates with the official client and lists described, validated tools', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cut_audition',
      'cut_check',
      'cut_contact_sheet',
      'cut_edit',
      'cut_export',
      'cut_export_plan',
      'cut_list_project',
      'cut_read_source',
      'cut_review',
      'cut_save_source',
      'cut_search_dialogue',
      'cut_timeline'
    ]);
    expect(client.getInstructions()).toContain('35,280,000 ticks');
    expect(client.getInstructions()).toContain('revision');
    expect(client.getInstructions()).toContain('track video "Picture" layer 1');
    expect(client.getInstructions()).toContain('track audio "Music" layer 2');
    const read = tools.find((tool) => tool.name === 'cut_read_source')!;
    expect(read.annotations?.readOnlyHint).toBe(true);
    expect(read.inputSchema.additionalProperties).toBe(false);
    const list = await call('cut_list_project');
    expect(list.isError).not.toBe(true);
    const listing = data(list);
    expect(listing.files.map((file: Json) => file.path)).toEqual([
      'film.cut',
      'source with spaces.mp4'
    ]);
    expect(listing.root).toContain('selected project');
    const invalid = await call('cut_read_source', { file: 'film.cut', project: outside });
    expect(invalid.isError).toBe(true);
  });

  it('reads revisions, checks unsaved proposals and returns precise numbered timelines', async () => {
    const read = data(await call('cut_read_source', { file: 'film.cut' }));
    expect(read.source).toBe(source);
    expect(read.revision).toMatch(/^[a-f0-9]{64}$/);
    const before = await readFile(path.join(root, 'film.cut'));
    const proposal = source.replace('opacity 0.5', 'opacity 0.25');
    const check = await call('cut_check', { file: 'film.cut', source: proposal });
    expect(check.isError).not.toBe(true);
    expect(data(check).valid).toBe(true);
    const timeline = data(await call('cut_timeline', { file: 'film.cut' }));
    expect(timeline.revision).toBe(read.revision);
    expect(timeline.timeline.duration).toBe(35_280_000);
    expect(timeline.film).toBeUndefined();
    expect(timeline.timebase.ticksPerSecond).toBe(35_280_000);
    expect(timeline.media).toHaveLength(1);
    expect(timeline.timeline.tracks[2].clips[0].media).toBeUndefined();
    expect(timeline.timeline.tracks[2].clips[0].range.start.line).toBe(3);
    expect(timeline.timeline.tracks.map((track: Json) => [track.kind, track.layer])).toEqual([
      ['video', 1],
      ['video', 2],
      ['video', 3],
      ['audio', 1],
      ['audio', 2]
    ]);
    expect(timeline.timeline.tracks[2].clips[0]).toMatchObject({
      in: 8_820_000,
      out: 44_100_000,
      at: 0,
      layer: 3
    });
    expect(await readFile(path.join(root, 'film.cut'))).toEqual(before);
    const invalid = data(
      await call('cut_check', {
        file: 'film.cut',
        source: source.replace('out 1.25s', 'out bananas')
      })
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.some((item: Json) => item.code === 'invalid-time')).toBe(true);
  });

  it('returns embedded images, playable sound and A/B movies, and exposes the same edit and handoff operations',async()=>{
    const asset='source with spaces.mp4';
    const doc='studio.cut';
    const candidate=source.replace('clip "'+asset+'" from','clip "'+asset+'" as shot from');
    await writeFile(path.join(root,doc),candidate);
    await writeFile(path.join(root,'source with spaces.srt'),'1\n00:00:00,000 --> 00:00:00,650\nThe second take.\n');
    const sheet=await call('cut_contact_sheet',{file:asset,count:2});
    expect(data(sheet).reviews[0].frames).toHaveLength(2);
    expect(sheet.content.some(x=>x.type==='image' && x.mimeType==='image/png')).toBe(true);
    const speech=await call('cut_search_dialogue',{query:'second take',file:asset});
    expect(data(speech).matches[0]).toMatchObject({file:asset,from:0,to:.65});
    const sound=await call('cut_audition',{file:asset,from:0,seconds:.65});
    expect(sound.content.some(x=>x.type==='audio' && x.mimeType==='audio/mpeg')).toBe(true);
    const read=data(await call('cut_read_source',{file:doc}));
    const edit=await call('cut_edit',{file:doc,operation:{op:'trim',target:'shot',edge:'out',frames:-2},apply:true,expectedRevision:read.revision});
    expect(data(edit).applied).toBe(true);
    const review=await call('cut_review',{file:doc,cue:'shot.end',seconds:.5,alternateSource:candidate,embedMovie:true});
    expect(data(review).reviews).toHaveLength(2);
    expect(review.content.filter(x=>x.type==='resource' && x.resource.mimeType==='video/mp4')).toHaveLength(2);
    const handoff=await call('cut_export_plan',{file:doc});
    expect(data(handoff)).toMatchObject({editable:3,rendered:[]});
    await call('cut_save_source',data(edit).undo);expect((await readFile(path.join(root,doc),'utf8'))).toBe(candidate);
  });

  it('discovers the agent workflow and proposes, reviews, commits and undoes a batch with one revision',async()=>{
    const resources=await client.listResources();
    const guide=resources.resources.find(r=>r.uri==='cut-studio://reference/editing');
    expect(guide).toBeDefined();
    const reference=await client.readResource({uri:guide!.uri});
    expect(reference.contents[0]).toMatchObject({mimeType:'application/json'});
    const doc='batch.cut';
    await writeFile(path.join(root,doc),source.replace('clip "source with spaces.mp4" from','clip "source with spaces.mp4" as wide from'));
    const initial=data(await call('cut_read_source',{file:doc}));
    const seq=data(await call('cut_timeline',{file:doc,detail:'compact'}));
    expect(seq.timeline.tracks[0].clips[0]).not.toHaveProperty('fields');
    const operations=[{op:'trim',target:'wide',edge:'out',frames:-3},{op:'place',target:'wide',layer:4}];
    const draft=data(await call('cut_edit',{file:doc,operations}));
    expect(draft.applied).toBe(false);
    expect(draft.namedTimingChanges).toEqual([expect.objectContaining({name:'wide',before:expect.objectContaining({layer:'V1'}),after:expect.objectContaining({layer:'V4'})})]);
    const failed=await call('cut_edit',{file:doc,operations:[...operations,{op:'split',target:'wide',at:'10s'}],apply:true,expectedRevision:initial.revision});
    expect(data(failed).error).toMatchObject({code:'INVALID_EDIT_STEP',stepIndex:2,operation:'split'});
    expect(data(await call('cut_read_source',{file:doc})).revision).toBe(initial.revision);
    const committed=data(await call('cut_edit',{file:doc,operations,apply:true,expectedRevision:initial.revision}));
    expect(committed.steps).toBe(2);expect(committed.source).toBe(draft.source);
    await call('cut_save_source',committed.undo);
    expect(data(await call('cut_read_source',{file:doc})).source).toBe(initial.source);
  });

  it('requires current revisions, preserves concurrent changes, and creates new sources exclusively', async () => {
    const read = data(await call('cut_read_source', { file: 'film.cut' }));
    const changed = source.replace('MCP fixture', 'Changed through MCP');
    const saved = await call('cut_save_source', {
      file: 'film.cut',
      source: changed,
      expectedRevision: read.revision
    });
    expect(saved.isError).not.toBe(true);
    expect(data(saved).revision).not.toBe(read.revision);
    const stale = await call('cut_save_source', {
      file: 'film.cut',
      source,
      expectedRevision: read.revision
    });
    expect(stale.isError).toBe(true);
    expect(stale.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/changed on disk|current version/i)
        })
      ])
    );
    expect(data(stale).error.code).toBe('REVISION_CONFLICT');
    const missingRevision = await call('cut_save_source', { file: 'film.cut', source });
    expect(missingRevision.isError).toBe(true);
    expect(data(missingRevision).error.code).toBe('REVISION_REQUIRED');
    expect(await readFile(path.join(root, 'film.cut'), 'utf8')).toBe(changed);
    const created = await call('cut_save_source', { file: 'new.cut', source, create: true });
    expect(created.isError).not.toBe(true);
    expect(
      (await call('cut_save_source', { file: 'new.cut', source: 'Do not replace', create: true }))
        .isError
    ).toBe(true);
    expect(await readFile(path.join(root, 'new.cut'), 'utf8')).toBe(source);
    await call('cut_save_source', {
      file: 'film.cut',
      source,
      expectedRevision: data(saved).revision
    });
  });

  it('confines reads, source assets, saves and outputs to the explicitly selected root', async () => {
    const attempts = [
      ['cut_read_source', { file: '../outside/private.cut' }],
      ['cut_read_source', { file: path.join(outside, 'private.cut') }],
      ['cut_read_source', { file: 'escape.cut' }],
      ['cut_read_source', { file: 'wrong-kind.cut' }],
      ['cut_save_source', { file: 'escape/new.cut', source, create: true }],
      [
        'cut_check',
        {
          file: 'film.cut',
          source: source.replaceAll('source with spaces.mp4', '../outside/private.mp4')
        }
      ],
      ['cut_export', { file: 'film.cut', output: '../outside/film.xml' }],
      ['cut_export', { file: 'film.cut', output: 'source with spaces.mp4' }]
    ] as const;
    for (const [name, args] of attempts)
      expect((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(await readFile(path.join(outside, 'private.cut'), 'utf8')).toBe(
      'Outside source must not be read or overwritten.'
    );
    expect(await exists(path.join(outside, 'new.cut'))).toBe(false);
  });

  it('writes real new XML, MP4, Resolve and Premiere outputs without replacing sources or previous exports', async () => {
    const before = await readFile(path.join(root, 'film.cut'));
    for (const format of ['xml', 'mp4', 'drp', 'prproj']) {
      const output = `exports/film.${format}`;
      const exported = await call('cut_export', { file: 'film.cut', output, format });
      expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
      expect(data(exported)).toMatchObject({ path: output, format });
      const bytes = await readFile(path.join(root, output));
      expect(bytes.length).toBeGreaterThan(1000);
      if (format === 'xml') {
        expect(bytes.toString()).toContain('<xmeml');
        expect(data(exported).warnings.join(' ')).toMatch(/Opacity/);
      }
      if (format === 'drp') expect(bytes.subarray(0, 2).toString()).toBe('PK');
      if (format === 'prproj') expect(gunzipSync(bytes).toString()).toContain('<PremiereData');
      if (format === 'mp4') {
        const metadata = JSON.parse(
          execFileSync(
            process.env.CUT_FFPROBE || 'ffprobe',
            [
              '-v',
              'error',
              '-show_format',
              '-show_streams',
              '-of',
              'json',
              path.join(root, output)
            ],
            { encoding: 'utf8' }
          )
        );
        expect(Number(metadata.format.duration)).toBeCloseTo(1, 2);
        expect(metadata.streams.map((stream: Json) => stream.codec_name)).toEqual(['h264', 'aac']);
      }
      expect((await call('cut_export', { file: 'film.cut', output, format })).isError).toBe(true);
      expect(await readFile(path.join(root, output))).toEqual(bytes);
    }
    expect(await readFile(path.join(root, 'film.cut'))).toEqual(before);
    expect(
      (await call('cut_export', { file: 'film.cut', output: 'mismatch.xml', format: 'mp4' }))
        .isError
    ).toBe(true);
  }, 60_000);

  it('cancels an actual render through the SDK and keeps serving without partial outputs', async () => {
    const controller = new AbortController();
    let progress = 0;
    const demanding = source
      .replace('160x90', '1920x1080')
      .replace('fps 24', 'fps 120')
      .replaceAll('out 1.25s', 'out 2.25s')
      .replaceAll('to 1s', 'to 2s');
    let cancelled = false;
    try {
      await client.callTool(
        {
          name: 'cut_export',
          arguments: { file: 'film.cut', source: demanding, output: 'cancelled.mp4' }
        },
        {
          signal: controller.signal,
          timeout: 60_000,
          onprogress: () => {
            progress++;
            controller.abort();
          }
        }
      );
    } catch (error) {
      cancelled = /abort|cancel/i.test(String(error));
    }
    expect(progress).toBeGreaterThan(0);
    expect(cancelled).toBe(true);
    await until(
      async () => !(await readdir(root)).some((file) => file.startsWith('.cut-export-')),
      'cancelled render cleanup'
    );
    expect(await exists(path.join(root, 'cancelled.mp4'))).toBe(false);
    expect(data(await call('cut_check', { file: 'film.cut' })).valid).toBe(true);
    expect(protocolErrors).toEqual([]);
    expect(stderr).not.toMatch(/unhandled|SyntaxError|stdout/i);
  }, 60_000);

  it('supports a modern official-client connection and clean EOF shutdown with protocol-only stdout', async () => {
    const modernTransport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--project', root],
      cwd: outside,
      stderr: 'pipe'
    });
    const modern = new Client(
      { name: 'cut-modern-client', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await modern.connect(modernTransport);
      expect((await modern.listTools()).tools).toHaveLength(12);
    } finally {
      await modern.close();
    }
    const eof = await processResult([bundle, '--project', root]);
    expect(eof).toEqual({ code: 0, stdout: '', stderr: '' });
    const missing = await processResult([bundle]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('--project /absolute/path');
    const relative = await processResult([bundle, '--project', '.']);
    expect(relative.code).toBe(1);
    expect(relative.stdout).toBe('');
  });

  it('cleans up an in-flight export when its official-client connection closes', async () => {
    const childTransport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--project', root],
      cwd: outside,
      stderr: 'pipe'
    });
    const childClient = new Client(
      { name: 'cut-shutdown-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await childClient.connect(childTransport);
    const pid = childTransport.pid!;
    let closing: Promise<void> | undefined;
    try {
      await childClient.callTool(
        {
          name: 'cut_export',
          arguments: {
            file: 'film.cut',
            source: source.replace('160x90', '1920x1080').replace('fps 24', 'fps 120'),
            output: 'disconnected.mp4'
          }
        },
        {
          timeout: 60_000,
          onprogress: () => {
            closing ??= childClient.close();
          }
        }
      );
    } catch {
      // The client closes its own request and connection before the export can answer.
    } finally {
      await (closing ?? childClient.close());
    }
    expect(closing).toBeDefined();
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'stdio child exit');
    await until(
      async () => !(await readdir(root)).some((file) => file.startsWith('.cut-export-')),
      'disconnected export cleanup'
    );
    expect(await exists(path.join(root, 'disconnected.mp4'))).toBe(false);
  });
});
