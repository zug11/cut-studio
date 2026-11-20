import type { Rational, Tick } from './types';

/** Common multiple of 44,100, 48,000 and standard integer/NTSC frame numerators. */
export const TICKS_PER_SECOND = 35_280_000;
const TICKS = BigInt(TICKS_PER_SECOND);
const DEFAULT_FPS: Rational = { num: 24, den: 1 };

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Time is too large for the exact integer timeline.');
  }
  return Number(value);
}

/** Round once, using integer arithmetic. Exactly half a tick rounds away from zero. */
function rounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('A positive denominator is required.');
  if (numerator < 0n) return -rounded(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function checkedFps(fps: Rational): Rational {
  if (!Number.isSafeInteger(fps.num) || !Number.isSafeInteger(fps.den) || fps.num <= 0 || fps.den <= 0) {
    throw new Error('Frame rate must be a positive integer or rational, such as 24 or 24000/1001.');
  }
  return fps;
}

function decimalRatio(text: string): [bigint, bigint] {
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid decimal time “${text}”.`);
  const [whole, fraction = ''] = text.split('.');
  const den = 10n ** BigInt(fraction.length);
  return [BigInt(whole) * den + BigInt(fraction || '0'), den];
}

function decimalTicks(text: string, multiplier = 1n): Tick {
  const [num, den] = decimalRatio(text);
  return safe(rounded(num * multiplier * TICKS, den));
}

export function secondsToTicks(seconds: number): Tick {
  if (!Number.isFinite(seconds)) throw new Error('Time must be finite.');
  // Number inputs are only for external media metadata/UI positions. Source times use decimalRatio.
  const result = Math.round(seconds * TICKS_PER_SECOND);
  if (!Number.isSafeInteger(result)) throw new Error('Time is too large for the exact integer timeline.');
  return result;
}

export function ticksToSeconds(ticks: Tick): number {
  if (!Number.isSafeInteger(ticks)) throw new Error('Time must contain exact integer ticks.');
  return ticks / TICKS_PER_SECOND;
}

export function frameToTicks(frame: number, fps: Rational = DEFAULT_FPS): Tick {
  checkedFps(fps);
  if (!Number.isSafeInteger(frame)) throw new Error('Frame number must be an integer.');
  return safe(rounded(BigInt(frame) * TICKS * BigInt(fps.den), BigInt(fps.num)));
}

export function ticksToFrame(ticks: Tick, fps: Rational = DEFAULT_FPS): number {
  checkedFps(fps);
  if (!Number.isSafeInteger(ticks)) throw new Error('Time must contain exact integer ticks.');
  return safe(rounded(BigInt(ticks) * BigInt(fps.num), TICKS * BigInt(fps.den)));
}

export function quantizeToFrame(ticks: Tick, fps: Rational = DEFAULT_FPS): Tick {
  return frameToTicks(ticksToFrame(ticks, fps), fps);
}

/** Number of output frames needed to include a final partial frame of audio. */
export function framesCovering(duration: Tick, fps: Rational): number {
  const nearest = ticksToFrame(duration, fps);
  return frameToTicks(nearest, fps) < duration ? nearest + 1 : nearest;
}

/** The editor can seek to any displayed frame, including a fractional audio tail. */
export function playablePosition(position: Tick, duration: Tick, fps: Rational): Tick {
  const last = Math.max(0, framesCovering(duration, fps) - 1);
  return frameToTicks(Math.max(0, Math.min(last, ticksToFrame(position, fps))), fps);
}

/** Construct adjacent proxy windows on the same frame grid, including at NTSC rates. */
export function previewWindow(position: Tick, duration: Tick, fps: Rational, segmentLength: Tick) {
  const framesPerSegment = Math.max(1, ticksToFrame(segmentLength, fps));
  const frame = ticksToFrame(playablePosition(position, duration, fps), fps);
  const first = Math.floor(frame / framesPerSegment) * framesPerSegment;
  const end = Math.min(first + framesPerSegment, framesCovering(duration, fps));
  return { from: frameToTicks(first, fps), to: frameToTicks(end, fps) };
}

/** Parses exact decimal seconds, h/m/s durations, clock times, frame counts and non-drop framecodes. */
export function parseTime(input: string, fps: Rational = DEFAULT_FPS): Tick {
  checkedFps(fps);
  const text = input.trim();
  if (text.includes(';'))
    throw new Error(
      'Drop-frame timecode is not supported. Use non-drop HH:MM:SS:FF or an exact duration in seconds.'
    );
  if (text.startsWith('-')) throw new Error('Time cannot be negative.');
  if (/^\d+f$/.test(text)) return frameToTicks(Number(text.slice(0, -1)), fps);
  const framecode = /^(\d+):(\d{2}):(\d{2}):(\d{2,3})$/.exec(text);
  if (framecode) {
    const [, hh, mm, ss, ff] = framecode;
    const nominal = Math.round(fps.num / fps.den);
    if (Number(mm) >= 60 || Number(ss) >= 60 || Number(ff) >= nominal) {
      throw new Error(
        `Invalid framecode “${text}”: minutes/seconds must be below 60 and frames below ${nominal}.`
      );
    }
    const frames = (BigInt(hh) * 3600n + BigInt(mm) * 60n + BigInt(ss)) * BigInt(nominal) + BigInt(ff);
    return frameToTicks(safe(frames), fps);
  }
  const clock = /^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (clock) {
    const [, hh = '0', mm, ss] = clock;
    if (Number(mm) >= 60 || Number(ss) >= 60)
      throw new Error(`Invalid clock time “${text}”: minutes and seconds must be below 60.`);
    return safe(BigInt(decimalTicks(hh, 3600n)) + BigInt(decimalTicks(mm, 60n)) + BigInt(decimalTicks(ss)));
  }
  // Only the last unit may be fractional. This keeps values such as 1.5m30s unambiguous.
  const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (duration && duration.slice(1).some((value) => value !== undefined)) {
    const [, hours = '0', minutes = '0', seconds = '0'] = duration;
    return safe(
      BigInt(decimalTicks(hours, 3600n)) + BigInt(decimalTicks(minutes, 60n)) + BigInt(decimalTicks(seconds))
    );
  }
  throw new Error(`Invalid time “${text}”. Use 52s, 1m00.052s, 00:01:00.052, HH:MM:SS:FF, or 120f.`);
}

export function formatTime(ticks: Tick, fps?: Rational): string {
  if (!Number.isSafeInteger(ticks)) throw new Error('Time must contain exact integer ticks.');
  const sign = ticks < 0 ? '-' : '';
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  if (fps) {
    checkedFps(fps);
    const frame = Math.abs(ticksToFrame(ticks, fps));
    const nominal = Math.round(fps.num / fps.den);
    const wholeSeconds = Math.floor(frame / nominal);
    return `${sign}${pad(Math.floor(wholeSeconds / 3600))}:${pad(Math.floor(wholeSeconds / 60) % 60)}:${pad(wholeSeconds % 60)}:${pad(frame % nominal)}`;
  }
  const ms = safe(rounded(BigInt(Math.abs(ticks)) * 1000n, TICKS));
  const seconds = Math.floor(ms / 1000);
  return `${sign}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${pad(ms % 1000, 3)}`;
}
