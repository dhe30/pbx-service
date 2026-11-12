import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDb, type Destination, type ForwardDestination, type Sql } from '@pbx/shared';
import { PbxApp } from '../../src/app.js';
import { EventBus } from '../../src/ari/events.js';
import { ConfigCache } from '../../src/cache.js';
import { CdrWriter } from '../../src/cdr.js';
import { loadConfig } from '../../src/config.js';
import type { Ctx } from '../../src/ctx.js';
import { LegTracker } from '../../src/legs.js';
import { log } from '../../src/log.js';
import { Repo } from '../../src/repo.js';
import type { SpoolMeta } from '../../src/uploader.js';
import { FakeAsterisk } from './fake-asterisk.js';

// Test environment: a real Postgres (PGlite, in process) with the repo's migrations, the real Repo /
// ConfigCache / CdrWriter / call flows, and a FakeAsterisk in place of ARI.

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

export interface Db {
  sql: Sql;
  /** The in-process Postgres itself (LISTEN, EXPLAIN, ...). */
  pg: PGlite;
  close(): Promise<void>;
}

let nextPort = 56000 + (process.pid % 2000) * 2;

export async function startDb(): Promise<Db> {
  const db = new PGlite({ extensions: { pg_trgm } });
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8').split('-- migrate:down')[0]!);
  }
  const port = nextPort++;
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  const sql = createDb(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  return {
    sql,
    pg: db,
    async close() {
      await sql.end({ timeout: 1 });
      await server.stop();
      await db.close();
    },
  };
}

export interface Harness {
  ctx: Ctx;
  app: PbxApp;
  ari: FakeAsterisk;
  sql: Sql;
  uploads: { begun: (Omit<SpoolMeta, 'createdAt' | 'ready'> & { name: string })[]; finished: string[] };
  /** Run until every call flow ended and every CDR is in Postgres. */
  settle(): Promise<void>;
}

export function makeHarness(sql: Sql, env: Record<string, string> = {}): Harness {
  const cfg = loadConfig({
    ARI_USER: 'test',
    ARI_PASSWORD: 'test',
    DATABASE_URL: 'postgres://unused',
    S3_ENDPOINT: 'http://s3.test',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    TRUNKS: 'edge-a,edge-b',
    PBX_NODE: 'pbx-test',
    // 1 s of call-flow time = 10 ms of test time (ring timeouts, IVR waits).
    TIME_SCALE: '0.01',
    ...env,
  });
  const repo = new Repo(sql, log);
  const cache = new ConfigCache(repo, cfg.CONFIG_TTL_SEC, log);
  const cdr = new CdrWriter(null, repo, async () => (await cache.getRates()).pricing, log, 5);
  const ari = new FakeAsterisk();
  const uploads: Harness['uploads'] = { begun: [], finished: [] };
  const ctx: Ctx = {
    cfg,
    ari,
    bus: new EventBus(),
    repo,
    cache,
    cdr,
    media: {
      soundUri: async (_t: string, mediaId: string) => `sound:/cache/${mediaId}`,
      objectUri: async (mediaId: string) => `sound:/cache/${mediaId}`,
    },
    uploader: {
      begin: async (name: string, meta: Omit<SpoolMeta, 'createdAt' | 'ready'>) => {
        uploads.begun.push({ name, ...meta });
      },
      finish: async (name: string) => {
        uploads.finished.push(name);
      },
      abandon: async () => {},
    },
    legs: new LegTracker(),
    conversations: new Map(),
  };
  const app = new PbxApp(ctx, log);
  ari.onEvent = (ev) => app.onEvent(ev);
  return {
    ctx,
    app,
    ari,
    sql,
    uploads,
    async settle() {
      await app.idle();
      await cdr.drain();
    },
  };
}

/** Poll until `fn` returns truthy (or throw after `ms`). */
export async function until<T>(fn: () => T | Promise<T>, ms = 3000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- account builder ---------------------------------------------------------------------------

export interface ExtOpts {
  number: string;
  sip?: string;
  mailbox?: boolean;
  ringTimeoutSec?: number;
  forwardAlways?: ForwardDestination;
  forwardBusy?: ForwardDestination;
  forwardNoAnswer?: ForwardDestination;
  externalNumbers?: string[];
  callerId?: string;
}

export class Account {
  readonly id = randomUUID();
  readonly ext: Record<string, { id: string; sip: string; mailboxId: string | null }> = {};
  private readonly tag = this.id.slice(0, 8);

  constructor(private readonly sql: Sql) {}

  async create(opts: { timezone?: string; recordCalls?: boolean; intlCalling?: boolean; includedUsMinutes?: number; status?: 'active' | 'past_due'; createdAt?: Date } = {}): Promise<this> {
    await this.sql`insert into tenants (id, name, timezone, status, created_at)
      values (${this.id}, ${'Acct ' + this.tag}, ${opts.timezone ?? 'America/New_York'}, ${opts.status ?? 'active'}, ${opts.createdAt ?? new Date('2026-11-02T05:00:00Z')})`;
    await this.sql`insert into tenant_settings (tenant_id, record_calls, intl_calling, included_us_minutes)
      values (${this.id}, ${opts.recordCalls ?? false}, ${opts.intlCalling ?? false}, ${opts.includedUsMinutes ?? 0})`;
    return this;
  }

  async mailbox(name: string): Promise<string> {
    const id = randomUUID();
    await this.sql`insert into mailboxes (id, tenant_id, name) values (${id}, ${this.id}, ${name})`;
    return id;
  }

  async extension(o: ExtOpts): Promise<string> {
    const id = randomUUID();
    const sip = o.sip ?? `u${o.number}-${this.tag}`;
    const mailboxId = o.mailbox === false ? null : await this.mailbox(`Ext ${o.number}`);
    await this.sql`insert into extensions (id, tenant_id, number, name, sip_username, mailbox_id, ring_timeout_sec,
        forward_always, forward_busy, forward_no_answer, external_numbers, caller_id_number)
      values (${id}, ${this.id}, ${o.number}, ${'Ext ' + o.number}, ${sip}, ${mailboxId}, ${o.ringTimeoutSec ?? 20},
        ${o.forwardAlways ? this.sql.json(o.forwardAlways) : null}, ${o.forwardBusy ? this.sql.json(o.forwardBusy) : null},
        ${o.forwardNoAnswer ? this.sql.json(o.forwardNoAnswer) : null}, ${o.externalNumbers ?? []}, ${o.callerId ?? null})`;
    this.ext[o.number] = { id, sip, mailboxId };
    return id;
  }

  async number(did: string, destination: Destination | null, kind: 'local' | 'toll_free' = 'local', incomingCostPerMin?: number): Promise<string> {
    const id = randomUUID();
    await this.sql`insert into phone_numbers (id, did, tenant_id, destination, kind, status, incoming_cost_per_min, purchased_at)
      values (${id}, ${did}, ${this.id}, ${destination ? this.sql.json(destination) : null}, ${kind}, 'assigned',
              ${incomingCostPerMin ?? null}, clock_timestamp())`;
    return id;
  }

  async ringGroup(
    strategy: 'all' | 'sequential',
    members: string[],
    ringTimeoutSec: number,
    noAnswer: Destination | null,
    totalTimeoutSec: number | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await this.sql`insert into ring_groups (id, tenant_id, name, strategy, ring_timeout_sec, total_timeout_sec, no_answer_destination)
      values (${id}, ${this.id}, 'group', ${strategy}, ${ringTimeoutSec}, ${totalTimeoutSec}, ${noAnswer ? this.sql.json(noAnswer) : null})`;
    let pos = 0;
    for (const m of members) {
      await this.sql`insert into ring_group_members (ring_group_id, extension_id, position) values (${id}, ${this.ext[m]!.id}, ${pos++})`;
    }
    return id;
  }

  async ivr(config: unknown, opts: { timeoutSec?: number; maxRetries?: number } = {}): Promise<string> {
    const id = randomUUID();
    await this.sql`insert into ivr_menus (id, tenant_id, name, timeout_sec, max_retries, config)
      values (${id}, ${this.id}, 'menu', ${opts.timeoutSec ?? 5}, ${opts.maxRetries ?? 3}, ${this.sql.json(config as never)})`;
    return id;
  }

  async businessHours(intervals: { day: number; start: string; end: string }[], open: Destination, closed: Destination): Promise<string> {
    const id = randomUUID();
    await this.sql`insert into business_hours (id, tenant_id, name, schedule, open_destination, closed_destination)
      values (${id}, ${this.id}, 'hours', ${this.sql.json({ intervals })}, ${this.sql.json(open)}, ${this.sql.json(closed)})`;
    return id;
  }

  async block(number: string): Promise<void> {
    await this.sql`insert into blocked_numbers (tenant_id, number) values (${this.id}, ${number})`;
  }

  async voicemail(mailboxId: string, heard = false, at = new Date()): Promise<string> {
    const mediaId = randomUUID();
    await this.sql`insert into media (id, tenant_id, kind, object_key, format) values (${mediaId}, ${this.id}, 'voicemail', ${'k/' + mediaId}, 'wav')`;
    const [r] = await this.sql<{ id: string }[]>`insert into voicemails (tenant_id, mailbox_id, media_id, heard, created_at)
      values (${this.id}, ${mailboxId}, ${mediaId}, ${heard}, ${at}) returning id`;
    return r!.id;
  }

  async cdrs(): Promise<CdrRow[]> {
    return [...(await this.sql<CdrRow[]>`select * from cdrs where tenant_id = ${this.id} order by parent_id nulls first, started_at, id`)];
  }
}

export interface CdrRow {
  id: string;
  callId: string;
  parentId: string | null;
  direction: string;
  fromNumber: string | null;
  toNumber: string | null;
  did: string | null;
  fromExtension: string | null;
  toExtension: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date;
  billableSec: number;
  outcome: string;
  vendor: string | null;
  ratePrefix: string | null;
  cost: string;
  charge: string;
  includedSec: number;
  voicemail: boolean;
}

let didSeq = 0;
/** A fresh US DID per test (DIDs are globally unique). */
export function nextDid(): string {
  didSeq++;
  return `+1201${String(5550000 + ((process.pid * 7 + didSeq) % 4000000)).padStart(7, '0')}`;
}
