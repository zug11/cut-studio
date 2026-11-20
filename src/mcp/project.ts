import { link, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compile } from '../core/compiler';
import { premierePlan } from '../core/premiere-plan';
import { audition, contactSheet, reviewFilm } from '../project/review';
import { searchDialogue } from '../project/dialogue';
import {
  batchSourceChange,
  namedTimingChanges,
  proposeEdit,
  type EditOperation
} from '../project/edits';
import { parseCut } from '../core/parser';
import { parseTime, TICKS_PER_SECOND } from '../core/time';
import type { CompileResult, Diagnostic, RenderProgress } from '../core/types';
import { assertNotAborted } from '../engine/process';
import { assertSafeOutput, render } from '../engine';
import { exportResolve } from '../exporters/resolve';
import { exportPremiere } from '../exporters/premiere';
import { exportFcp7 } from '../exporters/fcp7';
import {
  CONFINED_MEDIA_FORMATS,
  ProjectAccessError,
  ProjectPaths
} from '../project/paths';
import { readDocument, saveDocument } from '../project/documents';

export class EditStepError extends Error {
  readonly code = 'INVALID_EDIT_STEP';
  constructor(
    readonly index: number,
    readonly operation: EditOperation['op'],
    message: string,
    readonly diagnostics?: Diagnostic[]
  ) {
    super('Edit ' + (index + 1) + ' (' + operation + '): ' + message);
  }
}

export interface DocumentRequest {
  sceneSources?: Record<string, string>;
  file: string;
  source?: string;
  signal?: AbortSignal;
}
export interface SaveRequest {
  file: string;
  source: string;
  expectedRevision?: string;
  create?: boolean;
  signal?: AbortSignal;
}
export interface ExportRequest extends DocumentRequest {
  output: string;
  format?: 'prproj' | 'drp' | 'mp4' | 'xml';
  from?: string;
  to?: string;
  onProgress?: (progress: {
    fraction: number;
    message?: string;
    seconds?: number;
  }) => void;
}
export class ProjectSession {
  private paths?: ProjectPaths;
  constructor(private readonly directory: string) {}
  async initialize(): Promise<this> {
    this.paths = await ProjectPaths.open(this.directory);
    return this;
  }
  get root(): string {
    return this.access.root;
  }
  private get access(): ProjectPaths {
    if (!this.paths) throw new Error('Initialize the project session first.');
    return this.paths;
  }
  listFiles(options: { signal?: AbortSignal } = {}) {
    return this.access.listFiles(options);
  }
  async readSource(options: { path: string; signal?: AbortSignal }): Promise<{
    file: string;
    source: string;
    revision: string;
    mtime: number;
  }> {
    assertNotAborted(options.signal);
    const file = await this.access.cut(options.path);
    const result = await readDocument(file);
    if (Buffer.byteLength(result.source, 'utf8') > 2 * 1024 * 1024)
      throw new ProjectAccessError(
        413,
        'SOURCE_TOO_LARGE',
        'CUT source is limited to 2 MB.'
      );
    assertNotAborted(options.signal);
    return {
      file: this.access.relative(file),
      source: result.source,
      revision: result.revision,
      mtime: result.mtime
    };
  }
  private async compileDocument(
    options: DocumentRequest
  ): Promise<CompileResult & { file: string; revision?: string }> {
    assertNotAborted(options.signal);
    const file = await this.access.cut(
      options.file,
      options.source !== undefined
    );
    const document =
      options.source === undefined
        ? await readDocument(file)
        : { source: options.source, revision: undefined };
    await this.access.validateAssets(
      document.source,
      file,
      options.signal,
      'confined'
    );
    const drafts = new Map<string, string>();
    for (const [relative, text] of Object.entries(options.sceneSources || {})) {
      const canonical = await this.access.cut(relative, true);
      if (canonical === file)
        throw new ProjectAccessError(
          400,
          'AMBIGUOUS_DRAFT',
          'Use source for the root film and sceneSources for child films.'
        );
      if (drafts.has(canonical))
        throw new ProjectAccessError(
          400,
          'AMBIGUOUS_DRAFT',
          'Two draft paths refer to the same scene.'
        );
      drafts.set(canonical, text);
    }
    const result = await compile(document.source, file, {
      readScene: this.access.sceneReader(options.signal, 'confined', drafts),
      signal: options.signal,
      formatWhitelist: CONFINED_MEDIA_FORMATS
    });
    return {
      file: this.access.relative(file),
      revision: document.revision,
      ...result
    };
  }
  async check(options: DocumentRequest): Promise<{
    file: string;
    revision?: string;
    valid: boolean;
    diagnostics: Diagnostic[];
  }> {
    const result = await this.compileDocument(options);
    return {
      file: result.file,
      revision: result.revision,
      valid: !!result.timeline,
      diagnostics: result.diagnostics
    };
  }
  timeline(options: DocumentRequest) {
    return this.compileDocument(options);
  }
  async save(options: SaveRequest): Promise<{
    file: string;
    revision: string;
    mtime: number;
    diagnostics: Diagnostic[];
  }> {
    assertNotAborted(options.signal);
    if (typeof options.source !== 'string')
      throw new ProjectAccessError(
        400,
        'SOURCE_REQUIRED',
        'Provide the complete CUT source text.'
      );
    if (options.create && options.expectedRevision !== undefined)
      throw new ProjectAccessError(
        400,
        'INVALID_REVISION',
        'Use create:true for a new file, or expectedRevision for an existing file.'
      );
    if (
      !options.create &&
      (typeof options.expectedRevision !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(options.expectedRevision))
    )
      throw new ProjectAccessError(
        409,
        'REVISION_REQUIRED',
        'Read the document first and supply its exact revision before saving an existing file.'
      );
    const file = await this.access.cut(options.file, !!options.create);
    await this.access.validateAssets(
      options.source,
      file,
      options.signal,
      'confined'
    );
    const result = await saveDocument(
      file,
      options.source,
      options.create
        ? { create: true }
        : { revision: options.expectedRevision! },
      options.signal
    );
    return {
      file: this.access.relative(file),
      ...result,
      diagnostics: parseCut(options.source).diagnostics
    };
  }
  private async validFilm(options: DocumentRequest) {
    const { timeline, diagnostics } = await this.compileDocument(options);
    if (!timeline)
      throw new Error(
        diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => d.message)
          .join(' ') || 'Check the film first.'
      );
    return timeline;
  }
  async review(options: DocumentRequest & { cue?: string; seconds?: number }) {
    return reviewFilm(
      this.access,
      await this.validFilm(options),
      options.cue,
      options.seconds,
      options.signal
    );
  }
  sheet(file: string, count?: number, signal?: AbortSignal) {
    return contactSheet(this.access, file, count, signal);
  }
  audition(
    file: string,
    from?: number,
    seconds?: number,
    signal?: AbortSignal
  ) {
    return audition(this.access, file, from, seconds, signal);
  }
  dialogue(query: string, file?: string, index = false, signal?: AbortSignal) {
    return searchDialogue(this.access, query, file, index, signal);
  }
  async exportPlan(options: DocumentRequest) {
    return premierePlan(await this.validFilm(options));
  }
  async edit(
    options: DocumentRequest & {
      operation?: EditOperation;
      operations?: EditOperation[];
      apply?: boolean;
      expectedRevision?: string;
    }
  ) {
    const { operation, operations, signal } = options;
    const steps = operation ? [operation] : operations;
    if ((operation && operations) || !steps?.length || steps.length > 64)
      throw new ProjectAccessError(
        400,
        'INVALID_EDIT',
        'Supply either operation or a list of 1–64 operations.'
      );
    const disk =
      options.source === undefined || options.apply
        ? await this.readSource({ path: options.file, signal })
        : undefined;
    if (
      options.apply &&
      (!options.expectedRevision || disk?.revision !== options.expectedRevision)
    )
      throw new ProjectAccessError(
        409,
        'REVISION_CONFLICT',
        'Read the latest source before applying the edit.'
      );
    const source = options.source ?? disk!.source;
    let candidate = source,
      compiled = await this.compileDocument({ ...options, source });
    const original = compiled.timeline;
    let changes: ReturnType<typeof proposeEdit>['changes'] = [];
    for (const [index, step] of steps.entries()) {
      assertNotAborted(signal);
      try {
        if (
          !compiled.film ||
          parseCut(candidate).diagnostics.some((d) => d.severity === 'error')
        )
          throw new EditStepError(
            index,
            step.op,
            'Fix CUT syntax before using clip edits.',
            compiled.diagnostics
          );
        const proposed = proposeEdit(
          candidate,
          compiled.film,
          compiled.timeline,
          step,
          options.file
        );
        candidate = proposed.source;
        changes = proposed.changes;
        compiled = await this.compileDocument({
          ...options,
          source: candidate
        });
        if (!compiled.timeline && index === steps.length - 1) {
          const diagnostics = compiled.diagnostics.filter(
            (d) => d.severity === 'error'
          );
          throw new EditStepError(
            index,
            step.op,
            diagnostics.map((d) => d.message).join(' ') ||
              'The resulting film is invalid.',
            diagnostics
          );
        }
      } catch (e) {
        if (
          e instanceof ProjectAccessError ||
          e instanceof EditStepError ||
          signal?.aborted
        )
          throw e;
        throw new EditStepError(
          index,
          step.op,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    const timeline = compiled.timeline!;
    const saved = options.apply
      ? await this.save({
          file: options.file,
          source: candidate,
          expectedRevision: options.expectedRevision,
          signal
        })
      : undefined;
    return {
      file: options.file,
      source: candidate,
      changes:
        steps.length === 1 ? changes : batchSourceChange(source, candidate),
      applied: !!saved,
      steps: steps.length,
      baseRevision: disk?.revision,
      revision: saved?.revision ?? disk?.revision,
      timebase: { ticksPerSecond: TICKS_PER_SECOND, fps: timeline.fps },
      duration: timeline.duration,
      namedTimingChanges: namedTimingChanges(original, timeline),
      ...(saved
        ? {
            undo: {
              file: options.file,
              source: disk!.source,
              expectedRevision: saved.revision
            }
          }
        : {})
    };
  }
  async export(options: ExportRequest): Promise<{
    path: string;
    absolutePath: string;
    format: 'prproj' | 'drp' | 'mp4' | 'xml';
    warnings: string[];
  }> {
    const compiled = await this.compileDocument(options);
    if (!compiled.timeline)
      throw new ProjectAccessError(
        422,
        'INVALID_FILM',
        `Fix CUT diagnostics before exporting: ${compiled.diagnostics
          .filter((item) => item.severity === 'error')
          .map((item) => item.message)
          .join(' ')}`
      );
    const extension = path.extname(options.output).slice(1).toLowerCase(),
      format = options.format || extension;
    if (!['prproj', 'drp', 'mp4', 'xml'].includes(format) || extension !== format)
      throw new ProjectAccessError(
        400,
        'INVALID_OUTPUT',
        'Choose a matching .drp, .prproj, .mp4 or .xml filename.'
      );
    if (
      format !== 'mp4' &&
      (options.from !== undefined || options.to !== undefined)
    )
      throw new ProjectAccessError(
        400,
        'INVALID_RANGE',
        'Selected ranges are available for MP4 exports. Omit from/to for editable project exports.'
      );
    let target = await this.access.resolve(options.output, true);
    try {
      await lstat(target);
      throw new ProjectAccessError(
        409,
        'OUTPUT_EXISTS',
        'The export destination already exists. Choose a new filename; MCP exports never overwrite files.'
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await assertSafeOutput(compiled.timeline, target);
    await mkdir(path.dirname(target), { recursive: true });
    target = await this.access.resolve(options.output, true);
    const temporary = path.join(
        path.dirname(target),
        `.cut-export-${randomUUID()}.${format}`
      ),
      warnings: string[] = [];
    let mediaDirectory: string | undefined,
      published = false;
    try {
      assertNotAborted(options.signal);
      if (format === 'prproj') {
        const result = await exportPremiere(compiled.timeline, {
          output: temporary,
          formatWhitelist: CONFINED_MEDIA_FORMATS,
          signal: options.signal,
          onProgress: options.onProgress
        });
        mediaDirectory = result.mediaDirectory;
        warnings.push(...result.warnings);
      } else if (format === 'drp') {
        const result = await exportResolve(compiled.timeline, {
          output: temporary, signal: options.signal, formatWhitelist: CONFINED_MEDIA_FORMATS
        });
        mediaDirectory = result.mediaDirectory;
        warnings.push(...result.warnings);
      } else if (format === 'xml') {
        const result = exportFcp7(compiled.timeline);
        await writeFile(temporary, result.xml, { flag: 'wx' });
        warnings.push(...result.warnings);
      } else {
        const from =
            options.from === undefined
              ? undefined
              : parseTime(options.from, compiled.timeline.fps),
          to =
            options.to === undefined
              ? undefined
              : parseTime(options.to, compiled.timeline.fps);
        await render(compiled.timeline, {
          output: temporary,
          from,
          to,
          signal: options.signal,
          onProgress: options.onProgress,
          formatWhitelist: CONFINED_MEDIA_FORMATS
        });
      }
      assertNotAborted(options.signal);
      await assertSafeOutput(compiled.timeline, target);
      // link is atomic and exclusive: a concurrent export can never replace an existing destination.
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ProjectAccessError(
            409,
            'OUTPUT_EXISTS',
            'Another export created this destination. Choose a new filename.'
          );
        throw error;
      }
      published = true;
      return {
        path: this.access.relative(target),
        absolutePath: target,
        format: format as 'prproj' | 'drp' | 'mp4' | 'xml',
        warnings
      };
    } finally {
      if (!published && mediaDirectory)
        await rm(mediaDirectory, { recursive: true, force: true });
      await rm(temporary, { force: true });
    }
  }
  close(): void {
    /* Sessions own no process or socket; the transport owns request cancellation. */
  }
}
