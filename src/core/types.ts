/** Exact integer ticks. 35,280,000 ticks/sec represents 44.1/48kHz samples and standard rational frame rates. */
export type Tick = number;
export interface Rational {
  num: number;
  den: number;
}
export interface Position {
  offset: number;
  line: number;
  column: number;
}
export interface SourceRange {
  start: Position;
  end: Position;
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  range: SourceRange;
}
export interface Clip {
  id: string;
  name?: string;
  link?: { target: string; edge: 'start' | 'end'; offset: Tick };
  element?: 'scene' | 'title' | 'caption';
  x?: number;
  y?: number;
  scale?: number;
  crop?: number[];
  duck?: { layer: number; db: number };
  path: string;
  in: Tick;
  out?: Tick;
  at: Tick;
  /** Optional source override; resolved clips always carry their effective 1-based layer. */
  layer?: number;
  opacity: number;
  gain: number;
  fadeIn: Tick;
  fadeOut: Tick;
  range: SourceRange;
  statements?: Partial<Record<keyof Clip['fields'], SourceRange>>;
  fields: Partial<
    Record<
      | 'path'
      | 'in'
      | 'out'
      | 'at'
      | 'layer'
      | 'opacity'
      | 'gain'
      | 'fadeIn'
      | 'fadeOut' | 'name' | 'x' | 'y' | 'scale' | 'crop' | 'duck',
      SourceRange
    >
  >;
}
export interface Track {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  /** Independent 1-based video/audio layer. Omission preserves declaration defaults. */
  layer?: number;
  clips: Clip[];
  range: SourceRange;
}
export interface Film {
  name: string;
  resolution: { width: number; height: number };
  fps: Rational;
  tracks: Track[];
  scenes?: Clip[];
  range: SourceRange;
}
export interface ParseResult {
  film?: Film;
  diagnostics: Diagnostic[];
}
export interface MediaInfo {
  path: string;
  duration: Tick;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: Rational;
  sampleRate?: number;
  channels?: number;
  /** Used for cache invalidation; never credentials or file contents. */
  fingerprint: string;
  still?: boolean;
}
export interface ResolvedClip extends Clip {
  out: Tick;
  duration: Tick;
  end: Tick;
  absolutePath: string;
  media: MediaInfo;
  originFile?: string;
  sceneId?: string;
  duckRanges?: { start: Tick; end: Tick }[];
}
export interface ResolvedTrack extends Omit<Track, 'clips'> {
  clips: ResolvedClip[];
}
export interface Timeline extends Omit<Film, 'tracks'> {
  tracks: ResolvedTrack[];
  duration: Tick;
  filePath: string;
  hash: string;
  dependencies?: string[];
}
export interface CompileResult {
  film?: Film;
  timeline?: Timeline;
  diagnostics: Diagnostic[];
}
export interface RenderProgress {
  seconds: number;
  fraction: number;
}
export interface RenderOptions {
  /** Optional input demuxer restriction for confined project integrations. */
  formatWhitelist?: string;
  /** Single transparent layer for an editable-project handoff. */
  alpha?: boolean;
  output: string;
  from?: Tick;
  to?: Tick;
  preview?: boolean;
  /** Final exports use MP4. Browser proxies may use WebM; restricted VS Code builds use H.264/MP3 MP4. */
  format?: 'mp4' | 'webm' | 'wav';
  /** AAC for final exports; MP3 is an audible H.264 preview fallback for restricted webviews. */
  audioCodec?: 'aac' | 'mp3';
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}
export interface PreviewResult {
  path: string;
  from: Tick;
  to: Tick;
  hash: string;
  cached: boolean;
  direct?: boolean;
  sourceIn?: Tick;
}
