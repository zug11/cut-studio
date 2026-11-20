import { spawn } from 'node:child_process';

export interface ToolPaths {
  ffmpegPath?: string;
  ffprobePath?: string;
}
let toolPaths: ToolPaths = {};
export function configureTools(paths: ToolPaths): void {
  toolPaths = { ...paths };
}
export function toolPath(tool: 'ffmpeg' | 'ffprobe'): string {
  return (
    (tool === 'ffmpeg'
      ? toolPaths.ffmpegPath || process.env.CUT_FFMPEG
      : toolPaths.ffprobePath || process.env.CUT_FFPROBE) || tool
  );
}
export class CancelledError extends Error {
  constructor() {
    super('Rendering cancelled.');
    this.name = 'AbortError';
  }
}
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
export function runTool(
  tool: 'ffmpeg' | 'ffprobe',
  args: string[],
  options: { signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}
): Promise<{ stdout: string; stderr: string }> {
  assertNotAborted(options.signal);
  return new Promise((resolve, reject) => {
    const executable = toolPath(tool);
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '',
      stderr = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1200);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (buffer: Buffer) => {
      const chunk = buffer.toString();
      stdout = (stdout + chunk).slice(-1024 * 1024);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (buffer: Buffer) => {
      stderr = (stderr + buffer.toString()).slice(-1024 * 1024);
    });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT')
        reject(
          new Error(
            `${tool} was not found at “${executable}”. Install FFmpeg (which includes FFprobe): macOS: brew install ffmpeg; Windows: winget install Gyan.FFmpeg; Linux: sudo apt install ffmpeg. Restart VS Code, or set cut.${tool}Path / CUT_${tool.toUpperCase()} to the executable's full path.`
          )
        );
      else reject(new Error(`Could not start ${tool}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (options.signal?.aborted) reject(new CancelledError());
      else if (code !== 0)
        reject(new Error(`${tool} failed (${code ?? signal}): ${stderr.trim() || 'No diagnostic output.'}`));
      else resolve({ stdout, stderr });
    });
  });
}
export async function checkTools(): Promise<void> {
  await Promise.all([runTool('ffmpeg', ['-version']), runTool('ffprobe', ['-version'])]);
}
