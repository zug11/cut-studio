import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runTool } from '../engine/process';
import { probeMedia } from '../engine/probe';
import { resourceFile } from '../engine/graphics';
import { mediaFile } from './review';
import { CONFINED_MEDIA_FORMATS, ProjectPaths } from './paths';

const modelHash =
  'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21';
const modelSize = 77691713;
const modelURL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';
type Cue = { from: number; to: number; text: string };
export function readSubtitles(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split(/\n[ \t]*\n/)) {
    const lines = block.split('\n'),
      i = lines.findIndex((s) => s.includes('-->'));
    if (i < 0 || !lines[i + 1]) continue;
    const stamp = (s: string) => {
      if (!/^(?:\d+:)?\d{2}:\d{2}[,.]\d{1,3}$/.test(s)) return NaN;
      return s
        .replace(',', '.')
        .split(':')
        .reduce((v, x) => v * 60 + Number(x), 0);
    };
    const [fromText, toText] = lines[i].trim().split(/\s+-->\s+/);
    const from = stamp(fromText),
      to = stamp((toText || '').split(/\s/)[0]);
    const text = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .trim();
    if (Number.isFinite(from) && Number.isFinite(to) && to > from && text)
      cues.push({ from, to, text });
  }
  return cues;
}
async function exists(file: string) {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function speechModel(signal?: AbortSignal) {
  if (process.env.CUT_WHISPER_MODEL) return process.env.CUT_WHISPER_MODEL;
  const dir =
    process.platform === 'darwin'
      ? path.join(homedir(), 'Library/Application Support/CUT Studio/Speech')
      : path.join(homedir(), '.cache/cut-studio/speech');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'ggml-tiny.bin');
  if ((await exists(target)) && (await stat(target)).size === modelSize)
    return target;
  const temporary = path.join(dir, randomUUID() + '.part');
  try {
    const response = await fetch(modelURL, { signal });
    if (!response.ok || !response.body)
      throw new Error(
        'Could not download the speech model. Check the connection and retry Index dialogue.'
      );
    const hash = createHash('sha256');
    let count = 0;
    const verify = new Transform({
      transform(chunk, _, cb) {
        hash.update(chunk);
        count += chunk.length;
        cb(
          count > modelSize ? new Error('Unexpected model size.') : null,
          chunk
        );
      }
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      verify,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal }
    );
    if (count !== modelSize || hash.digest('hex') !== modelHash)
      throw new Error(
        'The speech model did not pass its download integrity check.'
      );
    const { rename } = await import('node:fs/promises');
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
async function transcribe(asset: string, signal?: AbortSignal) {
  const engine =
    process.env.CUT_WHISPER_CLI ||
    (process.platform === 'darwin' && process.arch === 'arm64'
      ? await resourceFile('speech/whisper-cli-mac-arm64')
      : 'whisper-cli');
  const model = await speechModel(signal);
  const temp = await mkdtemp(path.join(tmpdir(), 'cut-dialogue-'));
  const wav = path.join(temp, 'audio.wav'),
    prefix = path.join(temp, 'speech');
  try {
    await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        CONFINED_MEDIA_FORMATS,
        '-i',
        asset,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        wav
      ],
      { signal }
    );
    await new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(
        engine,
        [
          '-m',
          model,
          '-f',
          wav,
          '-l',
          'auto',
          '-osrt',
          '-of',
          prefix,
          '-t',
          '4',
          '-ng'
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], shell: false, signal }
      );
      let errors = '';
      child.stderr.on(
        'data',
        (chunk) => (errors = (errors + chunk).slice(-1200))
      );
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Local transcription failed. ' + errors))
      );
    });
    return readSubtitles(await readFile(prefix + '.srt', 'utf8'));
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}
async function indexed(
  project: ProjectPaths,
  file: string,
  generate: boolean,
  signal?: AbortSignal
) {
  const asset = await mediaFile(project, file);
  const stem = asset.slice(0, -path.extname(asset).length);
  for (const sidecar of [
    asset + '.srt',
    asset + '.vtt',
    stem + '.srt',
    stem + '.vtt'
  ]) {
    if (!(await exists(sidecar))) continue;
    const actual = await project.resolve(project.relative(sidecar));
    if (
      !/\.(srt|vtt)$/i.test(actual) ||
      (await stat(actual)).size > 10 * 1024 * 1024
    )
      throw new Error('Choose a regular subtitle file under 10 MB.');
    return {
      cues: readSubtitles(await readFile(actual, 'utf8')),
      kind: 'subtitles'
    };
  }
  const info = await probeMedia(asset, signal, {
    formatWhitelist: CONFINED_MEDIA_FORMATS
  });
  if (!info.hasAudio) return { cues: [], kind: 'silent' };
  let identity = modelHash;
  if (process.env.CUT_WHISPER_MODEL) {
    const model = await stat(process.env.CUT_WHISPER_MODEL);
    identity =
      process.env.CUT_WHISPER_MODEL + '-' + model.size + '-' + model.mtimeMs;
  }
  const key = createHash('sha256')
    .update(info.fingerprint + '-' + identity + '-1')
    .digest('hex');
  const fileName = '.cut-cache/dialogue/' + key + '.json';
  const target = await project.resolve(fileName, true);
  if (await exists(target))
    return {
      cues: JSON.parse(await readFile(target, 'utf8')) as Cue[],
      kind: 'indexed'
    };
  if (!generate) return { cues: [], kind: 'unindexed' };
  const cues = await transcribe(asset, signal);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), randomUUID() + '.part');
  try {
    await writeFile(temporary, JSON.stringify(cues), { flag: 'wx' });
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { cues, kind: 'indexed' };
}

export async function searchDialogue(
  project: ProjectPaths,
  query: string,
  file?: string,
  generate = false,
  signal?: AbortSignal
) {
  const files = file
    ? [file]
    : (await project.listFiles({ signal })).files
        .filter(
          (f) =>
            (f.kind === 'audio' || f.kind === 'video') &&
            !f.path.startsWith('output/')
        )
        .map((f) => f.path);
  const matches: { file: string; from: number; to: number; text: string }[] =
    [];
  const unindexed: string[] = [],
    errors: { file: string; message: string }[] = [];
  let searched = 0,
    total = 0;
  for (const media of files) {
    signal?.throwIfAborted();
    try {
      const result = await indexed(project, media, generate, signal);
      if (result.kind === 'unindexed') {
        unindexed.push(media);
        continue;
      }
      if (result.kind === 'silent') continue;
      searched++;
      for (const cue of result.cues)
        if (
          cue.text
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        ) {
          if (matches.length < 250) matches.push({ ...cue, file: media });
          total++;
        }
    } catch (error) {
      if (signal?.aborted || file) throw error;
      errors.push({
        file: media,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { matches, total, searched, unindexed, errors };
}
