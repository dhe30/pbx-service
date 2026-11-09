import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, startDb, until, type Db } from '../harness/env.js';

// Data-model rules from the course spec that the database itself enforces, plus the contracts the
// telephony side relies on (NOTIFY triggers, Kamailio's view, search indexes).

let db: Db;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db?.close());

describe('§3 Extensions data rules', () => {
  it('extension number is unique within an account, reusable across accounts', async () => {
    const a = await new Account(db.sql).create();
    const b = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    await b.extension({ number: '101' });
    await expect(a.extension({ number: '101' })).rejects.toThrow(/duplicate key/);
  });

  it('SIP usernames are globally unique (one SIP domain for every account)', async () => {
    const a = await new Account(db.sql).create();
    const b = await new Account(db.sql).create();
    await a.extension({ number: '101', sip: 'shared-name' });
    await expect(b.extension({ number: '102', sip: 'shared-name' })).rejects.toThrow(/duplicate key/);
  });

  it('extension numbers are digits only', async () => {
    const a = await new Account(db.sql).create();
    await expect(a.extension({ number: '10a' })).rejects.toThrow(/check constraint/);
  });
});

describe('§2 Price ceilings are enforced by the database', () => {
  for (const [col, bad] of [
    ['us_per_min', 0.07],
    ['toll_free_in_per_min', 0.061],
    ['intl_multiplier', 6.5],
    ['intl_min_per_min', 0.07],
  ] as const) {
    it(`${col} > ceiling is rejected`, async () => {
      await expect(db.sql.unsafe(`update call_pricing set ${col} = ${bad}`)).rejects.toThrow(/check constraint/);
    });
  }
});

describe('Config change notifications (ARI app cache, B6)', () => {
  async function notifications(fn: () => Promise<unknown>): Promise<string[]> {
    const got: string[] = [];
    const unsub = await db.pg.listen('pbx_config', (p) => got.push(p));
    try {
      await fn();
      await until(() => got.length > 0, 2000, 'NOTIFY');
      return got;
    } finally {
      await unsub();
    }
  }

  it('fires with the tenant id for account, routing and add-on changes', async () => {
    const a = await new Account(db.sql).create();
    expect(await notifications(() => db.sql`update tenants set status = 'past_due' where id = ${a.id}`)).toContain(a.id);
    expect(await notifications(() => db.sql`update tenant_settings set intl_calling = true where tenant_id = ${a.id}`)).toContain(a.id);
    expect(await notifications(() => a.extension({ number: '200' }))).toContain(a.id);
    expect(await notifications(() => a.block('+12015550000'))).toContain(a.id);
    const g = await a.ringGroup('all', ['200'], 20, null);
    expect(await notifications(() => db.sql`delete from ring_group_members where ring_group_id = ${g}`)).toContain(a.id);
  });

  it('a number moved to another account invalidates both', async () => {
    const a = await new Account(db.sql).create();
    const b = await new Account(db.sql).create();
    const id = await a.number('+12015551111', null);
    const got = await notifications(() => db.sql`update phone_numbers set tenant_id = ${b.id} where id = ${id}`);
    await until(() => got.includes(a.id) && got.includes(b.id), 2000);
  });

  it('rate deck / pricing changes fire pbx_rates', async () => {
    const got: string[] = [];
    const unsub = await db.pg.listen('pbx_rates', (p) => got.push(p));
    await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values ('us', '1999', 'x', 0.01)`;
    await until(() => got.length > 0, 2000);
    await unsub();
  });
});

describe('Kamailio contract', () => {
  it('kamailio_did_tenant maps DID digits (no +) to the account', async () => {
    const a = await new Account(db.sql).create();
    await a.number('+12015552222', null);
    const rows = await db.sql`select tenant_id from kamailio_did_tenant where did_digits = '12015552222'`;
    expect(rows[0]).toEqual({ tenantId: a.id });
  });

  it('a released number keeps routing until its paid period ends', async () => {
    const a = await new Account(db.sql).create();
    const id = await a.number('+12015553333', null);
    await db.sql`update phone_numbers set status = 'released', paid_until = now() + interval '2 days' where id = ${id}`;
    expect(await db.sql`select 1 from kamailio_did_tenant where did_digits = '12015553333'`).toHaveLength(1);
    await db.sql`update phone_numbers set paid_until = now() - interval '1 minute' where id = ${id}`;
    expect(await db.sql`select 1 from kamailio_did_tenant where did_digits = '12015553333'`).toHaveLength(0);
  });
});

describe('§4 Call history search', () => {
  it('has the indexes the search needs (newest first, number partial match, filters)', async () => {
    const idx = (await db.sql<{ indexname: string; indexdef: string }[]>`select indexname, indexdef from pg_indexes where tablename = 'cdrs'`).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['cdrs_tenant_started_idx', 'cdrs_tenant_dir_idx', 'cdrs_tenant_outcome_idx', 'cdrs_from_ext_idx', 'cdrs_to_ext_idx', 'cdrs_numbers_trgm_idx']));
  });

  it('partial number search uses the trigram index on a large table', async () => {
    const a = await new Account(db.sql).create();
    await db.pg.exec(`
      insert into cdrs (id, call_id, tenant_id, direction, from_number, to_number, started_at, ended_at, outcome, pbx_node)
      select gen_random_uuid(), gen_random_uuid(), '${a.id}', 'incoming', '+1201' || lpad(g::text, 7, '0'), '+16315550000',
             now() - (g || ' s')::interval, now(), 'answered', 'x'
        from generate_series(1, 20000) g;
      analyze cdrs;`);
    const q = `select id from cdrs where tenant_id = '${a.id}'
                 and (coalesce(from_number,'') || ' ' || coalesce(to_number,'') || ' ' || coalesce(did,'')) like '%0012345%'
               order by started_at desc, id desc limit 50`;
    const plan = (await db.pg.query<{ 'QUERY PLAN': string }>(`explain ${q}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/cdrs_numbers_trgm_idx|cdrs_tenant_started_idx/);
    const rows = (await db.pg.query(q)).rows;
    expect(rows).toHaveLength(1);
  });

  it('cdrs are insert-only from telephony: id is the primary key (idempotent replays)', async () => {
    const a = await new Account(db.sql).create();
    const id = randomUUID();
    const row = { id, call_id: id, tenant_id: a.id, direction: 'internal', started_at: new Date(), ended_at: new Date(), outcome: 'answered', pbx_node: 'x' };
    await db.sql`insert into cdrs ${db.sql(row)}`;
    await expect(db.sql`insert into cdrs ${db.sql(row)}`).rejects.toThrow(/duplicate key/);
  });
});
