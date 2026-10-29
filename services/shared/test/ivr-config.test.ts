import { describe, expect, it } from 'vitest';
import { parseIvrConfig } from '../src/ivr-config.js';
import { isTransientDbError } from '../src/db.js';

const id = '00000000-0000-4000-8000-000000000030';

describe('parseIvrConfig', () => {
  it('accepts the documented shape', () => {
    const cfg = parseIvrConfig({
      options: { '1': { action: 'ring_group', target: id }, '#': { action: 'voicemail', target: id } },
      on_timeout: { action: 'user', target: id },
    });
    expect(cfg.options['1']).toEqual({ action: 'ring_group', target: id });
  });

  it('defaults options to empty', () => {
    expect(parseIvrConfig({}).options).toEqual({});
  });

  it('rejects multi-digit keys and unknown actions', () => {
    expect(() => parseIvrConfig({ options: { '12': { action: 'user', target: id } } })).toThrow();
    expect(() => parseIvrConfig({ options: { '1': { action: 'dance', target: id } } })).toThrow();
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
