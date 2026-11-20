import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { compile } from '../core/compiler';
import { parseCut } from '../core/parser';
import {
  secondsToTicks,
  ticksToSeconds,
  playablePosition,
  previewWindow,
  formatTime,
  parseTime
} from '../core/time';
import type { CompileResult, Film, Timeline, Tick, Diagnostic, PreviewResult } from '../core/types';
import {
  configureTools,
  render,
  renderRange,
  renderPreview,
  findDirectPreview,
  atomicWriteOutput
} from '../engine';
import { exportFcp7 } from '../exporters/fcp7';
import { exportResolve } from '../exporters/resolve';
import { exportPremiere } from '../exporters/premiere';
import { webviewHtml } from './webview';
import { CutCompletionProvider } from './completion';

type StateKind = 'empty' | 'stale' | 'checking' | 'rendering' | 'ready' | 'error' | 'untrusted';
type StudioState = { kind: StateKind; message: string; progress?: number };

export function activate(context: vscode.ExtensionContext): void {
  const studio = new CutStudio(context);
  context.subscriptions.push(studio);
  studio.activate();
}
export function deactivate(): void {
  /* Disposables cancel the active render. */
}

class CutStudio implements vscode.Disposable, vscode.WebviewViewProvider {
  private doc?: vscode.TextDocument;
  private film?: Film;
  private timeline?: Timeline;
  private monitor?: vscode.WebviewPanel;
  private timelineView?: vscode.WebviewView;
  private sourceVersion = 0;
  private compileController?: AbortController;
  private renderController?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private position: Tick = 0;
  private preview?: PreviewResult;
  private previewId = 0;
  private diagnosticList: Diagnostic[] = [];
  private state: StudioState = { kind: 'empty', message: 'Open a .cut file to begin.' };
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('cut');
  private readonly output = vscode.window.createOutputChannel('CUT Studio');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private readonly disposables: vscode.Disposable[] = [];
  private assetWatchers: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  activate(): void {
    this.configure();
    this.status.command = 'cut.openPreview';
    this.status.text = '$(film) CUT Studio';
    this.status.tooltip = 'Open CUT Studio video monitor';
    this.disposables.push(
      this.diagnostics,
      this.output,
      this.status,
      vscode.window.registerWebviewViewProvider('cut.timelineView', this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.languages.registerCompletionItemProvider(
        { language: 'cut', scheme: 'file' },
        new CutCompletionProvider(),
        '"',
        '/',
        ' '
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'cut') this.bind(editor.document);
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.languageId === 'cut' && vscode.window.activeTextEditor?.document === document)
          this.bind(document);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.doc) this.changed();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === this.doc && !this.timeline) this.scheduleCompile(0);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('cut')) {
          this.configure();
          if (this.doc) this.changed();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        if (this.doc) this.changed();
      })
    );
    // External media changes must invalidate both the model and the preview, including cached proxies.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const mediaChanged = (uri: vscode.Uri) => {
      if (!this.doc || uri.fsPath.includes(`${path.sep}.cut-cache${path.sep}`)) return;
      const referenced = this.film?.tracks.some((track) =>
        track.clips.some((clip) => path.resolve(path.dirname(this.doc!.uri.fsPath), clip.path) === uri.fsPath)
      );
      if (referenced) this.changed();
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(mediaChanged),
      watcher.onDidCreate(mediaChanged),
      watcher.onDidDelete(mediaChanged)
    );
    const commands: Record<string, () => unknown> = {
      'cut.openPreview': () => this.openMonitor(),
      'cut.check': () => this.checkCommand(),
      'cut.timeline': () => this.showTimeline(),
      'cut.preview': () => this.previewCommand(),
      'cut.render': () => this.exportMovie(),
      'cut.renderRange': () => this.exportMovie(true),
      'cut.exportXml': () => this.exportSequence('xml'),
      'cut.exportResolve': () => this.exportSequence('drp'),
      'cut.exportPremiere': () => this.exportSequence('prproj')
    };
    for (const [id, handler] of Object.entries(commands))
      this.disposables.push(vscode.commands.registerCommand(id, handler));
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'cut') this.bind(active);
  }

  private configure(): void {
    const config = vscode.workspace.getConfiguration('cut');
    configureTools({
      ffmpegPath: config.get<string>('ffmpegPath', 'ffmpeg'),
      ffprobePath: config.get<string>('ffprobePath', 'ffprobe')
    });
  }

  private bind(document: vscode.TextDocument): void {
    if (this.disposed) return;
    if (this.doc === document) {
      this.status.show();
      return;
    }
    if (document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        'Save this CUT document to a local .cut file so relative media paths can be resolved.'
      );
      return;
    }
    this.doc = document;
    this.position = 0;
    this.preview = undefined;
    this.timeline = undefined;
    this.updateRoots();
    this.status.show();
    this.changed();
    // Preserve focus in the native source editor while putting the monitor beside it.
    void this.openMonitor(true);
    void vscode.commands.executeCommand('cut.timelineView.focus').then(() => {
      if (this.doc !== document || this.disposed) return;
      const editor = vscode.window.visibleTextEditors.find((item) => item.document === document);
      if (editor)
        void vscode.window.showTextDocument(document, {
          viewColumn: editor.viewColumn,
          preserveFocus: false
        });
    });
  }

  private ensureDocument(): vscode.TextDocument | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'cut' && active !== this.doc) this.bind(active);
    if (!this.doc) void vscode.window.showInformationMessage('Open a local .cut file first.');
    return this.doc;
  }

  private changed(): void {
    if (!this.doc) return;
    this.sourceVersion++;
    this.compileController?.abort();
    this.renderController?.abort();
    this.preview = undefined;
    this.timeline = undefined;
    // This message is posted synchronously on edit; old video is never labelled current.
    this.state = { kind: 'stale', message: 'Source changed · preview is out of date' };
    const parsed = parseCut(this.doc.getText());
    this.film = parsed.film;
    this.diagnosticList = parsed.diagnostics;
    this.watchExternalAssets();
    this.publishDiagnostics(parsed.diagnostics);
    this.publish();
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error') || !parsed.film) {
      this.setState('error', 'Fix source errors to refresh the preview.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.setState('untrusted', 'Trust this workspace to inspect local media and render previews.');
      return;
    }
    this.scheduleCompile(220);
  }

  private scheduleCompile(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.compileDocument();
    }, delay);
  }

  private async compileDocument(): Promise<CompileResult | undefined> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const document = this.doc;
    const version = this.sourceVersion;
    if (!document || !vscode.workspace.isTrusted) return;
    this.compileController?.abort();
    const controller = new AbortController();
    this.compileController = controller;
    this.setState('checking', 'Checking source and local media…');
    try {
      const result = await compile(document.getText(), document.uri.fsPath, { signal: controller.signal });
      if (controller.signal.aborted || document !== this.doc || version !== this.sourceVersion) return;
      this.film = result.film;
      this.timeline = result.timeline;
      this.diagnosticList = result.diagnostics;
      this.publishDiagnostics(result.diagnostics);
      if (!result.timeline || result.diagnostics.some((item) => item.severity === 'error')) {
        this.setState('error', 'Film has errors · see Problems for details.');
        return result;
      }
      this.position = Math.min(this.position, result.timeline.duration);
      this.setState('stale', 'Timeline current · preview needs rendering');
      if (
        vscode.workspace.getConfiguration('cut').get<boolean>('autoPreview', true) &&
        (this.monitor || this.timelineView?.visible)
      )
        void this.previewAt(this.position);
      return result;
    } catch (error) {
      if (!controller.signal.aborted && version === this.sourceVersion) this.fail(error);
    }
  }

  private watchExternalAssets(): void {
    for (const disposable of this.assetWatchers) disposable.dispose();
    this.assetWatchers = [];
    if (!this.doc || !this.film) return;
    const external = new Set(
      this.film.tracks
        .flatMap((track) =>
          track.clips.map((clip) => path.resolve(path.dirname(this.doc!.uri.fsPath), clip.path))
        )
        .filter((file) => !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)))
    );
    for (const directory of new Set([...external].map((file) => path.dirname(file)))) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(directory), '*')
      );
      const onChange = (uri: vscode.Uri) => {
        if (external.has(uri.fsPath)) this.changed();
      };
      this.assetWatchers.push(
        watcher,
        watcher.onDidChange(onChange),
        watcher.onDidCreate(onChange),
        watcher.onDidDelete(onChange)
      );
    }
  }

  private publishDiagnostics(items: Diagnostic[]): void {
    if (!this.doc) return;
    this.diagnostics.set(
      this.doc.uri,
      items.map((item) => {
        const range = new vscode.Range(
          item.range.start.line,
          item.range.start.column,
          item.range.end.line,
          item.range.end.column
        );
        const diagnostic = new vscode.Diagnostic(
          range,
          item.message,
          item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'CUT';
        diagnostic.code = item.code;
        return diagnostic;
      })
    );
  }

  private roots(): vscode.Uri[] {
    return [
      this.context.extensionUri,
      ...(this.doc ? [vscode.Uri.file(path.dirname(this.doc.uri.fsPath))] : []),
      ...(this.preview?.direct ? [vscode.Uri.file(path.dirname(this.preview.path))] : [])
    ];
  }
  private updateRoots(): void {
    for (const webview of this.webviews())
      webview.options = { enableScripts: true, localResourceRoots: this.roots() };
  }
  private webviews(): vscode.Webview[] {
    return [this.monitor?.webview, this.timelineView?.webview].filter(
      (item): item is vscode.Webview => !!item
    );
  }

  private async openMonitor(preserveFocus = false): Promise<void> {
    if (!this.doc) {
      if (!this.ensureDocument()) return;
    }
    if (this.monitor) {
      this.monitor.reveal(this.monitor.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus);
      this.publish();
      return;
    }
    this.monitor = vscode.window.createWebviewPanel(
      'cut.monitor',
      'CUT · Video Monitor',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: this.roots() }
    );
    const panel = this.monitor;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'cut.svg');
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'monitor');
    this.disposables.push(
      panel.onDidDispose(() => {
        if (this.monitor === panel) {
          this.monitor = undefined;
          this.renderController?.abort();
        }
      }),
      panel.webview.onDidReceiveMessage((message) => this.receive(message))
    );
    if (this.timeline && !this.preview) void this.previewAt(this.position);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.timelineView = view;
    view.webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, 'timeline');
    this.disposables.push(
      view.webview.onDidReceiveMessage((message) => this.receive(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.publish();
      }),
      view.onDidDispose(() => {
        if (this.timelineView === view) this.timelineView = undefined;
      })
    );
  }

  private model(): unknown {
    const film = this.timeline || this.film;
    if (!film) return undefined;
    const duration =
      this.timeline?.duration ??
      Math.max(
        0,
        ...film.tracks.flatMap((track) =>
          track.clips.map(
            (clip) => clip.at + (clip.out === undefined ? secondsToTicks(1) : clip.out - clip.in)
          )
        )
      );
    return {
      name: film.name,
      fileName: this.doc ? path.basename(this.doc.uri.fsPath) : '',
      resolution: film.resolution,
      fps: film.fps,
      duration: ticksToSeconds(duration),
      resolved: !!this.timeline,
      tracks: film.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        layer: track.layer,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          path: clip.path,
          label: clip.name || path.basename(clip.path),
          at: ticksToSeconds(clip.at),
          layer: clip.layer ?? track.layer,
          in: ticksToSeconds(clip.in),
          out: clip.out === undefined ? null : ticksToSeconds(clip.out),
          duration: clip.out === undefined ? null : ticksToSeconds(clip.out - clip.in),
          opacity: clip.opacity,
          gain: clip.gain,
          line: clip.range.start.line + 1
        }))
      }))
    };
  }
  private publish(): void {
    if (this.disposed) return;
    const message = {
      type: 'state',
      revision: this.sourceVersion,
      model: this.model(),
      state: this.state,
      position: ticksToSeconds(this.position),
      errors: this.diagnosticList.filter((item) => item.severity === 'error').length,
      warnings: this.diagnosticList.filter((item) => item.severity === 'warning').length
    };
    for (const webview of this.webviews()) void webview.postMessage(message);
    this.status.text = `$(film) CUT ${this.state.kind === 'ready' ? '· current' : this.state.kind === 'rendering' ? '· rendering' : this.state.kind === 'error' ? '· errors' : '· ' + this.state.kind}`;
  }
  private setState(kind: StateKind, message: string, progress?: number): void {
    this.state = { kind, message, progress };
    this.publish();
  }
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    this.setState('error', message);
  }

  private async previewAt(position: Tick, autoplay = false, force = false): Promise<void> {
    if (!this.timeline || !this.doc || !vscode.workspace.isTrusted) return;
    const timeline = this.timeline;
    const version = this.sourceVersion;
    const target = playablePosition(position, timeline.duration, timeline.fps);
    this.position = target;
    if (
      !force &&
      this.state.kind === 'ready' &&
      this.preview &&
      this.preview.hash === timeline.hash &&
      target >= this.preview.from &&
      target < this.preview.to
    ) {
      this.setState(
        'ready',
        this.preview.direct
          ? 'Preview current · direct source · video track muted'
          : 'Preview current · cached locally'
      );
      void this.monitor?.webview.postMessage({
        type: 'seek',
        revision: version,
        position: ticksToSeconds(target),
        autoplay
      });
      return;
    }
    this.renderController?.abort();
    const controller = new AbortController();
    this.renderController = controller;
    const segmentSize = secondsToTicks(
      vscode.workspace.getConfiguration('cut').get<number>('previewSegmentSeconds', 8)
    );
    const { from, to } = previewWindow(target, timeline.duration, timeline.fps, segmentSize);
    this.preview = undefined;
    const direct = !force ? findDirectPreview(timeline, { from, to }) : undefined;
    if (direct) {
      this.preview = direct;
      this.setState('checking', 'Loading direct source into monitor…');
      this.sendPreview(direct, version, autoplay);
      return;
    }
    this.setState('rendering', `Rendering preview · ${formatTime(from)} — ${formatTime(to)}`, 0);
    try {
      const result = await renderPreview(timeline, {
        cacheDir: path.join(path.dirname(this.doc.uri.fsPath), '.cut-cache', 'previews'),
        from,
        to,
        format: 'mp4',
        audioCodec: 'mp3',
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted && version === this.sourceVersion)
            this.setState('rendering', 'Rendering current composition…', progress.fraction);
        }
      });
      if (controller.signal.aborted || version !== this.sourceVersion || timeline !== this.timeline) return;
      this.preview = result;
      this.setState('checking', 'Loading rendered preview into monitor…');
      this.sendPreview(result, version, autoplay);
    } catch (error) {
      if (!controller.signal.aborted && version === this.sourceVersion) this.fail(error);
    }
  }

  private sendPreview(result: PreviewResult, revision: number, autoplay: boolean): void {
    this.updateRoots();
    if (this.monitor) {
      const previewId = ++this.previewId;
      this.setState('checking', 'Loading local preview into monitor…');
      void this.monitor.webview.postMessage({
        type: 'preview',
        revision,
        previewId,
        src: this.monitor.webview.asWebviewUri(vscode.Uri.file(result.path)).toString(),
        mimeType: /\.webm$/i.test(result.path) ? 'video/webm' : 'video/mp4',
        from: ticksToSeconds(result.from),
        to: ticksToSeconds(result.to),
        sourceIn: ticksToSeconds(result.sourceIn ?? 0),
        direct: !!result.direct,
        position: ticksToSeconds(this.position),
        autoplay
      });
    }
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;
    if (data.type === 'ready') {
      this.publish();
      if (data.role !== 'timeline' && this.preview && this.monitor)
        this.sendPreview(this.preview, this.sourceVersion, false);
      return;
    }
    if (data.revision !== this.sourceVersion) return;
    if (
      ['playbackReady', 'playbackError', 'proxyFallback'].includes(String(data.type)) &&
      data.previewId !== this.previewId
    )
      return;
    if (data.type === 'seek' && typeof data.position === 'number' && Number.isFinite(data.position))
      await this.previewAt(secondsToTicks(Math.max(0, data.position)), data.autoplay === true);
    else if (
      data.type === 'tick' &&
      typeof data.position === 'number' &&
      Number.isFinite(data.position) &&
      this.timeline &&
      this.preview
    ) {
      this.position = Math.max(this.preview.from, Math.min(secondsToTicks(data.position), this.preview.to));
      void this.timelineView?.webview.postMessage({
        type: 'position',
        position: ticksToSeconds(this.position)
      });
    } else if (data.type === 'next' && this.timeline && this.preview) {
      if (this.preview.to < this.timeline.duration) await this.previewAt(this.preview.to, true);
      else {
        this.position = this.timeline.duration;
        this.publish();
      }
    } else if (data.type === 'select' && typeof data.id === 'string') {
      const clip = this.film?.tracks.flatMap((track) => track.clips).find((item) => item.id === data.id);
      if (clip && this.doc) {
        const sourceColumn =
          vscode.window.visibleTextEditors.find((editor) => editor.document === this.doc)?.viewColumn ??
          vscode.ViewColumn.One;
        const editor = await vscode.window.showTextDocument(this.doc, {
          viewColumn: sourceColumn,
          preserveFocus: false
        });
        const range = new vscode.Range(
          clip.range.start.line,
          clip.range.start.column,
          clip.range.end.line,
          clip.range.end.column
        );
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await this.previewAt(clip.at);
      }
    } else if (data.type === 'playbackReady' && this.preview) {
      this.setState(
        'ready',
        this.preview.direct
          ? 'Preview current · direct source · video track muted'
          : this.preview.cached
            ? 'Preview current · cached locally'
            : 'Preview current · rendered locally'
      );
    } else if (data.type === 'playbackError') {
      const detail =
        typeof data.message === 'string'
          ? data.message.slice(0, 1000)
          : 'The local preview could not be loaded.';
      this.fail(new Error(`Preview playback failed: ${detail}. Use CUT: Render Preview to try again.`));
    } else if (data.type === 'proxyFallback') await this.previewAt(this.position, false, true);
    else if (data.type === 'render') await this.previewCommand();
    else if (data.type === 'export') await this.exportMovie();
    else if (data.type === 'toggle') {
      await this.openMonitor(true);
      void this.monitor?.webview.postMessage({ type: 'toggle' });
    } else if (data.type === 'problems')
      void vscode.commands.executeCommand('workbench.actions.view.problems');
  }

  private async showTimeline(): Promise<Timeline | undefined> {
    if (!this.ensureDocument()) return;
    await vscode.commands.executeCommand('cut.timelineView.focus');
    this.publish();
    return this.timeline;
  }
  private async checkCommand(): Promise<CompileResult | undefined> {
    if (!this.ensureDocument()) return;
    const result = await this.compileDocument();
    if (!result) return;
    this.output.clear();
    this.output.appendLine(`CUT · ${this.doc!.uri.fsPath}`);
    for (const item of result.diagnostics)
      this.output.appendLine(
        `${item.severity.toUpperCase()} ${item.range.start.line + 1}:${item.range.start.column + 1} [${item.code}] ${item.message}`
      );
    this.output.appendLine(
      result.timeline
        ? `Valid film · ${formatTime(result.timeline.duration)} · ${result.timeline.tracks.length} tracks`
        : 'Film could not be compiled.'
    );
    this.output.show(true);
    return result;
  }
  private async previewCommand(): Promise<void> {
    if (!this.ensureDocument()) return;
    await this.openMonitor();
    if (!this.timeline) await this.compileDocument();
    if (this.timeline) await this.previewAt(this.position, false, true);
  }

  private async chooseRenderRange(timeline: Timeline): Promise<{ from: Tick; to?: Tick } | undefined> {
    const inputBoundary = (end: boolean, from = 0) =>
      vscode.window.showInputBox({
        title: end ? 'Render section · End' : 'Render section · Start',
        prompt: end
          ? 'Enter the exclusive end time, or leave empty for the end of the film.'
          : 'Enter a time on the film timeline.',
        value: end ? '' : '0s',
        placeHolder: end ? formatTime(timeline.duration) : '10s',
        validateInput: (text) => {
          try {
            const boundary = end && !text.trim() ? undefined : parseTime(text, timeline.fps);
            renderRange(timeline, end ? { from, to: boundary } : { from: boundary });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
      });
    const start = await inputBoundary(false);
    if (start === undefined) return;
    const from = parseTime(start, timeline.fps);
    const end = await inputBoundary(true, from);
    if (end === undefined) return;
    return { from, to: end.trim() ? parseTime(end, timeline.fps) : undefined };
  }

  private async exportMovie(section = false): Promise<void> {
    if (!this.ensureDocument()) return;
    if (!vscode.workspace.isTrusted) {
      this.setState('untrusted', 'Trust this workspace before rendering local media.');
      return;
    }
    if (!this.timeline) await this.compileDocument();
    const timeline = this.timeline;
    if (!timeline || !this.doc) {
      void vscode.window.showErrorMessage('Fix the film’s source or media errors before exporting.');
      return;
    }
    const range = section ? await this.chooseRenderRange(timeline) : {};
    if (!range) return;
    const baseName = timeline.filePath.replace(/\.cut$/i, '');
    const output = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(baseName + (section ? '-section.mp4' : '.mp4')),
      filters: { 'MP4 video': ['mp4'] },
      saveLabel: 'Render MP4'
    });
    if (!output) return;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CUT · Rendering ${path.basename(output.fsPath)}`,
          cancellable: true
        },
        async (progress, token) => {
          const controller = new AbortController();
          const disposable = token.onCancellationRequested(() => controller.abort());
          let previous = 0;
          try {
            await render(timeline, {
              ...range,
              output: output.fsPath,
              signal: controller.signal,
              onProgress: (update) => {
                const percent = Math.round(update.fraction * 100);
                progress.report({ increment: Math.max(0, percent - previous), message: `${percent}%` });
                previous = percent;
              }
            });
          } finally {
            disposable.dispose();
          }
        }
      );
      const action = await vscode.window.showInformationMessage(
        `Rendered ${path.basename(output.fsPath)}`,
        'Show in Finder'
      );
      if (action) void vscode.commands.executeCommand('revealFileInOS', output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`CUT render: ${message}`);
    }
  }

  private async exportSequence(format: 'prproj' | 'drp' | 'xml'): Promise<void> {
    if (!this.ensureDocument() || !vscode.workspace.isTrusted) return;
    if (!this.timeline) await this.compileDocument();
    if (!this.timeline || !this.doc) return;
    const timeline = this.timeline;
    const title = format === 'drp' ? 'DaVinci Resolve project' : format === 'prproj' ? 'Premiere Pro project' : 'Final Cut Pro 7 XML';
    const output = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(timeline.filePath.replace(/\.cut$/i, '') + '.' + format),
      filters: { [title]: [format] }
    });
    if (!output) return;
    try {
      let warnings: string[];
      if (format === 'drp') {
        warnings = (await exportResolve(timeline, { output: output.fsPath })).warnings;
      } else if (format === 'prproj') {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Writing Premiere Pro project',
            cancellable: true
          },
          async (progress, token) => {
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() => controller.abort());
            try {
              return await exportPremiere(timeline, {
                output: output.fsPath,
                signal: controller.signal,
                onProgress: (step) => progress.report({ message: step.message })
              });
            } finally {
              subscription.dispose();
            }
          }
        );
        warnings = result.warnings;
      } else {
        const result = exportFcp7(timeline);
        await atomicWriteOutput(timeline, output.fsPath, result.xml);
        warnings = result.warnings;
      }
      this.output.appendLine(`Exported ${output.fsPath}`);
      for (const warning of warnings) this.output.appendLine(warning);
      if (warnings.length) this.output.show(true);
      const action = await vscode.window.showInformationMessage(
        `Exported ${path.basename(output.fsPath)}.`,
        'Show in Finder'
      );
      if (action) void vscode.commands.executeCommand('revealFileInOS', output);
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.compileController?.abort();
    this.renderController?.abort();
    this.monitor?.dispose();
    for (const disposable of this.assetWatchers) disposable.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
