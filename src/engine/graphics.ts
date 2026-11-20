import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { ResolvedClip } from '../core/types';

export async function resourceFile(relative: string) {
  const runtime = typeof __dirname === 'string' ? __dirname : process.cwd();
  for (const candidate of [
    path.join(runtime, relative),
    path.join(process.cwd(), 'resources', relative),
    path.join(process.cwd(), 'dist', relative),
    ...(relative === 'graphics/resvg.wasm' ? [path.join(process.cwd(),'node_modules/@resvg/resvg-wasm/index_bg.wasm')] : [])
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* source or packaged execution */
    }
  }
  throw new Error('Missing CUT Studio resource: ' + relative);
}

let graphics: Promise<{ family: string; fonts: Uint8Array[] }> | undefined;
async function initialize() {
  await initWasm(await readFile(await resourceFile('graphics/resvg.wasm')));
  const candidates = [
    ['/System/Library/Fonts/Supplemental/Arial.ttf', 'Arial'],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'DejaVu Sans'],
    [
      path.join(process.env.SystemRoot || 'C:/Windows', 'Fonts/arial.ttf'),
      'Arial'
    ]
  ];
  for (const [file, family] of candidates) {
    try {
      return { family, fonts: [await readFile(file)] };
    } catch {
      /* try next installed font */
    }
  }
  throw new Error('Install Arial or DejaVu Sans to draw titles and timecodes.');
}
export function xmlText(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export async function drawSVG(
  width: number,
  height: number,
  content: string,
  output: string
) {
  const { family, fonts } = await (graphics ??= initialize());
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
    width +
    '" height="' +
    height +
    '"><g font-family="' +
    family +
    '">' +
    content +
    '</g></svg>';
  const image = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: family }
  });
  try {
    const rendered = image.render();
    try {
      await writeFile(output, rendered.asPng());
    } finally {
      rendered.free();
    }
  } finally {
    image.free();
  }
}

/** Render text as transparent artwork, retaining the original text in the CUT document. */
export async function drawTitle(
  clip: ResolvedClip,
  width: number,
  height: number,
  output: string
) {
  const caption = clip.element === 'caption';
  const size = Math.max(
    10,
    Math.min(height * (caption ? 0.055 : 0.095), width * 0.08)
  );
  const max = Math.max(8, Math.floor((width * 0.86) / (size * 0.6)));
  const lines: string[] = [];
  for (const paragraph of clip.path.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && (line + ' ' + word).length > max) {
        lines.push(line);
        line = '';
      }
      line += (line ? ' ' : '') + word;
    }
    lines.push(line);
  }
  const step = size * 1.24;
  const y = caption
    ? height * 0.9 - (lines.length - 1) * step
    : height / 2 - ((lines.length - 1) * step) / 2 + size * 0.32;
  const box = caption
    ? '<rect x="4%" width="92%" y="' +
      (y - size) +
      '" height="' +
      (lines.length * step + size * 0.16) +
      '" rx="' +
      size * 0.15 +
      '" fill="#101418" fill-opacity=".82"/>'
    : '';
  const text = lines
    .map(
      (line, i) =>
        '<text x="50%" y="' +
        (y + i * step) +
        '" text-anchor="middle" fill="white" stroke="#15171b" stroke-width="' +
        Math.max(1, size * 0.035) +
        '" paint-order="stroke" font-size="' +
        size +
        '">' +
        xmlText(line) +
        '</text>'
    )
    .join('');
  await drawSVG(width, height, box + text, output);
}
