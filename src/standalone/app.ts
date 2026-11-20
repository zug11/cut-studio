import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  rectangularSelection,
  highlightSpecialChars
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  snippetCompletion,
  type CompletionContext
} from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter, type Diagnostic as EditorDiagnostic } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { parseCut } from '../core/parser';
import { ticksToSeconds, secondsToTicks, playablePosition } from '../core/time';
import type { CompileResult, Diagnostic, Film, Timeline } from '../core/types';

import { premierePlan } from '../core/premiere-plan';
import { openEditing } from './editing-panel';
import { chooseExport, showExported, type ExportedFile } from './export-dialog';

type DesktopMessage =
  | { action: 'reveal'; path: string }
  | { action: 'importMedia' }
  | { action: 'documentState'; dirty: boolean; file: string };

declare global {
  interface Window {
    __CUT_NATIVE__?: { version: number };
    webkit?: { messageHandlers?: { cutStudio?: { postMessage(message: DesktopMessage): void } } };
    cutNative?: {
      canClose(): Promise<boolean>;
      save(): Promise<boolean>;
      newFilm(): Promise<void>;
      openFile(path: string): Promise<void>;
      refreshFiles(): Promise<void>;
      exportFilm(): Promise<void>;
      undo(): boolean;
      redo(): boolean;
    };
  }
}
const desktop = window.__CUT_NATIVE__?.version === 1 ? window.webkit?.messageHandlers?.cutStudio : undefined;
let lastDocumentState = '';

interface FileEntry {
  path: string;
  name: string;
  kind: 'cut' | 'video' | 'audio' | 'other';
}
interface Preview {
  src: string;
  from: number;
  to: number;
  sourceIn?: number;
  direct?: boolean;
  cached?: boolean;
  hash: string;
}
interface State {
  kind: 'empty' | 'stale' | 'checking' | 'rendering' | 'ready' | 'error';
  message: string;
  progress?: number;
}
const bootstrap = JSON.parse(document.getElementById('cut-bootstrap')!.textContent || '{}') as {
  token: string;
  root: string;
};
const app = document.getElementById('app')!;
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
let files: FileEntry[] = [];
let currentFile = '';
let savedSource = '';
let diskRevision = '';
let projectEvents: EventSource | undefined;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
let syncSequence = 0;
interface DiskFilm { source: string; revision: string }
let view: EditorView;
let revision = 0;
let film: Film | undefined;
let timeline: Timeline | undefined;
let diagnostics: Diagnostic[] = [];
let position = 0;
let state: State = { kind: 'empty', message: 'Choose a .cut film in the project explorer.' };
let compileController: AbortController | undefined;
let previewController: AbortController | undefined;
let compileTimer: ReturnType<typeof setTimeout> | undefined;
let preview: Preview | undefined;
let previewId = 0;
let activePreviewId = 0;
let monitorReady = false,
  timelineReady = false;
let replacingDocument = false;
let saving = false;
let openSequence = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let exportJob: string | undefined;
let exportPending = false;
const collapsed = new Set<string>();

const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string
): HTMLElementTagNameMap[K] => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const button = (label: string, className: string, action: () => unknown, title?: string) => {
  const item = node('button', className, label);
  item.type = 'button';
  item.title = title || label;
  item.addEventListener('click', () => {
    void action();
  });
  return item;
};
async function api<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Cut-Token': bootstrap.token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `The local project returned HTTP ${response.status}.`);
  return result as T;
}
function toast(message: string, error = false) {
  document.querySelector('.toast')?.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const item = node('div', `toast${error ? ' error' : ''}`, message);
  item.setAttribute('role', error ? 'alert' : 'status');
  document.body.append(item);
  toastTimer = setTimeout(() => item.remove(), error ? 10000 : 6000);
}

const shell = node('div', 'app');
const header = node('header', 'app-header');
const brand = node('div', 'brand');
brand.append(
  node('span', 'brand-mark', '/'),
  node('span', '', 'CUT'),
  node('span', 'brand-studio', 'STUDIO')
);
const projectTitle = node('div', 'project-title', basename(bootstrap.root));
projectTitle.title = bootstrap.root;
const headerTools = node('div', 'header-tools');
const saveButton = button('Save', 'tool-button', save, 'Save source (⌘S / Ctrl+S)');
const checkButton = button(
  'Check',
  'tool-button optional-tool',
  () => compileDocument(true),
  'Validate source and local media'
);
const previewButton = button(
  'Preview',
  'tool-button optional-tool',
  () => requestPreview(position, false, true),
  'Refresh the current composition'
);
const exportButton = button(
  'Export…',
  'tool-button export-main',
  exportMovie,
  'Export a Resolve or Premiere project, MP4 movie or interchange sequence'
);
const editingButton=button('Edit & review…','tool-button',()=>editingTools(currentFile?'Clip':'Footage'),'Edit clips, browse footage, reuse scenes and review a cut');
headerTools.append(saveButton, checkButton, previewButton, editingButton, exportButton);
header.append(
  brand,
  node('span', 'header-divider'),
  projectTitle,
  node('span', 'local-tag', 'On this computer'),
  headerTools
);

const body = node('div', 'app-body');
const explorer = node('aside', 'explorer');
explorer.setAttribute('aria-label', 'Project explorer');
const explorerLabel = node('div', 'panel-label', 'EXPLORER');
const explorerTools = node('span');
const newFilmButton = button('+', 'icon-button', newFilm, 'New film');
newFilmButton.setAttribute('aria-label', 'New film');
explorerTools.append(newFilmButton, button('↻', 'icon-button', refreshFiles, 'Refresh local project files'));
explorerLabel.append(explorerTools);
const rootLabel = node('div', 'project-root');
rootLabel.append(node('span', 'chevron', '⌄'), node('span', '', basename(bootstrap.root)));
const filter = node('input', 'file-filter');
filter.placeholder = 'Find a file…';
filter.setAttribute('aria-label', 'Filter project files');
filter.addEventListener('input', drawTree);
const fileTree = node('nav', 'file-tree');
fileTree.setAttribute('aria-label', 'Local project files');
explorer.append(explorerLabel, rootLabel);
if (desktop) {
  explorer.append(
    button('Import media…', 'tree-row import-media', () => desktop.postMessage({ action: 'importMedia' }))
  );
}
explorer.append(filter, fileTree);

const workspace = node('main', 'workspace');
const upper = node('div', 'upper-workspace');
const editorPanel = node('section', 'editor-panel');
editorPanel.setAttribute('aria-label', 'CUT source editor');
const tabs = node('div', 'editor-tabs');
const tab = node('div', 'editor-tab');
const fileName = node('span', 'filename', 'No film selected');
const dirtyDot = node('span', 'dirty-dot');
dirtyDot.hidden = true;
tab.append(node('span', 'file-icon cut', '/'), fileName, dirtyDot);
tabs.append(tab);
const editorToolbar = node('div', 'editor-toolbar');
const breadcrumb = node('span', 'breadcrumb', 'Select a film.cut file');
editorToolbar.append(breadcrumb);
const editHere=button('Clip tools…','clip-tools',()=>editingTools('Clip'),'Edit the clip at the cursor');
editorToolbar.append(editHere);
const editorHost = node('div', 'editor-host');
const conflict = node('div', 'disk-conflict');
conflict.hidden = true;
conflict.setAttribute('role', 'status');
conflict.append(node('span', '', 'This film changed on disk. Your edits are still here.'),
  button('Save a copy…', '', saveDraftCopy), button('Reload', '', () => {
    if (window.confirm('Replace the edits in this window with the latest saved film?')) void syncOpenFilm(true);
  }));
editorPanel.append(tabs, editorToolbar, conflict, editorHost);
const verticalSplitter = node('div', 'vertical-splitter');
verticalSplitter.tabIndex = 0;
verticalSplitter.setAttribute('role', 'separator');
verticalSplitter.setAttribute('aria-label', 'Resize source editor and monitor');
verticalSplitter.setAttribute('aria-orientation', 'vertical');
const monitorPanel = node('section', 'monitor-panel');
const monitorFrame = node('iframe');
monitorFrame.title = 'CUT Studio video monitor';
monitorFrame.allow = 'autoplay';
monitorPanel.append(monitorFrame);
upper.append(editorPanel, verticalSplitter, monitorPanel);
const horizontalSplitter = node('div', 'horizontal-splitter');
horizontalSplitter.tabIndex = 0;
horizontalSplitter.setAttribute('role', 'separator');
horizontalSplitter.setAttribute('aria-label', 'Resize timeline');
horizontalSplitter.setAttribute('aria-orientation', 'horizontal');
const timelinePanel = node('section', 'timeline-panel');
const timelineFrame = node('iframe');
timelineFrame.title = 'CUT Studio visual timeline';
timelinePanel.append(timelineFrame);
workspace.append(upper, horizontalSplitter, timelinePanel);
body.append(explorer, workspace);

const status = node('footer', 'app-status');
const stateIndicator = node('span', 'status-indicator', 'No film');
const statusMessage = node('span', 'status-message', state.message);
const statusRight = node('div', 'status-right');
const problemButton = button(
  '0 errors · 0 warnings',
  'status-button',
  toggleProblems,
  'Show source and media diagnostics'
);
const cursorStatus = node('span', '', 'Ln 1, Col 1');
const timelineButton = button('Timeline ↓', 'status-button', toggleTimeline, 'Show / hide timeline');
const helpButton = button('CUT guide ?', 'status-button', showHelp, 'Language guide and keyboard shortcuts');
statusRight.append(problemButton, cursorStatus, node('span', '', 'CUT'), timelineButton, helpButton);
status.append(stateIndicator, statusMessage, statusRight);
shell.append(header, body, status);
app.append(shell);

const problems = node('section', 'problems');
problems.hidden = true;
problems.setAttribute('aria-label', 'Problems');
const problemsHeader = node('div', 'problems-header', 'PROBLEMS');
problemsHeader.append(
  button(
    '×',
    '',
    () => {
      problems.hidden = true;
    },
    'Close problems'
  )
);
const problemList = node('div', 'problem-list');
problems.append(problemsHeader, problemList);
shell.append(problems);

const cutLanguage = StreamLanguage.define({
  startState: () => ({ blockComment: false }),
  token(stream, current) {
    if (current.blockComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        current.blockComment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//') || stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      current.blockComment = true;
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/\b(?:film|track|clip|title|caption|scene|as|after|from|to)\b/)) return 'keyword';
    if (stream.match(/\b(?:video|audio)\b/)) return 'typeName';
    if (stream.match(/\b(?:resolution|fps|in|out|at|layer|gain|opacity|fade_in|fade_out|scale|crop|duck|x|y)\b/))
      return 'propertyName';
    if (stream.match(/[+-]?(?:\d+(?:\.\d+)?(?:h|m|s|f|dB)?)+(?:[:/x]\d+(?:\.\d+)?)*?/)) return 'number';
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['{', '"'] }
  }
});
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#c6a9d8' },
  { tag: tags.typeName, color: '#a8bce0' },
  { tag: tags.propertyName, color: '#8cbdc6' },
  { tag: tags.string, color: '#b1cba3' },
  { tag: tags.number, color: '#d6bd8e' },
  { tag: tags.comment, color: '#5b737f', fontStyle: 'italic' }
]);
function completions(context: CompletionContext) {
  const prefix = context.state.sliceDoc(Math.max(0, context.pos - 1000), context.pos);
  const quoted = /clip\s+"([^"\n]*)$/.exec(prefix);
  if (quoted) {
    const typed = quoted[1];
    const directory = currentFile.includes('/') ? currentFile.slice(0, currentFile.lastIndexOf('/') + 1) : '';
    return {
      from: context.pos - typed.length,
      options: files
        .filter((file) => ['audio', 'video'].includes(file.kind))
        .map((file) => ({ label: relativeFile(directory, file.path), type: 'variable' }))
    };
  }
  const word = context.matchBefore(/[\w_]*/);
  if (!word || (!context.explicit && word.from === word.to)) return null;
  return {
    from: word.from,
    options: [
      ...['as','after','x','y','scale','crop','duck','scene','title','caption'].map(label=>({label,type:'keyword'})),
      snippetCompletion(
        'film "${Untitled film}" {\n  resolution 1920x1080\n  fps 24\n  track video "Main" {\n    ${}\n  }\n}',
        { label: 'film', detail: 'A complete film' }
      ),
      snippetCompletion('track video "${Main}" {\n  ${}\n}', {
        label: 'track video',
        detail: 'A video layer'
      }),
      snippetCompletion('track audio "${Music}" {\n  ${}\n}', {
        label: 'track audio',
        detail: 'An independent audio mix'
      }),
      snippetCompletion('clip "${media/clip.mp4}" {\n  in ${0s}\n  out ${5s}\n  at ${0s}\n}', {
        label: 'clip',
        detail: 'Trim and place media'
      }),
      snippetCompletion('layer ${1}', {
        label: 'layer',
        detail: 'Explicit video/audio layer (1–256); clip overrides its track'
      }),
      ...['resolution', 'fps', 'in', 'out', 'at', 'opacity', 'gain', 'fade_in', 'fade_out'].map((label) => ({
        label,
        type: 'property'
      }))
    ]
  };
}
function relativeFile(fromDirectory: string, target: string): string {
  const from = fromDirectory.split('/').filter(Boolean),
    to = target.split('/');
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return '../'.repeat(from.length) + to.join('/');
}
function editorState(text: string) {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      highlightActiveLine(),
      cutLanguage,
      syntaxHighlighting(highlighting),
      autocompletion({ override: [completions] }),
      lintGutter(),
      EditorView.contentAttributes.of({ 'aria-label': 'CUT source editor', spellcheck: 'false' }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void save();
            return true;
          }
        },
        {
          key: 'Mod-Enter',
          run: () => {
            void requestPreview(position, false, true);
            return true;
          }
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...closeBracketsKeymap
      ]),
      EditorView.theme(
        {
          '&': { color: '#ccd8df', backgroundColor: '#14191d' },
          '.cm-content': { caretColor: '#cce4d0' },
          '&.cm-focused': { outline: 'none' }
        },
        { dark: true }
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !replacingDocument) sourceChanged();
        if (update.selectionSet || update.docChanged) {
          const line = update.state.doc.lineAt(update.state.selection.main.head);
          cursorStatus.textContent = `Ln ${line.number}, Col ${update.state.selection.main.head - line.from + 1}`;
        }
      })
    ]
  });
}
view = new EditorView({ parent: editorHost, state: editorState('') });

function source() {
  return view.state.doc.toString();
}
function dirty() {
  return source() !== savedSource;
}
function updateButtons() {
  dirtyDot.hidden = !dirty();
  saveButton.disabled = !currentFile || !dirty() || saving;
  checkButton.disabled = !currentFile;
  previewButton.disabled = !currentFile || diagnostics.some((item) => item.severity === 'error');
  exportButton.disabled = !timeline || exportPending;
  fileName.textContent = currentFile ? basename(currentFile) : 'No film selected';
  breadcrumb.textContent = currentFile || 'Select a film.cut file';
  document.title = `${dirty() ? '● ' : ''}${currentFile ? basename(currentFile) + ' — ' : ''}CUT Studio`;
  if (desktop) {
    const stateKey = currentFile + '/' + dirty();
    if (lastDocumentState !== stateKey) {
      lastDocumentState = stateKey;
      desktop.postMessage({ action: 'documentState', dirty: dirty(), file: currentFile });
    }
  }
}
function model() {
  const current = timeline || film;
  if (!current) return undefined;
  const duration =
    timeline?.duration ??
    Math.max(
      0,
      ...current.tracks.flatMap((track) =>
        track.clips.map((clip) => clip.at + (clip.out === undefined ? secondsToTicks(1) : clip.out - clip.in))
      )
    );
  return {
    name: current.name,
    fileName: basename(currentFile),
    resolution: current.resolution,
    fps: current.fps,
    duration: ticksToSeconds(duration),
    resolved: !!timeline,
    tracks: current.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      layer: track.layer,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        path: clip.path,
        label: clip.name || basename(clip.path),
        at: ticksToSeconds(clip.at),
        layer: clip.layer ?? track.layer,
        in: ticksToSeconds(clip.in),
        out: clip.out === undefined ? null : ticksToSeconds(clip.out),
        duration: clip.out === undefined ? null : ticksToSeconds(clip.out - clip.in),
        gain: clip.gain,
        opacity: clip.opacity,
        line: clip.range.start.line + 1
      }))
    }))
  };
}
function send(frame: HTMLIFrameElement, message: unknown) {
  frame.contentWindow?.postMessage(message, window.location.origin);
}
function publish() {
  const errors = diagnostics.filter((item) => item.severity === 'error').length,
    warnings = diagnostics.length - errors;
  const message = { type: 'state', revision, model: model(), state, position, errors, warnings };
  if (monitorReady) send(monitorFrame, message);
  if (timelineReady) send(timelineFrame, message);
  stateIndicator.textContent = {
    empty: 'No film',
    stale: 'Out of date',
    checking: 'Checking',
    rendering: 'Rendering',
    ready: 'Current',
    error: 'Needs attention'
  }[state.kind];
  stateIndicator.dataset.kind = state.kind;
  statusMessage.textContent = state.message;
  problemButton.textContent = `${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`;
  updateButtons();
}
function setState(kind: State['kind'], message: string, progress?: number) {
  state = { kind, message, progress };
  publish();
}
function displayDiagnostics() {
  const maximum = view.state.doc.length;
  const items: EditorDiagnostic[] = diagnostics.map((item) => ({
    from: Math.min(maximum, item.range.start.offset),
    to: Math.min(maximum, Math.max(item.range.start.offset + 1, item.range.end.offset)),
    severity: item.severity,
    message: item.message,
    source: 'CUT'
  }));
  view.dispatch(setDiagnostics(view.state, items));
  problemList.replaceChildren();
  if (!diagnostics.length) problemList.append(node('div', 'problem-empty', 'No source or media problems.'));
  for (const item of diagnostics) {
    const row = button('', `problem-row ${item.severity}`, () =>
      reveal(item.range.start.offset, item.range.end.offset)
    );
    row.append(
      node('span', 'problem-severity', item.severity === 'error' ? '×' : '!'),
      node('span', '', item.message),
      node(
        'span',
        'problem-location',
        `${basename(currentFile)}:${item.range.start.line + 1}:${item.range.start.column + 1}`
      )
    );
    problemList.append(row);
  }
}
function sourceChanged() {
  revision++;
  compileController?.abort();
  previewController?.abort();
  preview = undefined;
  timeline = undefined;
  if (compileTimer) clearTimeout(compileTimer);
  const parsed = parseCut(source());
  film = parsed.film;
  diagnostics = parsed.diagnostics;
  displayDiagnostics();
  setState(
    diagnostics.some((item) => item.severity === 'error') ? 'error' : 'stale',
    diagnostics.some((item) => item.severity === 'error')
      ? 'Fix source errors to refresh the film.'
      : 'Source changed · preview is out of date'
  );
  if (film && !diagnostics.some((item) => item.severity === 'error'))
    compileTimer = setTimeout(() => {
      void compileDocument();
    }, 220);
}
async function compileDocument(showProblems = false): Promise<Timeline | undefined> {
  if (!currentFile) return;
  if (compileTimer) {
    clearTimeout(compileTimer);
    compileTimer = undefined;
  }
  compileController?.abort();
  const controller = new AbortController();
  compileController = controller;
  const currentRevision = revision;
  const file = currentFile;
  setState('checking', 'Checking source and local media…');
  try {
    const result = await api<CompileResult>('/api/compile', { file, source: source() }, controller.signal);
    if (controller.signal.aborted || currentRevision !== revision || file !== currentFile) return;
    film = result.film;
    timeline = result.timeline;
    diagnostics = result.diagnostics;
    displayDiagnostics();
    if (showProblems) problems.hidden = false;
    if (!timeline || diagnostics.some((item) => item.severity === 'error')) {
      setState('error', 'Film has errors · open Problems for details.');
      return;
    }
    position = Math.min(position, ticksToSeconds(timeline.duration));
    setState('stale', 'Timeline current · preparing preview');
    void requestPreview(position);
    return timeline;
  } catch (error) {
    if (!controller.signal.aborted && currentRevision === revision) {
      setState('error', String(error instanceof Error ? error.message : error));
      toast(state.message, true);
    }
  }
}
async function requestPreview(at: number, autoplay = false, force = false) {
  if (!currentFile) return;
  if (!timeline) {
    if (!diagnostics.some((item) => item.severity === 'error')) await compileDocument();
    return;
  }
  position = ticksToSeconds(playablePosition(secondsToTicks(at), timeline.duration, timeline.fps));
  if (
    !force &&
    preview &&
    preview.hash === timeline.hash &&
    position >= preview.from &&
    position < preview.to &&
    state.kind === 'ready'
  ) {
    publish();
    send(monitorFrame, { type: 'seek', revision, previewId: activePreviewId, position, autoplay });
    return;
  }
  previewController?.abort();
  const controller = new AbortController();
  previewController = controller;
  const currentRevision = revision,
    id = ++previewId,
    file = currentFile;
  activePreviewId = id;
  preview = undefined;
  setState('rendering', 'Rendering current composition locally…', 0);
  try {
    const result = await api<Preview>(
      '/api/preview',
      { file, source: source(), position, force, audioCodec: desktop ? 'aac' : 'mp3' },
      controller.signal
    );
    if (controller.signal.aborted || currentRevision !== revision || id !== activePreviewId) return;
    preview = result;
    setState('rendering', result.cached ? 'Loading cached preview…' : 'Loading current preview…', 1);
    if (monitorReady)
      send(monitorFrame, { type: 'preview', revision, previewId: id, ...result, position, autoplay });
  } catch (error) {
    if (!controller.signal.aborted && currentRevision === revision && id === activePreviewId) {
      setState('error', error instanceof Error ? error.message : String(error));
      toast(state.message, true);
    }
  }
}
async function save(): Promise<boolean> {
  if (!currentFile || !dirty()) return true;
  if (saving) return false;
  const file = currentFile,
    text = source();
  saving = true;
  saveButton.disabled = true;
  try {
    const result = await api<{ revision: string }>('/api/save', { file, source: text, revision: diskRevision });
    if (currentFile === file) {
      diskRevision = result.revision;
      conflict.hidden = true;
      savedSource = text;
      updateButtons();
    }
    toast(`Saved ${basename(file)}`);
    return currentFile === file && !dirty();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
    return false;
  } finally {
    saving = false;
    updateButtons();
    void syncOpenFilm();
  }
}
async function openFile(file: FileEntry, discardConfirmed = false) {
  if (file.kind !== 'cut') {
    if(file.kind==='video'||file.kind==='audio'){editingTools('Footage',file.path);return;}
    toast(`${file.path} · local ${file.kind === 'other' ? 'project file' : file.kind + ' source'}`);
    return;
  }
  if (currentFile === file.path) {
    view.focus();
    return;
  }
  if (
    dirty() &&
    !discardConfirmed &&
    !window.confirm(`Discard unsaved edits to ${basename(currentFile)} and open ${file.name}?`)
  )
    return;
  const openId = ++openSequence;
  compileController?.abort();
  previewController?.abort();
  try {
    const result = await api<DiskFilm>(
      `/api/file?path=${encodeURIComponent(file.path)}`
    );
    if (openId !== openSequence) return;
    currentFile = file.path;
    savedSource = result.source;
    diskRevision = result.revision;
    conflict.hidden = true;
    position = 0;
    replacingDocument = true;
    view.setState(editorState(result.source));
    replacingDocument = false;
    cursorStatus.textContent = 'Ln 1, Col 1';
    watchProject();
    drawTree();
    sourceChanged();
    view.focus();
  } catch (error) {
    replacingDocument = false;
    toast(error instanceof Error ? error.message : String(error), true);
  }
}
function watchProject() {
  projectEvents?.close();
  const query = new URLSearchParams({ token: bootstrap.token });
  if (currentFile) query.set('file', currentFile);
  projectEvents = new EventSource('/api/changes?' + query);
  let dependencyChanged=false;
  projectEvents.addEventListener('changed', (event) => {
    const changed: { file?: string } = JSON.parse(event.data);
    if (changed.file && changed.file !== currentFile && film?.scenes?.length &&
        (!timeline || timeline.dependencies?.includes(bootstrap.root + '/' + changed.file))) dependencyChanged=true;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (dependencyChanged) { dependencyChanged=false; sourceChanged(); }
      void syncOpenFilm();
      void refreshFiles();
    }, 100);
  });
}

async function syncOpenFilm(discardDraft = false) {
  if (!currentFile || saving) return;
  const file = currentFile, base = diskRevision, request = ++syncSequence, localEdit = revision;
  try {
    const result = await api<DiskFilm>(`/api/file?path=${encodeURIComponent(file)}`);
    if (file !== currentFile || request !== syncSequence || diskRevision !== base || saving) return;
    if (result.revision === base && !discardDraft) {
      conflict.hidden = true;
      return;
    }
    if (result.source !== source() && dirty() && !(discardDraft && localEdit === revision)) {
      conflict.hidden = false;
      return;
    }
    conflict.hidden = true;
    savedSource = result.source;
    diskRevision = result.revision;
    if (source() === result.source) { updateButtons(); return; }
    const cursor = Math.min(view.state.selection.main.head, result.source.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.source },
      selection: { anchor: cursor }
    });
    toast(`Reloaded ${basename(file)} from disk`);
  } catch (error) {
    // A failed background refresh must never replace the document in the editor.
    if (discardDraft) toast(error instanceof Error ? error.message : String(error), true);
  }
}

async function saveDraftCopy() {
  const file = currentFile, text = source();
  const entered = window.prompt('Save your edits as a new CUT film', file.replace(/\.cut$/i, ' - my edit.cut'));
  if (!entered?.trim()) return;
  const name = /\.cut$/i.test(entered.trim()) ? entered.trim() : entered.trim() + '.cut';
  try {
    await api('/api/save', { file: name, source: text });
    if (currentFile === file && source() === text)
      await openFile({ path: name, name: basename(name), kind: 'cut' }, true);
    await refreshFiles();
    toast(`Saved your edits to ${name}`);
  } catch (error) { toast(error instanceof Error ? error.message : String(error), true); }
}

function editingTools(page:'Clip'|'Footage'|'Scenes'|'Review',asset?:string) {
  const file=currentFile,text=source(),selection=view.state.selection.main.head;
  const selected=film?.tracks.flatMap(t=>t.clips).find(c=>selection>=c.range.start.offset && selection<=c.range.end.offset)?.id;
  openEditing({file,source:text,saved:savedSource,selected,position,timeline,files,
    request:<T>(action:string,payload:unknown,signal?:AbortSignal)=>api<T>('/api/studio/'+action,payload,signal),
    change(proposed,changes) {
      if(currentFile!==file || source()!==text) throw new Error('The open film changed. Reopen clip tools against its latest source.');
      view.dispatch({changes});
      if(source()!==proposed) throw new Error('Could not apply all changes to the editor.');
      toast('Edit applied · ⌘Z to undo');view.focus();
    },
    openScene(relative) {
      const url=new URL(relative.split('/').map(encodeURIComponent).join('/'),new URL(file.split('/').map(encodeURIComponent).join('/'), 'http://cut.local/'));
      const path=decodeURIComponent(url.pathname.slice(1));
      void openFile({path,name:basename(path),kind:'cut'});
    },
    async copy(name) {
      if(!name.trim() || /[\\/]/.test(name) || !/\.cut$/i.test(name))throw new Error('Use a .cut filename in the current folder.');
      const directory=file.includes('/') ? file.slice(0,file.lastIndexOf('/')+1):'';
      await api('/api/save',{file:directory+name.trim(),source:text});await refreshFiles();
    }
  },page,asset);
}
async function newFilm() {
  let proposed = 'untitled.cut',
    suffix = 2;
  while (files.some((file) => file.path === proposed)) proposed = `untitled-${suffix++}.cut`;
  const entered = window.prompt('New film — name within this project', proposed);
  if (!entered?.trim()) return;
  const filename = /\.cut$/i.test(entered.trim()) ? entered.trim() : `${entered.trim()}.cut`;
  if (files.some((file) => file.path === filename)) {
    toast('A film with that name already exists. Choose a different name.', true);
    return;
  }
  if (
    dirty() &&
    !window.confirm(`Discard unsaved edits to ${basename(currentFile)} and create ${basename(filename)}?`)
  )
    return;
  const name = basename(filename)
    .replace(/\.cut$/i, '')
    .replace(/[-_]/g, ' ');
  const asset = files.find((file) => file.kind === 'video') || files.find((file) => file.kind === 'audio');
  const directory = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/') + 1) : '';
  const track = asset
    ? `  track ${asset.kind} "${asset.kind === 'video' ? 'Picture' : 'Sound'}" {\n    clip ${JSON.stringify(relativeFile(directory, asset.path))} {\n      in 0s\n      at 0s\n    }\n  }`
    : '  track video "Picture" {\n    // Add a clip after placing footage in this project.\n    // clip "media/clip.mp4" from 0s to 5s at 0s\n  }';
  const text = `film ${JSON.stringify(name)} {\n  resolution 1280x720\n  fps 24\n\n${track}\n}\n`;
  try {
    // Omitting mtime requests create-only semantics. The server rejects an existing path.
    await api('/api/save', { file: filename, source: text });
    const file: FileEntry = { path: filename, name: basename(filename), kind: 'cut' };
    // Creation was explicitly chosen above; keep openFile from asking to discard twice.
    await openFile(file, true);
    await refreshFiles();
    toast(`Created ${basename(filename)}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  }
}
async function refreshFiles() {
  try {
    const result = await api<{ root: string; files: FileEntry[] }>('/api/tree');
    files = result.files;
    drawTree();
    if (!currentFile) {
      const requested = new URLSearchParams(location.search).get('file');
      const first =
        files.find((file) => file.kind === 'cut' && file.path === requested) ||
        files.find((file) => file.path === 'signal.cut') ||
        files.find((file) => file.kind === 'cut');
      if (first) await openFile(first);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  }
}
function drawTree() {
  fileTree.replaceChildren();
  const query = filter.value.toLowerCase();
  const visible = files.filter((file) => !query || file.path.toLowerCase().includes(query));
  const paths = new Set<string>();
  for (const file of visible) {
    const parts = file.path.split('/');
    let parent = '';
    let hidden = false;
    for (let index = 0; index < parts.length - 1; index++) {
      const folder = parent + parts[index];
      if (!paths.has(folder)) {
        paths.add(folder);
        const folderRow = button('', 'tree-row directory', () => {
          if (collapsed.has(folder)) collapsed.delete(folder);
          else collapsed.add(folder);
          drawTree();
        });
        folderRow.style.setProperty('--depth', String(index));
        folderRow.append(
          node('span', 'chevron', collapsed.has(folder) && !query ? '›' : '⌄'),
          node('span', 'file-name', parts[index])
        );
        folderRow.title = folder;
        fileTree.append(folderRow);
      }
      if (collapsed.has(folder) && !query) {
        hidden = true;
        break;
      }
      parent = folder + '/';
    }
    if (hidden) continue;
    const row = button('', `tree-row${file.path === currentFile ? ' active' : ''}`, () => openFile(file));
    row.style.setProperty('--depth', String(parts.length - 1));
    row.title = file.path;
    row.append(
      node('span', `file-icon ${file.kind}`, { cut: '/', video: '▤', audio: '♪', other: '·' }[file.kind]),
      node('span', 'file-name', file.name || basename(file.path))
    );
    fileTree.append(row);
  }
  if (!visible.length)
    fileTree.append(
      node(
        'div',
        'explorer-note',
        query ? 'No matching project files.' : 'No films yet. Use + to create your first film.'
      )
    );
}
function reveal(from: number, to: number) {
  const maximum = view.state.doc.length;
  view.dispatch({
    selection: { anchor: Math.min(maximum, from), head: Math.min(maximum, to) },
    effects: EditorView.scrollIntoView(Math.min(maximum, from), { y: 'center' })
  });
  view.focus();
}
function toggleProblems() {
  problems.hidden = !problems.hidden;
}
function toggleTimeline() {
  const hidden = workspace.classList.toggle('timeline-hidden');
  timelineButton.textContent = hidden ? 'Timeline ↑' : 'Timeline ↓';
}

async function exportMovie() {
  if (exportPending || !currentFile) return;
  exportPending = true;
  updateButtons();
  let progress: HTMLElement | undefined;
  try {
    if (!timeline && !(await compileDocument(true))) return;
    const preflight=timeline ? premierePlan(timeline) : undefined;
    const selection = await chooseExport(basename(currentFile),preflight);
    if (!selection) return;
    const payload = { ...selection, file: currentFile, source: source(), overwrite: false };
    let result: { id: string; exists?: boolean } = await api('/api/export', payload);
    if (result.exists) {
      if (!window.confirm(`Replace the existing file “${selection.output}”?`)) return;
      result = await api('/api/export', { ...payload, overwrite: true });
    }
    exportJob = result.id;
    progress = node('div', 'export-progress');
    progress.setAttribute('role', 'status');
    const label = node('span', '', 'Exporting…');
    const cancel = button('Cancel', '', async () => {
      if (!exportJob) return;
      cancel.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(exportJob)}/cancel`, {});
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
        cancel.disabled = false;
      }
    });
    progress.append(label, cancel);
    headerTools.before(progress);
    while (exportJob === result.id) {
      const job = await api<
        Partial<ExportedFile> & {
          state: 'rendering' | 'complete' | 'error' | 'cancelled';
          fraction: number;
          message?: string;
          error?: string;
        }
      >(`/api/jobs/${encodeURIComponent(result.id)}`);
      if (job.state === 'complete' && job.output) {
        showExported(
          { output: job.output, src: job.src, warnings: job.warnings },
          desktop ? (path) => desktop.postMessage({ action: 'reveal', path }) : undefined
        );
        break;
      }
      if (job.state === 'cancelled') {
        toast('Export cancelled.');
        break;
      }
      if (job.state === 'error') throw new Error(job.error || 'Export failed.');
      label.textContent =
        selection.format === 'mp4'
          ? `Rendering… ${Math.round(job.fraction * 100)}%`
          : job.message || 'Writing sequence…';
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    void refreshFiles();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    progress?.remove();
    exportJob = undefined;
    exportPending = false;
    updateButtons();
  }
}

function showHelp() {
  if (document.querySelector('.syntax-help')) {
    document.querySelector('.syntax-help')?.remove();
    return;
  }
  const help = node('section', 'syntax-help');
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'CUT language guide');
  help.append(
    button('×', '', () => help.remove(), 'Close guide'),
    node('h2', '', 'A film, written in CUT.'),
    node(
      'p',
      '',
      'Trim a source with in and out, then place it at an absolute timeline position with at. Out is exclusive. Assign track video "B-roll" layer 3 or add layer 3 inside a clip. Higher video layer numbers appear on top. Audio uses its own independent layer numbers.'
    )
  );
  help.append(
    node(
      'pre',
      '',
      `film "My short film" {\n  resolution 1920x1080\n  fps 24\n  track video "Main" {\n    clip "media/opening.mp4" from 1s to 6s at 0s\n  }\n  track audio "Score" {\n    clip "media/music.wav" {\n      at 0s\n      gain -12dB\n      fade_in 1s\n      fade_out 2s\n    }\n  }\n}`
    )
  );
  help.append(
    node(
      'p',
      '',
      'Times: 52s · 1m00.052s · 00:01:00.052 · 00:00:01:00 · 24f. Video cuts resolve to the output frame grid. Audio uses precise source times. Add opacity 0.4 to a video clip to make it translucent.'
    )
  );
  help.append(
    node(
      'p',
      '',
      '⌘S / Ctrl+S saves your source. ⌘Enter / Ctrl+Enter refreshes preview. In the monitor or timeline, Space plays or pauses, ← / → steps one frame, and Home returns to the beginning. Click a timeline clip to select its code. Drag the dividers to resize panels.'
    )
  );
  help.append(node('p','','Name a shot with as entrance. Use after entrance or at entrance.start - 8f. Insert a reusable film with scene "cafe.cut" as cafe { at 0s }. For titles and captions, put title "Text" or caption "Text" on a video layer with an out duration. Edit & review offers footage search, picture framing, dialogue ducking and A/B playback.'));
  document.body.append(help);
}

function setupSplitter(splitter: HTMLElement, dimension: 'monitor' | 'timeline') {
  splitter.addEventListener('keydown', (event) => {
    const key = event.key;
    if (dimension === 'monitor' && ['ArrowLeft', 'ArrowRight'].includes(key)) {
      event.preventDefault();
      const current = monitorPanel.getBoundingClientRect().width;
      document.documentElement.style.setProperty(
        '--monitor',
        `${Math.max(290, Math.min(upper.clientWidth - 270, current + (key === 'ArrowLeft' ? 24 : -24)))}px`
      );
    }
    if (dimension === 'timeline' && ['ArrowUp', 'ArrowDown'].includes(key)) {
      event.preventDefault();
      const current = timelinePanel.getBoundingClientRect().height;
      document.documentElement.style.setProperty(
        '--timeline',
        `${Math.max(130, Math.min(workspace.clientHeight - 220, current + (key === 'ArrowUp' ? 24 : -24)))}px`
      );
    }
  });
  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.focus();
    splitter.setPointerCapture(event.pointerId);
    shell.classList.add('resizing');
    splitter.classList.add('splitter-dragging');
    const move = (event: PointerEvent) => {
      if (dimension === 'monitor') {
        const rectangle = upper.getBoundingClientRect();
        const width = Math.max(290, Math.min(rectangle.width - 270, rectangle.right - event.clientX));
        document.documentElement.style.setProperty('--monitor', `${width}px`);
      } else {
        const rectangle = workspace.getBoundingClientRect();
        const height = Math.max(130, Math.min(rectangle.height - 220, rectangle.bottom - event.clientY));
        document.documentElement.style.setProperty('--timeline', `${height}px`);
      }
    };
    const finish = () => {
      shell.classList.remove('resizing');
      splitter.classList.remove('splitter-dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', finish);
      splitter.removeEventListener('pointercancel', finish);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', finish);
    splitter.addEventListener('pointercancel', finish);
  });
}
setupSplitter(verticalSplitter, 'monitor');
setupSplitter(horizontalSplitter, 'timeline');

window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    ![monitorFrame.contentWindow, timelineFrame.contentWindow].includes(event.source as Window)
  )
    return;
  const envelope = event.data;
  if (!envelope || typeof envelope !== 'object' || !envelope.cutPanel) return;
  const data = envelope.data;
  if (!data || typeof data !== 'object') return;
  const role = event.source === monitorFrame.contentWindow ? 'monitor' : 'timeline';
  if (data.type === 'ready') {
    if (role === 'monitor') monitorReady = true;
    else timelineReady = true;
    publish();
    if (role === 'monitor' && preview)
      send(monitorFrame, {
        type: 'preview',
        revision,
        previewId: activePreviewId,
        ...preview,
        position,
        autoplay: false
      });
    return;
  }
  if (data.revision !== revision) return;
  if (
    ['tick', 'next', 'playbackReady', 'playbackError', 'proxyFallback'].includes(data.type) &&
    data.previewId !== activePreviewId
  )
    return;
  if (data.type === 'seek' && typeof data.position === 'number' && Number.isFinite(data.position))
    void requestPreview(data.position, !!data.autoplay);
  else if (data.type === 'tick' && typeof data.position === 'number' && preview) {
    position = Math.max(preview.from, Math.min(preview.to, data.position));
    if (timelineReady) send(timelineFrame, { type: 'position', revision, position });
  } else if (data.type === 'next' && preview && timeline) {
    if (preview.to < ticksToSeconds(timeline.duration)) void requestPreview(preview.to, true);
    else {
      position = ticksToSeconds(timeline.duration);
      publish();
    }
  } else if (data.type === 'playbackReady' && preview)
    setState(
      'ready',
      preview.direct
        ? 'Preview current · direct source · video track muted'
        : 'Preview current · decoded locally'
    );
  else if (data.type === 'proxyFallback') void requestPreview(position, false, true);
  else if (data.type === 'playbackError') {
    setState('error', `Preview playback failed: ${String(data.message || 'unknown media error')}`);
    toast(state.message, true);
  } else if (data.type === 'select' || data.type === 'editClip') {
    const resolved=timeline?.tracks.flatMap(track=>track.clips).find(c=>c.id===data.id);
    const clip=resolved || film?.tracks.flatMap(track=>track.clips).find(c=>c.id===data.id);
    if (clip) {
      reveal(clip.range.start.offset,clip.range.end.offset);
      if (data.type === 'editClip') {
        if (resolved?.originFile && resolved.originFile.startsWith(bootstrap.root+'/')) {
          const path=resolved.originFile.slice(bootstrap.root.length+1);
          void openFile({path,name:basename(path),kind:'cut'});
        } else editingTools('Clip');
      } else void requestPreview(ticksToSeconds(clip.at));
    }
  } else if (data.type === 'toggle') send(monitorFrame, { type: 'toggle', revision });
  else if (data.type === 'render') void requestPreview(position, false, true);
  else if (data.type === 'export') void exportMovie();
  else if (data.type === 'problems') problems.hidden = false;
});

function frameHtml(role: 'monitor' | 'timeline') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"><style>body[data-role=monitor] #studio{padding-top:15px}.monitor-header{display:none}.film-heading{padding-top:5px;padding-bottom:16px}.monitor-footer{padding-top:12px;padding-bottom:12px}.inspector{padding-bottom:16px}body[data-role=monitor] #studio{min-height:100vh}body{scrollbar-color:#465159 #16191c}</style></head><body data-role="${role}" data-host="studio"><main id="studio"></main><script src="/panel-bridge.js"></script><script src="/studio.js"></script></body></html>`;
}
monitorFrame.srcdoc = frameHtml('monitor');
timelineFrame.srcdoc = frameHtml('timeline');
if (desktop) {
  window.cutNative = {
    async canClose() {
      if (saving) {
        toast('Finishing the save. Try again in a moment.');
        return false;
      }
      if (exportPending && !window.confirm('Close this project and cancel the current export?')) return false;
      return (
        !dirty() ||
        window.confirm(
          `Discard unsaved edits to ${basename(currentFile)}? Choose Cancel to keep editing or save first.`
        )
      );
    },
    save,
    newFilm,
    refreshFiles,
    exportFilm: exportMovie,
    async openFile(path) {
      await openFile({ path, name: basename(path), kind: 'cut' });
    },
    undo: () => (view.hasFocus ? undo(view) : document.execCommand('undo')),
    redo: () => (view.hasFocus ? redo(view) : document.execCommand('redo'))
  };
}
window.addEventListener('beforeunload', (event) => {
  if (!desktop && dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    problems.hidden = true;
    document.querySelector('.syntax-help')?.remove();
  }
});
window.addEventListener('focus', () => { void syncOpenFilm(); void refreshFiles(); });
publish();
void refreshFiles().then(() => { if (!projectEvents) watchProject(); });
