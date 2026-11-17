import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// loadtest/diag/sip-history.py: searches the edges' SIP history (Kamailio sipdump pcaps).
// fixtures/sipdump-sample.pcap is real output of Kamailio 6.0.8's sipdump (mode 12): an OPTIONS and
// a REGISTER with Kamailio's 200 replies, each message carrying "P-KSR-SIPDump: udp pid=.. pno=..".
// Needs python3 (or python) on PATH; skipped otherwise.

const SCRIPT = join(import.meta.dirname, '../../../loadtest/diag/sip-history.py');
const SAMPLE = join(import.meta.dirname, 'fixtures/sipdump-sample.pcap');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const tmp = mkdtempSync(join(tmpdir(), 'siphist-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(...args: string[]): string {
  const r = spawnSync(python!, ['-I', SCRIPT, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** A classic pcap (Ethernet) with one UDP packet per message, like sipdump writes. */
function pcap(msgs: { t: number; src: string; dst: string; sip: string }[]): Buffer {
  const parts = [Buffer.from('d4c3b2a1020004000000000000000000ffff000001000000', 'hex')];
  for (const m of msgs) {
    const payload = Buffer.from(m.sip.replace(/\n/g, '\r\n'));
    const [sip, sport] = m.src.split(':');
    const [dip, dport] = m.dst.split(':');
    const udp = Buffer.alloc(8);
    udp.writeUInt16BE(Number(sport), 0);
    udp.writeUInt16BE(Number(dport), 2);
    udp.writeUInt16BE(8 + payload.length, 4);
    const ip = Buffer.alloc(20);
    ip[0] = 0x45;
    ip.writeUInt16BE(20 + 8 + payload.length, 2);
    ip[8] = 64;
    ip[9] = 17;
    Buffer.from(sip!.split('.').map(Number)).copy(ip, 12);
    Buffer.from(dip!.split('.').map(Number)).copy(ip, 16);
    const eth = Buffer.concat([Buffer.alloc(12), Buffer.from('0800', 'hex')]);
    const frame = Buffer.concat([eth, ip, udp, payload]);
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(Math.floor(m.t), 0);
    rec.writeUInt32LE(Math.round((m.t % 1) * 1e6), 4);
    rec.writeUInt32LE(frame.length, 8);
    rec.writeUInt32LE(frame.length, 12);
    parts.push(rec, frame);
  }
  return Buffer.concat(parts);
}

const req = (method: string, cid: string, proto: string, extra = '', from = 'x2e11f8d87a326444') =>
  `${method} sip:16315550132@group-4 SIP/2.0\nP-KSR-SIPDump: ${proto} pid=1 pno=1\nCall-ID: ${cid}\nCSeq: 1 ${method}\nFrom: <sip:${from}@group-4>;tag=a\nTo: <sip:16315550132@group-4>\n${extra}Content-Length: 0\n\n`;
const rsp = (code: string, method: string, cid: string, proto: string) =>
  `SIP/2.0 ${code}\nP-KSR-SIPDump: ${proto} pid=1 pno=1\nCall-ID: ${cid}\nCSeq: 1 ${method}\nContent-Length: 0\n\n`;

describe.skipIf(!python)('sip-history.py', () => {
  it('reads real Kamailio 6.0.8 sipdump output: transport, requests and our replies, by Call-ID', () => {
    const out = run(SAMPLE);
    expect(out).toMatch(/1 file\(s\), 4 messages; 2 Call-IDs match/);
    expect(out).toMatch(/=== Call-ID test-1@127\.0\.0\.1 \(2 messages\)/);
    expect(out).toMatch(/udp\s+127\.0\.0\.1:5098 -> 127\.0\.0\.1:5099\s+REGISTER sip:127\.0\.0\.1:5099 SIP\/2\.0 cseq 1/);
    expect(out).toMatch(/udp\s+127\.0\.0\.1:5099 -> 127\.0\.0\.1:5098\s+SIP\/2\.0 200 OK \(REGISTER\) cseq 1/);
  });

  it('--method, --call-id and --full narrow and expand the ladder', () => {
    expect(run(SAMPLE, '--method', 'register')).toMatch(/; 1 Call-IDs match/);
    expect(run(SAMPLE, '--call-id', 'test-0')).toMatch(/=== Call-ID test-0@127\.0\.0\.1/);
    expect(run(SAMPLE, '--call-id', 'test-1', '--full')).toMatch(/\n {4}P-KSR-SIPDump: udp pid=\d+ pno=1/);
  });

  it('--failed keeps calls with a real failure (486), not auth challenges (401/407); --match finds a number', () => {
    const file = join(tmp, 'sip-2026-11-15--11-00-00.pcap');
    writeFileSync(
      file,
      pcap([
        // A TLS phone's call that fails with 486 (decrypted by sipdump, transport in the header).
        { t: 1794744000.1, src: '130.245.136.25:5061', dst: '10.0.1.13:5061', sip: req('INVITE', 'fail@tls', 'tls') },
        { t: 1794744000.2, src: '10.0.1.13:5061', dst: '130.245.136.25:5061', sip: rsp('486 Busy Here', 'INVITE', 'fail@tls', 'tls') },
        // A REGISTER challenged with 401 and then accepted: not a failure.
        { t: 1794744001.0, src: '130.245.136.125:30070', dst: '10.0.1.13:5060', sip: req('REGISTER', 'reg@udp', 'udp') },
        { t: 1794744001.1, src: '10.0.1.13:5060', dst: '130.245.136.125:30070', sip: rsp('401 Unauthorized', 'REGISTER', 'reg@udp', 'udp') },
        // An internet scanner's OPTIONS, refused: noise, not a customer failure.
        { t: 1794744002.0, src: '103.77.253.46:59696', dst: '10.0.1.13:5060', sip: req('OPTIONS', '1', 'udp', '', 'scanner') },
        { t: 1794744002.1, src: '10.0.1.13:5060', dst: '103.77.253.46:59696', sip: rsp('403 Forbidden', 'OPTIONS', '1', 'udp') },
      ]),
    );
    const failed = run(file, '--failed');
    expect(failed).toMatch(/; 1 Call-IDs match/); // only the 486: the 401 and the scanner's OPTIONS 403 are left out
    expect(failed).not.toMatch(/=== Call-ID 1 /);
    expect(run(file, '--failed', '--method', 'OPTIONS')).toMatch(/=== Call-ID 1 /);
    expect(failed).toMatch(/=== Call-ID fail@tls/);
    expect(failed).toMatch(/tls\s+10\.0\.1\.13:5061 -> 130\.245\.136\.25:5061\s+SIP\/2\.0 486 Busy Here \(INVITE\)/);
    expect(run(file, '--match', 'x2e11f8d87a326444')).toMatch(/; 2 Call-IDs match/);
    expect(run(file, '--match', '16315550132', '--method', 'INVITE')).toMatch(/; 1 Call-IDs match/);
  });

  it('--dir with --since/--until picks files by their packets, not their (local-time) names', () => {
    const dir = mkdtempSync(join(tmp, 'dir-'));
    // Named 06:00 (local time), but its packets are at 11:00 UTC (1794740400 = 2026-11-15T11:00:00Z).
    writeFileSync(join(dir, 'sip-2026-11-15--06-00-00.pcap'), pcap([
      { t: 1794740400.1, src: '130.245.136.25:5061', dst: '10.0.1.13:5061', sip: req('INVITE', 'in-window', 'tls') },
    ]));
    expect(run('--dir', dir, '--since', '2026-11-15T10:59', '--until', '2026-11-15T11:01')).toMatch(/; 1 Call-IDs match/);
    expect(run('--dir', dir, '--since', '2026-11-15T12:00', '--long')).toMatch(/0 messages/); // last file: still read, nothing in window (open-ended window: --long)
    expect(run('--dir', dir, '--until', '2026-11-15T10:00', '--long')).toMatch(/no SIP history files in .* for that time window/);
  });
});
