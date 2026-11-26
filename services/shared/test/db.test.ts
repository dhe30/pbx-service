import { describe, expect, it } from 'vitest';
import { isPostgresClosedSocketWrite } from '../src/db.js';

describe('isPostgresClosedSocketWrite', () => {
  // The stack seen live (2026-11-26 18:07 UTC, every pbx node), trimmed.
  const live = () => {
    const e = new TypeError("Cannot read properties of null (reading 'write')");
    e.stack =
      "TypeError: Cannot read properties of null (reading 'write')\n" +
      '    at Immediate.nextWrite (file:///opt/pbx/src/node_modules/postgres/src/connection.js:255:22)\n' +
      '    at process.processImmediate (node:internal/timers:485:21)';
    return e;
  };

  it("matches postgres.js writing to a connection that already closed", () => {
    expect(isPostgresClosedSocketWrite(live())).toBe(true);
    const cjs = live();
    cjs.stack = cjs.stack!.replace('postgres/src/', 'postgres/cjs/src/'.replace('cjs/src/', 'cjs/'));
    expect(isPostgresClosedSocketWrite(cjs)).toBe(true);
  });

  it('does not match other errors, even similar ones', () => {
    expect(isPostgresClosedSocketWrite(new TypeError("Cannot read properties of null (reading 'write')"))).toBe(false);
    const ours = live();
    ours.stack = ours.stack!.replace('node_modules/postgres/src/connection.js', 'services/ari-app/dist/uploader.js');
    expect(isPostgresClosedSocketWrite(ours)).toBe(false);
    expect(isPostgresClosedSocketWrite(new Error('boom'))).toBe(false);
    expect(isPostgresClosedSocketWrite(null)).toBe(false);
  });
});
