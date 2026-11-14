import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The per-call audio verdicts of infra/ansible/roles/rtpengine/files/pbx-call-audio.py, run on real
// rtpengine "Final packet stats" lines from 2026-11-14 (fixtures/rtpengine-final-stats.txt).
// Needs python3 (or python) on PATH; skipped otherwise.

const SCRIPT = join(import.meta.dirname, '../../../infra/ansible/roles/rtpengine/files/pbx-call-audio.py');
const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/rtpengine-final-stats.txt'), 'utf8');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

interface Leg { side: string; verdict: string | null; in_bpp: number | null; out_bpp: number | null }
interface Rec { call_id: string; verdict: string; duration_s: number; test: boolean; legs: Leg[] }

function run(input: string, ...args: string[]): Rec[] {
  const r = spawnSync(python!, ['-I', SCRIPT, '--stdin', ...args], { input, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

describe.skipIf(!python)('pbx-call-audio verdicts', () => {
  const recs = python ? run(FIXTURE) : [];
  const byId = (prefix: string) => recs.find((r) => r.call_id.startsWith(prefix))!;

  it('the 2026-11-14 codec flip: we sent a PCMU phone G.729 after its refresh', () => {
    const r = byId('f068b387c682ab9d298e');
    expect(r.verdict).toBe('format_mismatch');
    const party = r.legs.find((l) => l.side === 'party')!;
    expect(party.in_bpp).toBe(172);
    expect(party.out_bpp).toBeLessThan(100);
  });

  it('carrier call and TLS phone call, PCMU both ways: ok', () => {
    expect(byId('5e814da2').verdict).toBe('ok');
    expect(byId('a96833c4').verdict).toBe('ok');
  });

  it('browser leg (PCMU mixed with comfort noise) is not a mismatch', () => {
    expect(byId('e38q6p2rqaf5mqorsdh1').verdict).toBe('ok');
  });

  it('TLS phone that got no audio from us (SDES suite bug, PR #51): silent_to_party', () => {
    expect(byId('caaa731f').verdict).toBe('silent_to_party');
  });

  it('fork branches that never answered are ignored, the answered leg decides', () => {
    const r = byId('7ea050e7');
    expect(r.legs.filter((l) => l.side === 'none')).toHaveLength(2);
    expect(r.verdict).toBe('ok');
    expect(r.duration_s).toBeGreaterThan(3500);   // the 60-minute call
  });

  it('calls with a --test-peer leg are marked as test traffic', () => {
    const marked = run(FIXTURE, '--test-peer', '130.245.136.128');
    expect(marked.find((r) => r.call_id.startsWith('f068b387'))!.test).toBe(true);
    expect(marked.find((r) => r.call_id.startsWith('5e814da2'))!.test).toBe(false);
  });
});
