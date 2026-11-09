import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../src/db.js';
import { DestinationSchema, ForwardDestinationSchema, parseDestination, parseIvrConfig, WeeklyScheduleSchema } from '../src/ivr-config.js';

const id = '00000000-0000-4000-8000-000000000030';

describe('Destinations (§3: extension, ring group, IVR menu, voicemail box, business hours, external number)', () => {
  it('accepts every destination type', () => {
    for (const d of [
      { type: 'extension', id },
      { type: 'ring_group', id },
      { type: 'ivr_menu', id },
      { type: 'voicemail', id },
      { type: 'business_hours', id },
      { type: 'external', number: '+12015550123' },
      { type: 'hangup' },
    ]) {
      expect(DestinationSchema.parse(d)).toEqual(d);
    }
  });
  it('external numbers must be E.164', () => {
    expect(() => DestinationSchema.parse({ type: 'external', number: '2015550123' })).toThrow();
  });
  it('forwarding targets are only an extension or an external number', () => {
    expect(ForwardDestinationSchema.safeParse({ type: 'extension', id }).success).toBe(true);
    expect(ForwardDestinationSchema.safeParse({ type: 'external', number: '+12015550123' }).success).toBe(true);
    expect(ForwardDestinationSchema.safeParse({ type: 'ring_group', id }).success).toBe(false);
  });
  it('reads the phase-1 {action, target} format', () => {
    expect(parseDestination({ action: 'ring_group', target: id })).toEqual({ type: 'ring_group', id });
    expect(parseDestination({ action: 'voicemail', target: id })).toEqual({ type: 'voicemail', id });
    expect(parseDestination({ action: 'user', target: id })).toEqual({ type: 'hangup' });
  });
});

describe('parseIvrConfig', () => {
  it('options, timeout, invalid, repeat digit', () => {
    const cfg = parseIvrConfig({
      options: { '1': { type: 'ring_group', id }, '#': { type: 'voicemail', id }, '9': { type: 'external', number: '+12015550123' } },
      timeout: { type: 'voicemail', id },
      invalid: { type: 'ivr_menu', id },
      repeat_digit: '*',
    });
    expect(cfg.options['1']).toEqual({ type: 'ring_group', id });
    expect(cfg.timeout).toEqual({ type: 'voicemail', id });
    expect(cfg.invalid).toEqual({ type: 'ivr_menu', id });
    expect(cfg.repeat_digit).toBe('*');
  });

  it('phase-1 shape: {action,target} options and on_timeout', () => {
    const cfg = parseIvrConfig({ options: { '1': { action: 'ring_group', target: id } }, on_timeout: { action: 'voicemail', target: id } });
    expect(cfg.options['1']).toEqual({ type: 'ring_group', id });
    expect(cfg.timeout).toEqual({ type: 'voicemail', id });
  });

  it('defaults options to empty', () => {
    expect(parseIvrConfig({}).options).toEqual({});
  });

  it('rejects multi-digit keys and unknown destination types', () => {
    expect(() => parseIvrConfig({ options: { '12': { type: 'extension', id } } })).toThrow();
    expect(() => parseIvrConfig({ options: { '1': { type: 'dance', id } } })).toThrow();
    expect(() => parseIvrConfig({ repeat_digit: '**' })).toThrow();
  });
});

describe('WeeklyScheduleSchema', () => {
  it('validates days and HH:MM', () => {
    expect(WeeklyScheduleSchema.parse({ intervals: [{ day: 1, start: '09:00', end: '24:00' }] }).intervals).toHaveLength(1);
    expect(() => WeeklyScheduleSchema.parse({ intervals: [{ day: 7, start: '09:00', end: '17:00' }] })).toThrow();
    expect(() => WeeklyScheduleSchema.parse({ intervals: [{ day: 1, start: '9:00', end: '17:00' }] })).toThrow();
  });
});

describe('isTransientDbError', () => {
  it('classifies failover errors', () => {
    expect(isTransientDbError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientDbError({ code: '25006' })).toBe(true);
    expect(isTransientDbError({ code: '08006' })).toBe(true);
    expect(isTransientDbError({ code: '23505' })).toBe(false);
    expect(isTransientDbError(new Error('x'))).toBe(false);
  });
});
