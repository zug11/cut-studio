import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_SECOND,
  formatTime,
  frameToTicks,
  parseTime,
  playablePosition,
  previewWindow,
  quantizeToFrame,
  secondsToTicks,
  ticksToFrame,
  ticksToSeconds
} from '../src/core/time';

describe('exact CUT timing', () => {
  it('parses human durations and clock timestamps to identical integer ticks', () => {
    expect(parseTime('1m00.052s')).toBe(parseTime('00:01:00.052'));
    expect(parseTime('01:00.052')).toBe(parseTime('60.052s'));
    expect(parseTime('52s')).toBe(52 * TICKS_PER_SECOND);
    expect(parseTime('1h2m3.5s')).toBe(3723.5 * TICKS_PER_SECOND);
    expect(parseTime('1m')).toBe(60 * TICKS_PER_SECOND);
    expect(parseTime('0s')).toBe(0);
  });
  it('avoids accumulated decimal timing drift', () => {
    expect(parseTime('0.1s') + parseTime('0.2s')).toBe(parseTime('0.3s'));
    expect(parseTime('0.000001s')).toBe(35);
    expect(parseTime('123456.123456789s')).toBe(4_355_532_035_556);
    expect(Number.isSafeInteger(parseTime('100000000s'))).toBe(true);
  });
  it('represents standard audio samples exactly', () => {
    expect(TICKS_PER_SECOND / 48000).toBe(735);
    expect(TICKS_PER_SECOND / 44100).toBe(800);
  });
  it('uses rational frame arithmetic over long durations', () => {
    const fps = { num: 24000, den: 1001 };
    expect(frameToTicks(1, fps)).toBe(1_471_470);
    expect(frameToTicks(100000, fps)).toBe(147_147_000_000);
    expect(ticksToFrame(frameToTicks(100000, fps), fps)).toBe(100000);
    expect(parseTime('100000f', fps)).toBe(frameToTicks(100000, fps));
    expect(parseTime('00:01:00:00', fps)).toBe(frameToTicks(1440, fps));
  });
  it('rounds frame boundaries half up, once', () => {
    expect(quantizeToFrame(parseTime('0.02s'), { num: 25, den: 1 })).toBe(parseTime('0.04s'));
    expect(quantizeToFrame(parseTime('0.019s'), { num: 25, den: 1 })).toBe(0);
    expect(quantizeToFrame(parseTime('60.052s'), { num: 24, den: 1 })).toBe(frameToTicks(1441));
  });
  it('advances to the next proxy at every boundary of a fractional-rate film', () => {
    const fps = { num: 24000, den: 1001 };
    const duration = secondsToTicks(185);
    const segmentLength = secondsToTicks(8);
    let cursor = 0;
    for (let i = 0; i < 24; i++) {
      const range = previewWindow(cursor, duration, fps, segmentLength);
      expect(range.from).toBe(cursor);
      expect(range.to).toBeGreaterThan(cursor);
      cursor = range.to;
    }
    expect(cursor).toBeGreaterThanOrEqual(duration);
  });

  it('can seek into a final audio tail shorter than half of one video frame', () => {
    const fps = { num: 24, den: 1 };
    const duration = parseTime('8.005s');
    expect(playablePosition(duration, duration, fps)).toBe(parseTime('8s'));
    expect(previewWindow(duration, duration, fps, parseTime('8s'))).toEqual({
      from: parseTime('8s'),
      to: frameToTicks(193, fps)
    });
  });
  it('formats clock and non-drop frame timecodes', () => {
    expect(formatTime(parseTime('1m00.052s'))).toBe('00:01:00.052');
    expect(formatTime(parseTime('25f'), { num: 24, den: 1 })).toBe('00:00:01:01');
    expect(formatTime(parseTime('0.9999s'))).toBe('00:00:01.000');
    expect(ticksToSeconds(secondsToTicks(4.2))).toBe(4.2);
  });
  it.each(['', '52', '1.5m', '-1s', '1:61:00', '00:00:00:24', '00:00:00;00', 'NaNs', '2ss', '1m2s3m'])(
    'rejects malformed time %j',
    (text) => {
      expect(() => parseTime(text)).toThrow();
    }
  );
  it('rejects values outside exact numeric range and bad rational frame rates', () => {
    expect(() => parseTime('9999999999999999999s')).toThrow('too large');
    expect(() => parseTime('1f', { num: 24, den: 0 })).toThrow('positive');
    expect(() => ticksToFrame(0.5)).toThrow('integer');
  });
});
