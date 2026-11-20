import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lock } from 'proper-lockfile';

const maximumSourceBytes = 2 * 1024 * 1024;

export type DocumentVersion = { revision: string } | { mtime: number } | { create: true };

export class DocumentConflictError extends Error {
  constructor() {
    super(
      'This file changed on disk. Read the current version before saving, or save your edit as a new film.'
    );
  }
}

function contentRevision(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readDocument(file: string) {
  // Read metadata and text from the same inode even if another process replaces the file.
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Choose a regular CUT file.');
    if (info.size > maximumSourceBytes) throw new Error('A CUT document can contain up to 2 MB of source.');
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new DocumentConflictError();
    return {
      source: bytes.toString('utf8'),
      revision: contentRevision(bytes),
      mtime: info.mtimeMs,
      mode: info.mode
    };
  } finally {
    await handle.close();
  }
}

/** Both the Mac editor and every MCP process acquire the same lock before comparing and publishing. */
export async function saveDocument(
  file: string,
  source: string,
  expected: DocumentVersion,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (Buffer.byteLength(source) > maximumSourceBytes)
    throw new Error('A CUT document can contain up to 2 MB of source.');
  const folder = path.dirname(file);
  await mkdir(folder, { recursive: true });
  const release = await lock(file, {
    realpath: false,
    lockfilePath: path.join(folder, `.${path.basename(file)}.write-lock`),
    retries: { retries: 16, minTimeout: 20, maxTimeout: 120, randomize: true }
  });
  const temporary = path.join(folder, `.cut-${randomUUID()}.tmp`);
  try {
    signal?.throwIfAborted();
    let previous;
    try {
      previous = await readDocument(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const matches =
      'create' in expected
        ? !previous
        : 'revision' in expected
          ? previous?.revision === expected.revision
          : previous?.mtime === expected.mtime;
    if (!matches) throw new DocumentConflictError();

    await writeFile(temporary, source, { flag: 'wx', mode: previous?.mode ?? 0o644 });
    let info = await stat(temporary);
    // Existing editor clients can still use a timestamp as their revision.
    if (previous && previous.mtime === info.mtimeMs) {
      await utimes(temporary, info.atime, new Date(Math.ceil(previous.mtime) + 1));
      info = await stat(temporary);
    }
    signal?.throwIfAborted();
    if ('create' in expected) {
      try {
        await link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DocumentConflictError();
        throw error;
      }
    } else {
      await rename(temporary, file);
    }
    return { revision: contentRevision(source), mtime: info.mtimeMs };
  } finally {
    try {
      await rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}
