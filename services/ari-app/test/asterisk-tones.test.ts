import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ringback the ARI app plays while extensions ring (src/ring.ts, `tone:ring;tonezone=us`)
// needs a "us" tone zone with a "ring" tone. Asterisk is built without its sample configs, so
// indications.conf must come from us: without it every ringback failed and callers heard silence
// (pbx-2, 2026-11-15: "Failed to parse tone part 'ring'"). Checked on the sources, so it runs
// without rendering the templates.

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('Asterisk tones', () => {
  const ring = read('services/ari-app/src/ring.ts').match(/const RINGBACK = '(tone:(\w+);tonezone=(\w+))'/);

  it('the ringback names a tone and zone', () => {
    expect(ring?.[2]).toBe('ring');
    expect(ring?.[3]).toBe('us');
  });

  it("indications.conf defines that zone's ring tone", () => {
    const conf = read('telephony/asterisk/indications.conf.j2');
    const zone = conf.split(/^\[/m).find((s) => s.startsWith(`${ring?.[3]}]`)) ?? '';
    expect(zone).toMatch(/^ring\s*=\s*440\+480\/2000,0\/4000$/m);
  });

  it('the asterisk role installs indications.conf', () => {
    expect(read('infra/ansible/roles/asterisk/defaults/main.yml')).toMatch(/^\s+- indications\.conf\b/m);
  });
});
