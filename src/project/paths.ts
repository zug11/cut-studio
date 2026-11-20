import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readDocument } from './documents';
import { parseCut } from '../core/parser';
import { assertNotAborted } from '../engine/process';

export class ProjectAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}
export interface ProjectFile {
  path: string;
  name: string;
  kind: 'cut' | 'video' | 'audio';
}
const videoExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.webp',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.mxf',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts'
]);
const audioExtensions = new Set([
  '.wav',
  '.wave',
  '.mp3',
  '.flac',
  '.aac',
  '.m4a',
  '.aif',
  '.aiff',
  '.ogg',
  '.opus',
  '.wma'
]);
export const CONFINED_MEDIA_FORMATS =
  'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac,aiff,mxf,mpeg,mpegvideo,mpegts,mpegtsraw,asf,image2,png_pipe,jpeg_pipe,webp_pipe';
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
export function projectFileKind(file: string): ProjectFile['kind'] | undefined {
  const extension = path.extname(file).toLowerCase();
  return extension === '.cut'
    ? 'cut'
    : videoExtensions.has(extension)
      ? 'video'
      : audioExtensions.has(extension)
        ? 'audio'
        : undefined;
}
/** Shared project confinement for the browser server and the project-scoped MCP tools. */
export class ProjectPaths {
  private constructor(readonly root: string) {}
  static async open(directory: string): Promise<ProjectPaths> {
    const root = await realpath(path.resolve(directory));
    if (!(await stat(root)).isDirectory())
      throw new ProjectAccessError(
        400,
        'INVALID_PROJECT',
        'Choose an existing local project folder.'
      );
    return new ProjectPaths(root);
  }
  relative(file: string): string {
    if (!inside(this.root, file))
      throw new ProjectAccessError(
        403,
        'OUTSIDE_PROJECT',
        'Path is outside the open project folder.'
      );
    return path.relative(this.root, file).split(path.sep).join('/');
  }
  /** Return a canonical path, including the existing parent of a new file. */
  async resolve(relative: string, allowNew = false): Promise<string> {
    if (
      typeof relative !== 'string' ||
      !relative ||
      relative.includes('\0') ||
      relative.includes('\\') ||
      path.isAbsolute(relative) ||
      /^[a-z]:/i.test(relative)
    )
      throw new ProjectAccessError(
        403,
        'INVALID_PATH',
        'Use a relative path inside the open project folder.'
      );
    const destination = path.resolve(this.root, relative);
    if (!inside(this.root, destination))
      throw new ProjectAccessError(
        403,
        'OUTSIDE_PROJECT',
        'Path is outside the open project folder.'
      );
    try {
      const actual = await realpath(destination);
      if (!inside(this.root, actual))
        throw new ProjectAccessError(
          403,
          'SYMLINK_ESCAPE',
          'Symbolic links may not leave the open project folder.'
        );
      return actual;
    } catch (error) {
      if (error instanceof ProjectAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is an existing directory entry, never a new file.
      try {
        if ((await lstat(destination)).isSymbolicLink())
          throw new ProjectAccessError(
            403,
            'DANGLING_LINK',
            'The destination is a dangling symbolic link. Choose a regular project file.'
          );
      } catch (linkError) {
        if (linkError instanceof ProjectAccessError) throw linkError;
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT')
          throw linkError;
      }
      if (!allowNew)
        throw new ProjectAccessError(
          404,
          'NOT_FOUND',
          `File not found: ${relative}`
        );
      let ancestor = path.dirname(destination);
      while (true) {
        try {
          const actual = await realpath(ancestor);
          if (!inside(this.root, actual))
            throw new ProjectAccessError(
              403,
              'SYMLINK_ESCAPE',
              'Symbolic links may not leave the open project folder.'
            );
          return path.join(actual, path.relative(ancestor, destination));
        } catch (parentError) {
          if (parentError instanceof ProjectAccessError) throw parentError;
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT')
            throw parentError;
          const parent = path.dirname(ancestor);
          if (parent === ancestor)
            throw new ProjectAccessError(
              403,
              'OUTSIDE_PROJECT',
              'Path is outside the open project folder.'
            );
          ancestor = parent;
        }
      }
    }
  }
  async cut(relative: string, allowNew = false): Promise<string> {
    if (!/\.cut$/i.test(relative))
      throw new ProjectAccessError(
        400,
        'CUT_REQUIRED',
        'Choose a .cut document.'
      );
    const actual = await this.resolve(relative, allowNew);
    if (!/\.cut$/i.test(actual))
      throw new ProjectAccessError(
        403,
        'WRONG_LINK_TYPE',
        'CUT document links must point to another .cut document.'
      );
    return actual;
  }
  sceneReader(signal?: AbortSignal, policy: 'confined'|'local' = 'local', drafts?:ReadonlyMap<string,string>) {
    return async (absolute: string) => {
      const file = await this.cut(this.relative(absolute), !!drafts?.size);
      const source=drafts?.get(file) ?? (await readDocument(file)).source;
      await this.validateAssets(source, file, signal, policy);
      return {file,source};
    };
  }
  async validateAssets(
    source: string,
    file: string,
    signal?: AbortSignal,
    policy: 'confined' | 'local' = 'local'
  ): Promise<void> {
    if (Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024)
      throw new ProjectAccessError(
        413,
        'SOURCE_TOO_LARGE',
        'CUT source is limited to 2 MB.'
      );
    const film = parseCut(source).film;
    if (!film) return;
    for (const scene of film.scenes || []) {
      assertNotAborted(signal);
      await this.cut(this.relative(path.resolve(path.dirname(file), scene.path)), true);
    }
    for (const track of film.tracks)
      for (const clip of track.clips) {
        assertNotAborted(signal);
        if (clip.element === 'title' || clip.element === 'caption') continue;
        const absolute = path.resolve(path.dirname(file), clip.path);
        if (!inside(this.root, absolute))
          throw new ProjectAccessError(
            403,
            'OUTSIDE_PROJECT',
            `Media must be inside this project: ${clip.path}`
          );
        if (
          policy === 'confined' &&
          (!projectFileKind(clip.path) || projectFileKind(clip.path) === 'cut')
        )
          throw new ProjectAccessError(
            400,
            'UNSUPPORTED_MEDIA',
            `Use a regular video or audio media file for “${clip.path}”. Playlists, manifests and arbitrary file types are not accepted.`
          );
        // The nearest existing parent must also be confined when a reference is missing.
        const actual = await this.resolve(this.relative(absolute), true);
        if (
          policy === 'confined' &&
          (!projectFileKind(actual) || projectFileKind(actual) === 'cut')
        )
          throw new ProjectAccessError(
            400,
            'UNSUPPORTED_MEDIA',
            `Media links must point to a regular supported video or audio file: ${clip.path}`
          );
      }
  }
  async listFiles(
    options: { signal?: AbortSignal; limit?: number } = {}
  ): Promise<{ root: string; files: ProjectFile[]; truncated: boolean }> {
    const limit = Math.max(1, Math.min(10000, options.limit || 2000)),
      files: ProjectFile[] = [];
    let truncated = false,
      visited = 0,
      scanned = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      assertNotAborted(options.signal);
      if (depth > 32 || ++visited > 4000) {
        truncated = true;
        return;
      }
      const entries = [];
      let handle;
      try {
        handle = await opendir(directory);
      } catch (error) {
        if (
          ['ENOENT', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code || ''
          )
        ) {
          truncated = true;
          return;
        }
        throw error;
      }
      for await (const entry of handle) {
        assertNotAborted(options.signal);
        if (++scanned > 30000 || entries.length >= 4000) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        if (
          entry.name.startsWith('.') ||
          [
            'node_modules',
            'dist',
            'target',
            'coverage',
            '__pycache__',
            'venv'
          ].includes(entry.name)
        )
          continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile()) {
          const kind = projectFileKind(entry.name);
          if (kind)
            files.push({ path: this.relative(file), name: entry.name, kind });
        }
        // Do not walk symbolic links: their contents may escape or create directory cycles.
      }
    };
    await visit(this.root, 0);
    return { root: this.root, files, truncated };
  }
}
