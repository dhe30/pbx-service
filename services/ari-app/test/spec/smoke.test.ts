import { afterAll, beforeAll, expect, it } from 'vitest';
import { Account, makeHarness, startDb, until, type Db } from '../harness/env.js';

let db: Db;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db?.close());

it('smoke: PSTN call to a number routed to an extension is answered and bridged', async () => {
  const h = makeHarness(db.sql);
  const a = await new Account(db.sql).create();
  const ext = await a.extension({ number: '101' });
  await a.number('+12015550101', { type: 'extension', id: ext });
  h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });

  const caller = h.ari.carrierCall('12015550101', '16315550000');
  const leg = await until(() => h.ari.legsTo(a.ext['101']!.sip)[0], 3000, 'ring');
  await until(() => h.ari.peerOf(caller) === leg.id, 3000, 'bridge');
  h.ari.remoteHangup(caller);
  await h.settle();
  const [cdr] = await a.cdrs();
  expect(cdr).toMatchObject({ direction: 'incoming', outcome: 'answered', toExtension: '101', fromNumber: '+16315550000', did: '+12015550101' });
});
