import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const snippets: Record<string, [string, string]> = {
  film: [
    'film "${1:Untitled film}" {\n  resolution ${2:1920}x${3:1080}\n  fps ${4:24}\n\n  track video "${5:Main}" {\n    $0\n  }\n}',
    'A film is the complete timeline. Higher video tracks appear on top.'
  ],
  track: [
    'track ${1|video,audio|} "${2:Main}" {\n  $0\n}',
    'A named video layer or independent audio track.'
  ],
  'track layer': [
    'track ${1|video,audio|} "${2:Main}" layer ${3:1} {\n  $0\n}',
    'Assign this track to a numbered layer. Higher video numbers appear above lower numbers.'
  ],
  clip: [
    'clip "${1:media/clip.mp4}" {\n  in ${2:0s}\n  out ${3:5s}\n  at ${4:0s}\n  $0\n}',
    'Trim source in/out (out exclusive), place it at an absolute timeline time.'
  ],
  'clip concise': [
    'clip "${1:media/clip.mp4}" from ${2:0s} to ${3:5s} at ${4:0s}',
    'A concise clip with the same timing semantics as a block.'
  ],
  resolution: ['resolution ${1:1920}x${2:1080}', 'Output dimensions, in pixels.'],
  fps: ['fps ${1:24}', 'Output frame rate. Rational rates such as 24000/1001 are supported.'],
  in: ['in ${1:0s}', 'Inclusive start boundary in the source media.'],
  out: ['out ${1:5s}', 'Exclusive end boundary in the source media. Omit to use remaining media.'],
  at: ['at ${1:0s}', 'Absolute position on the film timeline.'],
  layer: ['layer ${1:1}', 'Place media on an explicit layer (1–256). A clip layer overrides its track layer; video and audio use separate numbers.'],
  opacity: ['opacity ${1:0.5}', 'Video opacity: 0 is transparent, 1 is opaque.'],
  gain: ['gain ${1:-6}dB', 'Audio gain in decibels. Tracks mix independently.'],
  fade_in: ['fade_in ${1:1s}', 'Fade audio in from the beginning of this trimmed clip.'],
  fade_out: ['fade_out ${1:1s}', 'Fade audio out at the end of this trimmed clip.']
};

export class CutCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[]> {
    const before = document.lineAt(position.line).text.slice(0, position.character);
    const quoted = /clip\s+"([^"\n]*)$/.exec(before);
    if (quoted) {
      const typed = quoted[1];
      const folder = typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/') + 1) : '';
      try {
        const entries = await fs.readdir(path.resolve(path.dirname(document.uri.fsPath), folder), {
          withFileTypes: true
        });
        return entries
          .filter(
            (entry) =>
              entry.isDirectory() || /\.(mp4|mov|mkv|webm|wav|mp3|flac|ogg|m4a|aiff?)$/i.test(entry.name)
          )
          .map((entry) => {
            const item = new vscode.CompletionItem(
              entry.name + (entry.isDirectory() ? '/' : ''),
              entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );
            item.insertText = entry.name + (entry.isDirectory() ? '/' : '');
            const tail = typed.slice(folder.length);
            item.range = new vscode.Range(position.translate(0, -tail.length), position);
            return item;
          });
      } catch {
        return [];
      }
    }
    if (/\b(?:in|out|at|from|to|fade_in|fade_out)\s+[^\s]*$/.test(before)) {
      return [
        ['0s', 'Seconds'],
        ['1m00.052s', 'Minutes and decimal seconds'],
        ['00:01:00.052', 'Clock time'],
        ['00:00:01:00', 'Non-drop frame timecode at the film frame rate'],
        ['24f', 'Frame count at the film frame rate']
      ].map(([label, detail]) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
        item.detail = detail;
        return item;
      });
    }
    if (/\btrack\s+(?:video|audio)\s+"[^"\n]*"\s+\w*$/.test(before) || /\bclip\s+"[^"\n]*"\s+from\s+\S+\s+to\s+\S+\s+at\s+\S+\s+\w*$/.test(before)) {
      const item = new vscode.CompletionItem('layer', vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(snippets.layer[0]);
      item.detail = snippets.layer[1];
      return [item];
    }
    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const opened = [...prefix.matchAll(/\b(film|track\s+(?:video|audio)|clip)\b[^{}]*\{|[{}]/g)];
    const stack: string[] = [];
    for (const match of opened) {
      if (match[0] === '}') stack.pop();
      else if (match[0] !== '{') stack.push(match[1] || '');
    }
    const scope = stack.at(-1) || '';
    const allowed =
      scope === 'clip'
        ? ['in', 'out', 'at', 'layer', 'opacity', 'gain', 'fade_in', 'fade_out']
        : scope.startsWith('track')
          ? ['clip', 'clip concise']
          : scope === 'film'
            ? ['resolution', 'fps', 'track', 'track layer']
            : ['film'];
    return allowed.map((label) => {
      const [insert, detail] = snippets[label];
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(insert);
      item.documentation = new vscode.MarkdownString(detail);
      return item;
    });
  }
}
