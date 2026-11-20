import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, watch } from 'node:fs';
import { DocumentConflictError, readDocument, saveDocument, type DocumentVersion } from '../project/documents';
import {
  access,
  readdir,
  readFile,
  realpath,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { compile } from '../core/compiler';
import { studioActions, runStudioAction, type ActionName } from '../project/actions';
import { ProjectSession } from '../mcp/project';
import { ProjectAccessError, ProjectPaths } from '../project/paths';
import { parseTime, previewWindow, secondsToTicks, ticksToSeconds } from '../core/time';
import type { CompileResult, Timeline } from '../core/types';
import { assertSafeOutput, atomicWriteOutput, findDirectPreview, render, renderPreview } from '../engine';
import { exportFcp7 } from '../exporters/fcp7';
import { exportResolve } from '../exporters/resolve';
import { exportPremiere } from '../exporters/premiere';
import { isExportFormat, type ExportFormat } from './export-formats';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
interface FileEntry {
  path: string;
  name: string;
  kind: 'cut' | 'video' | 'audio' | 'other';
}
interface Job {
  id: string;
  state: 'rendering' | 'complete' | 'error' | 'cancelled';
  fraction: number;
  message?: string;
  output?: string;
  src?: string;
  error?: string;
  warnings?: string[];
  controller: AbortController;
}
interface Session {
  server: http.Server;
  token: string;
  root: string;
  close: () => Promise<void>;
}
const mime: Record<string, string> = {
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.drp': 'application/octet-stream',
  '.prproj': 'application/octet-stream',
  '.xml': 'application/xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};
const fileKind = (name: string): FileEntry['kind'] =>
  /\.cut$/i.test(name)
    ? 'cut'
    : /\.(mp4|mov|m4v|webm|mkv|avi|mxf|mpg|mpeg|mts|m2ts|png|jpe?g|webp)$/i.test(name)
      ? 'video'
      : /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff|wave|opus|wma)$/i.test(name)
        ? 'audio'
        : 'other';
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024)
      throw new HttpError(413, 'Request is too large. CUT documents may contain up to 2 MB of source.');
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Send a JSON object in the request body.');
  }
}
function stringField(value: Record<string, unknown>, name: string): string {
  const result = value[name];
  if (typeof result !== 'string') throw new HttpError(400, `“${name}” must be a string.`);
  return result;
}

async function writeExport(
  format: ExportFormat,
  timeline: Timeline,
  output: string,
  job: Job,
  from?: number,
  to?: number
) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  if (format === 'drp') {
    job.warnings = (await exportResolve(timeline, { output, signal })).warnings;
    return;
  }
  if (format === 'prproj') {
    const result = await exportPremiere(timeline, {
      output,
      signal,
      onProgress(step) {
        job.fraction = step.fraction;
        job.message = step.message;
      }
    });
    job.warnings = result.warnings;
    return;
  }
  if (format === 'xml') {
    const sequence = exportFcp7(timeline);
    await atomicWriteOutput(timeline, output, sequence.xml);
    job.warnings = sequence.warnings;
    return;
  }
  await render(timeline, {
    output,
    from,
    to,
    signal,
    onProgress(progress) {
      job.fraction = progress.fraction;
    }
  });
}

/** A local, token-protected HTTP shell around the exact same compiler and renderer as the CLI. */
export async function createStudioServer(
  projectRoot: string,
  options: { assetsDir?: string } = {}
): Promise<Session> {
  const project = await ProjectPaths.open(projectRoot);
  const root = project.root;
  const editing=await new ProjectSession(root).initialize();
  const token = randomBytes(32).toString('hex'),
    media = new Map<string, string>(),
    jobs = new Map<string, Job>(),
    controllers = new Set<AbortController>(),
    jobTasks = new Set<Promise<void>>();
  const activeOutputs = new Map<string, string>();
  const assets =
    options.assetsDir || path.resolve(typeof __dirname === 'string' ? __dirname : process.cwd(), 'web');
  async function compileRequest(
    value: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ result: CompileResult; file: string; source: string }> {
    const file = await project.cut(stringField(value, 'file'), true),
      source = stringField(value, 'source');
    await project.validateAssets(source, file, signal);
    return { result: await compile(source, file, { signal, readScene: project.sceneReader(signal) }), file, source };
  }
  function registerMedia(file: string): string {
    const id = randomBytes(16).toString('hex');
    media.set(id, file);
    return `/media/${id}?token=${token}`;
  }
  async function tree(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    async function visit(directory: string): Promise<void> {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= 2000) return;
        if (
          entry.name.startsWith('.') ||
          ['node_modules', 'dist', 'output', 'coverage', 'target'].includes(entry.name)
        )
          continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile())
          entries.push({
            path: path.relative(root, file).split(path.sep).join('/'),
            name: entry.name,
            kind: fileKind(entry.name)
          });
        // Do not recurse into or expose symbolic links in the explorer.
      }
    }
    await visit(root);
    return entries;
  }
  async function streamMedia(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const stored = media.get(id);
    if (!stored) throw new HttpError(404, 'Media reference has expired. Refresh the preview.');
    const actual = await realpath(stored);
    project.relative(actual);
    const info = await stat(actual);
    if (!info.isFile()) throw new HttpError(404, 'Media file is not available.');
    const common = {
      'Content-Type': mime[path.extname(actual).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      let valid = !!match && !!(match[1] || match[2]);
      if (match) {
        if (!match[1]) {
          const length = Number(match[2]);
          start = Math.max(0, info.size - length);
          valid = valid && length > 0;
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
      }
      if (
        !valid ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= info.size ||
        end < start
      ) {
        response.writeHead(416, { ...common, 'Content-Range': `bytes */${info.size}` });
        response.end();
        return;
      }
      status = 206;
    }
    response.writeHead(status, {
      ...common,
      'Content-Length': Math.max(0, end - start + 1),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {})
    });
    if (request.method === 'HEAD' || info.size === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(actual, { start, end });
    stream.on('error', (error) => response.destroy(error));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    );
    void (async () => {
      const address = server.address(),
        port = address && typeof address !== 'string' ? address.port : 0;
      const host = request.headers.host;
      if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
        throw new HttpError(403, 'This server only accepts local requests.');
      const origin = request.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin))
        throw new HttpError(403, 'Cross-origin requests are not allowed.');
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`),
        route = url.pathname;
      const protectedRoute = route.startsWith('/api/') || route.startsWith('/media/');
      if (protectedRoute) {
        const supplied = request.headers['x-cut-token'] || url.searchParams.get('token') || '';
        if (
          typeof supplied !== 'string' ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          throw new HttpError(
            401,
            'Open CUT Studio from its local launch URL. A valid session token is required.'
          );
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && route.startsWith('/media/')) {
        await streamMedia(request, response, route.slice('/media/'.length));
        return;
      }
      if (request.method === 'GET' && route === '/api/tree') {
        json(response, 200, { root, files: await tree() });
        return;
      }
      if (request.method === 'GET' && route === '/api/file') {
        const relative = url.searchParams.get('path') || '';
        const { source, revision, mtime } = await readDocument(await project.cut(relative));
        json(response, 200, { file: relative, source, revision, mtime });
        return;
      }
      if (request.method === 'GET' && route === '/api/changes') {
        // Watch the directory: CUT and other editors save by replacing the document's inode.
        const relative = url.searchParams.get('file');
        if (relative) await project.cut(relative, true);
        const watcher = watch(root, { persistent: false, recursive: true }, (_event, name) => {
          if (!name || /\.cut$/i.test(name)) response.write('event: changed\ndata: ' + JSON.stringify({file:name?.split(path.sep).join('/')}) + '\n\n');
        });
        watcher.on('error', () => response.end());
        response.on('close', () => watcher.close());
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        // Reconnect or initial connect also catches writes between the first GET and watch().
        response.write('retry: 3000\nevent: changed\ndata: {}\n\n');
        return;
      }
      if (request.method === 'GET' && route.startsWith('/api/jobs/')) {
        const job = jobs.get(route.slice('/api/jobs/'.length));
        if (!job) throw new HttpError(404, 'Render job not found.');
        const { controller: _controller, ...value } = job;
        json(response, 200, value);
        return;
      }
      if (request.method === 'POST') {
        const controller = new AbortController();
        controllers.add(controller);
        const disconnect = () => {
          if (!response.writableEnded) controller.abort();
        };
        request.on('aborted', disconnect);
        response.on('close', disconnect);
        try {
          const value = await body(request);
          if (route.startsWith('/api/studio/')) {
            const name=route.slice('/api/studio/'.length) as ActionName;
            if(!Object.hasOwn(studioActions,name)) throw new HttpError(404,'Unknown studio operation.');
            const result=await runStudioAction(editing,name,value,controller.signal);
            const reviews=result.reviews?.map(({label,media})=>({label,from:media.from,to:media.to,frames:media.frames,
              image:media.image && registerMedia(media.image),audio:media.audio && registerMedia(media.audio),movie:media.movie && registerMedia(media.movie)}));
            json(response,200,{...result.data,reviews});
            return;
          }
          if (route === '/api/save') {
            const relative = stringField(value, 'file'),
              file = await project.cut(relative, true),
              source = stringField(value, 'source');
            let expected: DocumentVersion;
            if (value.revision !== undefined) expected = { revision: stringField(value, 'revision') };
            else if (value.mtime == null) expected = { create: true };
            else if (typeof value.mtime === 'number') expected = { mtime: value.mtime };
            else throw new HttpError(409, 'Read the current version before saving.');
            json(response, 200, await saveDocument(file, source, expected, controller.signal));
            return;
          }
          if (route === '/api/compile') {
            const { result } = await compileRequest(value, controller.signal);
            json(response, 200, result);
            return;
          }
          if (route === '/api/preview') {
            const { result, file } = await compileRequest(value, controller.signal);
            if (!result.timeline) {
              json(response, 422, {
                error: 'Fix CUT diagnostics before previewing.',
                diagnostics: result.diagnostics
              });
              return;
            }
            const timeline = result.timeline,
              position = value.position == null ? 0 : value.position;
            if (typeof position !== 'number' || !Number.isFinite(position) || position < 0)
              throw new HttpError(400, 'Preview position must be a nonnegative number of seconds.');
            const { from, to } = previewWindow(
              secondsToTicks(position),
              timeline.duration,
              timeline.fps,
              secondsToTicks(8)
            );
            const direct = !value.force ? findDirectPreview(timeline, { from, to }) : undefined;
            const preview =
              direct ||
              (await renderPreview(timeline, {
                cacheDir: await project.resolve('.cut-cache/previews', true),
                from,
                to,
                format: 'mp4',
                audioCodec: value.audioCodec === 'aac' ? 'aac' : 'mp3',
                signal: controller.signal
              }));
            json(response, 200, {
              src: registerMedia(preview.path),
              mimeType: mime[path.extname(preview.path).toLowerCase()] || 'video/mp4',
              from: ticksToSeconds(preview.from),
              to: ticksToSeconds(preview.to),
              sourceIn: preview.direct ? ticksToSeconds(preview.sourceIn || 0) : 0,
              direct: !!preview.direct,
              cached: preview.cached,
              hash: preview.hash
            });
            return;
          }
          if (route === '/api/render' || route === '/api/export') {
            const format = route === '/api/render' ? 'mp4' : value.format;
            if (!isExportFormat(format))
              throw new HttpError(400, 'Choose an MP4, Premiere project or XML export.');
            if (format !== 'mp4' && (value.from != null || value.to != null))
              throw new HttpError(400, 'Project export includes the complete timeline.');
            const { result, file } = await compileRequest(value, controller.signal);
            if (!result.timeline) {
              json(response, 422, {
                error: 'Fix CUT diagnostics before exporting.',
                diagnostics: result.diagnostics
              });
              return;
            }
            const outputRelative =
              value.output == null
                ? `output/${path.basename(file, path.extname(file))}.${format}`
                : stringField(value, 'output');
            if (path.extname(outputRelative).toLowerCase() !== '.' + format)
              throw new HttpError(400, `The output filename must end in .${format}.`);
            const output = await project.resolve(outputRelative, true),
              timeline = result.timeline;
            await assertSafeOutput(timeline, output);
            if (path.extname(output).toLowerCase() !== '.' + format)
              throw new HttpError(400, 'Choose an output with the correct file extension.');
            if (route === '/api/export' && value.overwrite !== true) {
              try {
                const existing = await stat(output);
                if (!existing.isFile()) throw new HttpError(400, 'Choose a file destination.');
                json(response, 200, { exists: true });
                return;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
            const from = value.from == null ? undefined : parseTime(stringField(value, 'from'), timeline.fps),
              to = value.to == null ? undefined : parseTime(stringField(value, 'to'), timeline.fps);
            const outputKey =
              process.platform === 'win32' || process.platform === 'darwin' ? output.toLowerCase() : output;
            if (activeOutputs.has(outputKey))
              throw new HttpError(
                409,
                'A render is already writing this output. Wait for it to finish, cancel it, or choose another output file.'
              );
            const job: Job = {
              id: randomUUID(),
              state: 'rendering',
              fraction: 0,
              controller: new AbortController()
            };
            jobs.set(job.id, job);
            activeOutputs.set(outputKey, job.id);
            // Render jobs deliberately survive their initiating HTTP response; the Cancel action owns cancellation.
            const task = writeExport(format, timeline, output, job, from, to).then(
              () => {
                job.state = 'complete';
                job.fraction = 1;
                job.output = path.relative(root, output).split(path.sep).join('/');
                job.src = registerMedia(output);
              },
              (error) => {
                job.state = job.controller.signal.aborted ? 'cancelled' : 'error';
                job.error = error instanceof Error ? error.message : String(error);
              }
            );
            jobTasks.add(task);
            void task.finally(() => {
              jobTasks.delete(task);
              if (activeOutputs.get(outputKey) === job.id) activeOutputs.delete(outputKey);
            });
            if (jobs.size > 100) {
              const old = [...jobs.values()].find((item) => item.state !== 'rendering');
              if (old) jobs.delete(old.id);
            }
            json(response, 202, { id: job.id });
            return;
          }
          const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(route);
          if (cancel) {
            const job = jobs.get(cancel[1]);
            if (!job) throw new HttpError(404, 'Render job not found.');
            if (job.state === 'rendering') job.controller.abort();
            json(response, 200, { id: job.id, state: job.state });
            return;
          }
        } finally {
          controllers.delete(controller);
          request.off('aborted', disconnect);
          response.off('close', disconnect);
        }
      }
      if (route.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new HttpError(405, 'Method not allowed.');
      const staticName = route === '/' ? 'index.html' : route.slice(1);
      if (
        !['index.html', 'app.js', 'app.css', 'studio.js', 'studio.css', 'panel-bridge.js'].includes(
          staticName
        )
      )
        throw new HttpError(404, 'Page not found.');
      let content: Buffer | string = await readFile(path.join(assets, staticName));
      if (staticName === 'index.html') {
        const bootstrap = JSON.stringify({ token, root })
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026');
        content = content.toString('utf8').replace('__CUT_BOOTSTRAP__', bootstrap);
      }
      response.writeHead(200, {
        'Content-Type': mime[path.extname(staticName)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(content)
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    })().catch((error) => {
      if (response.writableEnded || response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        error instanceof DocumentConflictError ? 409 : error instanceof HttpError || error instanceof ProjectAccessError
          ? error.status
          : (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 404
            : error instanceof Error && error.name === 'AbortError'
              ? 499
              : 400;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.requestTimeout = 30_000;
  return {
    server,
    token,
    root,
    close: async () => {
      for (const controller of controllers) controller.abort();
      for (const job of jobs.values()) job.controller.abort();
      server.closeAllConnections();
      await Promise.allSettled(jobTasks);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export async function startStudio(
  projectRoot?: string,
  port = 0,
  open = true
): Promise<Session & { url: string }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('--port must be an integer from 0 to 65535.');
  let root = projectRoot;
  if (!root) {
    const sample = path.resolve(process.cwd(), 'examples');
    try {
      await access(sample);
      root = sample;
    } catch {
      root = process.cwd();
    }
  }
  const session = await createStudioServer(root);
  await new Promise<void>((resolve, reject) => {
    session.server.once('error', reject);
    session.server.listen(port, '127.0.0.1', () => {
      session.server.off('error', reject);
      resolve();
    });
  });
  const address = session.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start local server.');
  const url = `http://127.0.0.1:${address.port}`;
  process.stdout.write(
    `\nCUT Studio · the code is the movie\n${url}\nProject: ${session.root}\nPress Ctrl+C to close the local studio.\n\n`
  );
  if (open) {
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const browser = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    browser.on('error', () => process.stderr.write(`Open ${url} in your browser.\n`));
    browser.unref();
  }
  return { ...session, url };
}
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const args = process.argv.slice(2);
  let root: string | undefined,
    port = 0,
    open = true;
  try {
    while (args.length) {
      const arg = args.shift()!;
      if (arg === '--no-open') open = false;
      else if (arg === '--port') port = Number(args.shift());
      else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
      else if (root) throw new Error('Choose one project folder.');
      else root = arg;
    }
    void startStudio(root, port, open)
      .then((session) => {
        const stop = () => {
          void session.close().finally(() => {
            process.exitCode = 0;
          });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 1;
      });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
