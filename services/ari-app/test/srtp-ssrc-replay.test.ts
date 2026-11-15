import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// loadtest/diag/srtp-ssrc-replay.py replays an Asterisk SSRC switch through an edge's rtpengine and
// decrypts what an SRTP phone receives (docs/incidents/2026-11-15-tls-bad-codec.md). Its SRTP code
// is checked here against the RFC 3711 test vectors, plus the three receiver models.
// Needs python3 (or python) with the `cryptography` package; skipped otherwise.

const SCRIPT = join(import.meta.dirname, '../../../loadtest/diag/srtp-ssrc-replay.py');
const python = ['python3', 'python'].find(
  (p) => spawnSync(p, ['-c', 'import cryptography']).status === 0,
);

describe.skipIf(!python)('srtp-ssrc-replay.py', () => {
  it('--selftest: RFC 3711 key derivation, round trip, receiver models', () => {
    const r = spawnSync(python!, ['-I', SCRIPT, '--selftest'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('selftest ok');
  });
});
