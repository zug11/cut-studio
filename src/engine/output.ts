import { constants } from 'node:fs';
import { copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Timeline } from '../core/types';

async function canonicalPath(file: string): Promise<string> {
  const destination = path.resolve(file);
  let ancestor = destination;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      return path.join(actual, path.relative(ancestor, destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
async function identity(file: string) {
  try {
    return await stat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
const key = (file: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file;

/** Protect source files by name, canonical path and filesystem identity (hard links). */
export async function assertSafeOutput(timeline: Timeline, output: string): Promise<string> {
  const target = path.resolve(output),
    canonicalTarget = await canonicalPath(target),
    targetInfo = await identity(target);
  const protectedPaths = new Set([
    timeline.filePath, ...(timeline.dependencies || []),
    ...timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.absolutePath))
  ]);
  for (const protectedPath of protectedPaths) {
    const original = path.resolve(protectedPath),
      canonical = await canonicalPath(original);
    const sourceInfo = targetInfo ? await identity(original) : undefined;
    const sameIdentity =
      targetInfo &&
      sourceInfo &&
      targetInfo.ino !== 0n &&
      targetInfo.dev === sourceInfo.dev &&
      targetInfo.ino === sourceInfo.ino;
    if (key(target) === key(original) || key(canonicalTarget) === key(canonical) || sameIdentity)
      throw new Error(
        'Output must not overwrite the CUT document or a source asset, including symbolic links and hard links. Choose another output file.'
      );
  }
  return target;
}
async function atomicOutput(
  timeline: Timeline,
  output: string,
  write: (temporary: string) => Promise<unknown>
): Promise<string> {
  const target = await assertSafeOutput(timeline, output);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.partial`);
  try {
    await write(temporary);
    await assertSafeOutput(timeline, target);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
/** XML and other small exports use the same source protection as rendered movies. */
export function atomicWriteOutput(
  timeline: Timeline,
  output: string,
  contents: string | Uint8Array
): Promise<string> {
  return atomicOutput(timeline, output, (temporary) => writeFile(temporary, contents, { flag: 'wx' }));
}
/** Copy preview exports to a new inode, then atomically replace the requested destination. */
export function atomicCopyOutput(timeline: Timeline, source: string, output: string): Promise<string> {
  return atomicOutput(timeline, output, (temporary) => copyFile(source, temporary, constants.COPYFILE_EXCL));
}
