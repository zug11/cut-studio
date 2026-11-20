import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compile } from '../core/compiler';
import { formatTime, parseTime, ticksToSeconds } from '../core/time';
import type { Diagnostic, Timeline } from '../core/types';
import { arrangeLayers } from '../core/layers';
import {
  render,
  renderPreview,
  configureTools,
  checkTools,
  assertSafeOutput,
  atomicWriteOutput,
  atomicCopyOutput
} from '../engine/index';
import { exportFcp7 } from '../exporters/fcp7';
import { exportResolve } from '../exporters/resolve';
import { exportPremiere } from '../exporters/premiere';

const HELP = `CUT Studio 0.1.0 — the code is the movie.

Usage:
  cut check film.cut                         Validate syntax, timing and local media
  cut timeline film.cut [--json]              Inspect tracks and resolved source trims
  cut preview film.cut [--from 0s --to 8s]     Render a cached 960×540 playback MP4
  cut render film.cut --output movie.mp4      Render H.264 / AAC locally
  cut render film.cut --from 10s --to 25s     Render a timeline range (out exclusive)
  cut export film.cut --output sequence.xml  Export editable FCP 7 XML
  cut export film.cut --output movie.drp     Export a native Resolve 21 project
  cut export film.cut --output movie.prproj  Export a native Premiere project

Options:
  --ffmpeg <path>     FFmpeg executable (or CUT_FFMPEG environment variable)
  --ffprobe <path>    FFprobe executable (or CUT_FFPROBE environment variable)
  --output, -o       Output path, relative to the current directory
  --from / --to      Film timeline boundaries, using CUT timestamps
  --json             Machine-readable check / timeline results
  --help, -h         This help

All media stays on this computer. Relative assets resolve beside the .cut file.
Video tracks are silent; add an audio clip explicitly to use source sound.
`;

interface Args {
  command: string;
  input: string;
  values: Record<string, string>;
  json: boolean;
}
function parseArgs(argv: string[]): Args {
  const command = argv.shift() || '';
  if (!['check', 'timeline', 'preview', 'render', 'export'].includes(command))
    throw new Error(`Unknown command “${command}”. Use cut --help.`);
  const input = argv.shift();
  if (!input || input.startsWith('-'))
    throw new Error(`cut ${command} requires a .cut file. Use cut --help.`);
  const values: Record<string, string> = {};
  let json = false;
  while (argv.length) {
    const option = argv.shift()!;
    if (option === '--json') {
      json = true;
      continue;
    }
    const key = option === '-o' ? 'output' : option.replace(/^--/, '');
    if (!['output', 'from', 'to', 'ffmpeg', 'ffprobe'].includes(key) || !option.startsWith('-'))
      throw new Error(`Unknown option “${option}”.`);
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    if (key in values) throw new Error(`${option} was specified more than once.`);
    values[key] = value;
  }
  if (json && !['check', 'timeline'].includes(command))
    throw new Error('--json is available for check and timeline.');
  return { command, input: path.resolve(input), values, json };
}

function printDiagnostics(file: string, diagnostics: Diagnostic[]) {
  for (const d of diagnostics) {
    const { line, column } = d.range.start;
    process.stderr.write(`${file}:${line + 1}:${column + 1}: ${d.severity} [${d.code}] ${d.message}\n`);
  }
}

export function timelineSummary(timeline: Timeline): string {
  const { width, height } = timeline.resolution;
  const fps = timeline.fps.den === 1 ? `${timeline.fps.num}` : `${timeline.fps.num}/${timeline.fps.den}`;
  const lines = [
    `${timeline.name}  ·  ${width}×${height}  ·  ${fps} fps  ·  ${formatTime(timeline.duration)}`
  ];
  for (const track of arrangeLayers(timeline.tracks)) {
    lines.push(
      `\n${track.kind === 'video' ? 'V' : 'A'}${track.layer}  ${track.name}${track.kind === 'video' ? ' (higher layer numbers appear above lower layers)' : ''}${track.clips.length ? '' : ' · empty'}`
    );
    for (const clip of track.clips) {
      lines.push(`  ${formatTime(clip.at)} → ${formatTime(clip.end)}  ${clip.path}  [${track.kind === 'video' ? 'V' : 'A'}${clip.layer ?? track.layer}]`);
      lines.push(
        `    source [${formatTime(clip.in)}, ${formatTime(clip.out)})  duration ${formatTime(clip.duration)}${track.kind === 'audio' ? `  gain ${clip.gain}dB  fades ${formatTime(clip.fadeIn)} / ${formatTime(clip.fadeOut)}` : `  opacity ${clip.opacity}`}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === '--version') {
    process.stdout.write('0.1.0\n');
    return;
  }
  const args = parseArgs(argv);
  configureTools({
    ffmpegPath: args.values.ffmpeg || process.env.CUT_FFMPEG || 'ffmpeg',
    ffprobePath: args.values.ffprobe || process.env.CUT_FFPROBE || 'ffprobe'
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const source = await readFile(args.input, 'utf8');
  const result = await compile(source, args.input, { signal: controller.signal });
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(args.command === 'check' ? { valid: !!result.timeline, diagnostics: result.diagnostics } : result, null, 2)}\n`
    );
  } else printDiagnostics(args.input, result.diagnostics);
  if (!result.timeline || result.diagnostics.some((d) => d.severity === 'error')) {
    process.exitCode = 1;
    return;
  }
  const timeline = result.timeline;
  if (args.command === 'check') {
    if (!args.json)
      process.stdout.write(
        `✓ ${timeline.name}: ${timeline.tracks.length} tracks, ${timeline.tracks.reduce((n, t) => n + t.clips.length, 0)} clips, ${formatTime(timeline.duration)}. Media and timing are valid.\n`
      );
    return;
  }
  if (args.command === 'timeline') {
    if (!args.json) process.stdout.write(timelineSummary(timeline));
    return;
  }
  const from = args.values.from === undefined ? undefined : parseTime(args.values.from, timeline.fps);
  const to = args.values.to === undefined ? undefined : parseTime(args.values.to, timeline.fps);
  if (args.command === 'export') {
    const output = path.resolve(args.values.output || args.input.replace(/\.cut$/i, '') + '.xml');
    if (path.extname(output).toLowerCase() === '.drp') {
      const result = await exportResolve(timeline, { output, signal: controller.signal });
      for (const warning of result.warnings) process.stderr.write(warning + '\n');
      process.stdout.write('Exported Resolve project: ' + output + '\n');
      return;
    }
    if (/\.prproj$/i.test(output)) {
      const result = await exportPremiere(timeline, { output, signal: controller.signal, onProgress: progress => process.stderr.write(`${Math.round(progress.fraction * 100)}% ${progress.message}\n`) });
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
      process.stdout.write(`Exported native Premiere project: ${result.path}\n`);
      return;
    }
    const exported = exportFcp7(timeline);
    await atomicWriteOutput(timeline, output, exported.xml);
    for (const warning of exported.warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stdout.write(`Exported editable sequence: ${output}\n`);
    return;
  }
  await checkTools();
  let lastProgress = -1;
  const onProgress = ({ fraction }: { fraction: number }) => {
    const percent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
    if (percent >= lastProgress + 10 || (percent === 100 && lastProgress !== 100)) {
      process.stderr.write(`Rendering ${percent}%\n`);
      lastProgress = percent;
    }
  };
  if (args.command === 'preview') {
    if (args.values.output) await assertSafeOutput(timeline, path.resolve(args.values.output));
    const preview = await renderPreview(timeline, {
      cacheDir: path.join(path.dirname(args.input), '.cut-cache'),
      from,
      to,
      format: 'mp4',
      signal: controller.signal,
      onProgress
    });
    let output = preview.path;
    if (args.values.output) {
      output = path.resolve(args.values.output);
      await atomicCopyOutput(timeline, preview.path, output);
    }
    process.stdout.write(
      `${preview.cached ? 'Cached' : 'Rendered'} preview [${ticksToSeconds(preview.from)}s, ${ticksToSeconds(preview.to)}s): ${output}\n`
    );
  } else {
    const output = path.resolve(args.values.output || args.input.replace(/\.cut$/i, '') + '.mp4');
    if (output === args.input) throw new Error('The render output must differ from the CUT document.');
    await render(timeline, { output, from, to, onProgress, signal: controller.signal });
    process.stdout.write(`Rendered: ${output}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`CUT: ${message}\n`);
  process.exitCode = /abort|cancel/i.test(message) ? 130 : 1;
});
