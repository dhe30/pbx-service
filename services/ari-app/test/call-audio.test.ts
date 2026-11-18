import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  // A TLS (SRTP) phone talking G.723: rtpengine transcodes, and counts the 10-byte SRTP tag on what
  // it SENDS (in 36 B, out 46 B). Live 2026-11-15 (edge-1, 10:57 and 11:13): two false alerts.
  const srtpCall = (cid: string, inP: number, inB: number, outP: number, outB: number, codec = 'G723/8000') =>
    [
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] Final packet stats:`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] --- Tag '7c810ae6', created 4:53 ago for branch ''`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] ------ Media #1 (audio over RTP/SAVP) using ${codec}`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] --------- Port       10.0.1.13:30010 <>  130.245.136.25:1703, SSRC 1, in ${inP} p, ${inB} b, 0 e, 30 ts, out ${outP} p, ${outB} b, 0 e`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] --- Tag '20a0bd51', created 4:53 ago for branch ''`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] ------ Media #1 (audio over RTP/AVP) using PCMU/8000`,
      `1794740232.177 edge-1 rtpengine[1]: INFO: [${cid}]: [core] --------- Port       10.0.1.13:30020 <>      10.0.1.214:13580, SSRC 2, in 12834 p, 2207448 b, 0 e, 30 ts, out 12931 p, 2224132 b, 0 e`,
      '',
    ].join('\n');

  it('SRTP tag counted on the sent side (transcoded G.723 TLS phone): ok, not format_mismatch', () => {
    const [r] = run(srtpCall('9b6231dce3975047694a@130.245.136.25', 8621, 310356, 8556, 393576));
    expect(r!.verdict).toBe('ok');
  });

  it('a real mismatch on an SRTP leg still shows: G.723 phone sent PCMU (+tag)', () => {
    const [r] = run(srtpCall('mismatch@130.245.136.25', 8621, 310356, 8556, 8556 * 182));
    expect(r!.verdict).toBe('format_mismatch');
  });

  it('calls with a --test-peer leg are marked as test traffic', () => {
    const marked = run(FIXTURE, '--test-peer', '130.245.136.128');
    expect(marked.find((r) => r.call_id.startsWith('f068b387'))!.test).toBe(true);
    expect(marked.find((r) => r.call_id.startsWith('5e814da2'))!.test).toBe(false);
  });

  it('--prom: customer legs also counted by party codec and SRTP (2026-11-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbx-call-audio-'));
    const prom = join(dir, 'm.prom');
    const r = spawnSync(python!, ['-I', SCRIPT, '--stdin', '--prom', prom, '--test-peer', '130.245.136.128'], { input: FIXTURE, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(prom, 'utf8');
    rmSync(dir, { recursive: true });
    expect(text).toContain('# TYPE pbx_call_audio_party_legs_total counter');
    const series = [...text.matchAll(/^pbx_call_audio_party_legs_total\{verdict="([^"]+)",codec="([^"]+)",srtp="(true|false)"\} (\d+)$/gm)];
    // a fixed label set (verdicts x 5 codecs + unknown/other x srtp), zeros included
    expect(series).toHaveLength(5 * 7 * 2);
    const n = (v: string, c: string, s: string) => Number(series.find((m) => m[1] === v && m[2] === c && m[3] === s)![4]);
    const customerParty = run(FIXTURE, '--test-peer', '130.245.136.128')
      .filter((x) => !x.test)
      .flatMap((x) => x.legs.filter((l) => l.side === 'party' && l.verdict));
    const sum = series.reduce((a, m) => a + Number(m[4]), 0);
    expect(sum).toBe(customerParty.length); // every customer party leg, once; test legs not at all
    expect(n('ok', 'PCMU', 'false')).toBeGreaterThan(0);
    // the existing metric (alert CustomerCallAudioBad) is unchanged
    expect(text).toMatch(/^pbx_call_audio_legs_total\{verdict="ok",test="false"\} \d+$/m);
  });
});
