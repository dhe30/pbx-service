import {
  DEFAULT_CALL_PRICING,
  ForwardDestinationSchema,
  PrefixTable,
  WeeklyScheduleSchema,
  parseDestination,
  parseIvrConfig,
  rateLeg,
  withRetry,
  type CallPricing,
  type CdrDirection,
  type CdrOutcome,
  type ChargeClass,
  type Destination,
  type ForwardDestination,
  type PstnVendor,
  type Sql,
} from '@pbx/shared';
import type { Logger } from './log.js';
import type { ExtensionCfg, Rates, TenantConfig } from './tenant.js';

// All SQL used by the ARI app. Queries on the call path are wrapped in withRetry so a Patroni
// failover (connection errors for a few seconds) doesn't fail calls that could still succeed.
// The hot call path only reads through ConfigCache (cache.ts); these loaders run on a cache miss.

/** A finished leg waiting to be rated and inserted (also the on-disk CDR spool format). */
export interface PendingCdr {
  id: string;
  callId: string;
  parentId: string | null;
  tenantId: string;
  direction: CdrDirection;
  fromNumber: string | null;
  toNumber: string | null;
  did: string | null;
  fromExtension: string | null;
  toExtension: string | null;
  startedAt: string; // ISO
  answeredAt: string | null;
  endedAt: string;
  outcome: CdrOutcome;
  vendor: PstnVendor | null;
  ratePrefix: string | null;
  voicemail: boolean;
  hangupCause: number | null;
  pbxNode: string;
  /** Rating inputs (resolved when the leg was placed, from the in-memory rate tables). */
  chargeClass: ChargeClass;
  costPerMin: number;
  /** Billing period of startedAt in the account's time zone (usage_periods.period_start). */
  periodStart: string;
  /** Plan US minutes per period, in seconds (tenant_settings.included_us_minutes * 60). */
  includedAllowanceSec: number;
}

export interface VoicemailMsg {
  id: string;
  mediaId: string;
  objectKey: string;
  callerNumber: string | null;
  createdAt: Date;
}

function dest(log: Logger, v: unknown, where: string): Destination | null {
  if (v === null || v === undefined) return null;
  try {
    return parseDestination(v);
  } catch (err) {
    log.warn({ err: (err as Error).message, where }, 'invalid destination in DB; treating as none');
    return null;
  }
}

function fwd(log: Logger, v: unknown, where: string): ForwardDestination | null {
  if (v === null || v === undefined) return null;
  const r = ForwardDestinationSchema.safeParse(v);
  if (!r.success) log.warn({ where }, 'invalid forwarding destination in DB; ignoring');
  return r.success ? r.data : null;
}

export class Repo {
  constructor(
    private readonly sql: Sql,
    private readonly log: Logger,
  ) {}

  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  // ---- lookups that pick the account -------------------------------------------------------

  async tenantIdForDid(dids: string[]): Promise<string | null> {
    if (dids.length === 0) return null;
    const rows = await withRetry(
      () => this.sql<{ tenantId: string }[]>`
        select tenant_id from phone_numbers
         where did = any(${dids}) and tenant_id is not null
           and (status = 'assigned' or paid_until > now())
         limit 1`,
    );
    return rows[0]?.tenantId ?? null;
  }

  async tenantIdForSipUser(sipUsername: string): Promise<string | null> {
    const rows = await withRetry(
      () => this.sql<{ tenantId: string }[]>`select tenant_id from extensions where sip_username = ${sipUsername}`,
    );
    return rows[0]?.tenantId ?? null;
  }

  // ---- full account snapshot ----------------------------------------------------------------

  async loadTenant(tenantId: string): Promise<TenantConfig | null> {
    const sql = this.sql;
    const q = <T>(f: () => Promise<T>) => withRetry(f);
    const [tenants, numbers, exts, groups, members, menus, mailboxes, hours, blocked] = await Promise.all([
      q(() => sql<{ id: string; name: string; timezone: string; status: 'active' | 'past_due'; createdAt: Date; recordCalls: boolean | null; intlCalling: boolean | null; includedUsMinutes: number | null }[]>`
        select t.id, t.name, t.timezone, t.status, t.created_at,
               ts.record_calls, ts.intl_calling, ts.included_us_minutes
          from tenants t left join tenant_settings ts on ts.tenant_id = t.id
         where t.id = ${tenantId}`),
      q(() => sql<{ id: string; did: string; kind: 'local' | 'toll_free'; destination: unknown; ivrMenuId: string | null; incomingCostPerMin: string | null }[]>`
        select id, did, kind, destination, ivr_menu_id, incoming_cost_per_min from phone_numbers
         where tenant_id = ${tenantId} and (status = 'assigned' or paid_until > now())
         order by purchased_at, did`),
      q(() => sql<{ id: string; number: string; name: string; sipUsername: string; mailboxId: string | null; ringTimeoutSec: number; forwardAlways: unknown; forwardBusy: unknown; forwardNoAnswer: unknown; externalNumbers: string[]; callerIdNumber: string | null }[]>`
        select id, number, name, sip_username, mailbox_id, ring_timeout_sec, forward_always, forward_busy,
               forward_no_answer, external_numbers, caller_id_number
          from extensions where tenant_id = ${tenantId}`),
      q(() => sql<{ id: string; name: string; strategy: 'all' | 'sequential'; ringTimeoutSec: number; noAnswerDestination: unknown }[]>`
        select id, name, strategy, ring_timeout_sec, no_answer_destination from ring_groups where tenant_id = ${tenantId}`),
      q(() => sql<{ ringGroupId: string; extensionId: string }[]>`
        select m.ring_group_id, m.extension_id from ring_group_members m
          join ring_groups g on g.id = m.ring_group_id
         where g.tenant_id = ${tenantId} order by m.position, m.extension_id`),
      q(() => sql<{ id: string; greetingMediaId: string | null; timeoutSec: number; maxRetries: number; config: unknown }[]>`
        select id, greeting_media_id, timeout_sec, max_retries, config from ivr_menus where tenant_id = ${tenantId}`),
      q(() => sql<{ id: string; name: string; greetingMediaId: string | null }[]>`
        select id, name, greeting_media_id from mailboxes where tenant_id = ${tenantId}`),
      q(() => sql<{ id: string; schedule: unknown; openDestination: unknown; closedDestination: unknown }[]>`
        select id, schedule, open_destination, closed_destination from business_hours where tenant_id = ${tenantId}`),
      q(() => sql<{ number: string }[]>`select number from blocked_numbers where tenant_id = ${tenantId}`),
    ]);
    const t = tenants[0];
    if (!t) return null;
    const log = this.log;

    const cfg: TenantConfig = {
      id: t.id,
      name: t.name,
      timezone: t.timezone,
      status: t.status,
      createdAt: new Date(t.createdAt),
      recordCalls: !!t.recordCalls,
      intlCalling: !!t.intlCalling,
      includedUsMinutes: t.includedUsMinutes ?? 0,
      numbers: new Map(),
      accountNumbers: [],
      extensions: new Map(),
      extByNumber: new Map(),
      extBySip: new Map(),
      ringGroups: new Map(),
      ivrMenus: new Map(),
      mailboxes: new Map(),
      businessHours: new Map(),
      blocked: new Set(blocked.map((b) => b.number)),
      loadedAt: Date.now(),
    };
    for (const n of numbers) {
      const destination =
        dest(log, n.destination, `phone_numbers ${n.id}`) ?? (n.ivrMenuId ? { type: 'ivr_menu' as const, id: n.ivrMenuId } : null);
      cfg.numbers.set(n.did, {
        id: n.id,
        did: n.did,
        kind: n.kind,
        destination,
        incomingCostPerMin: n.incomingCostPerMin === null ? null : Number(n.incomingCostPerMin),
      });
      cfg.accountNumbers.push(n.did);
    }
    for (const e of exts) {
      const ext: ExtensionCfg = {
        id: e.id,
        number: e.number,
        name: e.name,
        sipUsername: e.sipUsername,
        mailboxId: e.mailboxId,
        ringTimeoutSec: e.ringTimeoutSec,
        forwardAlways: fwd(log, e.forwardAlways, `extension ${e.id} forward_always`),
        forwardBusy: fwd(log, e.forwardBusy, `extension ${e.id} forward_busy`),
        forwardNoAnswer: fwd(log, e.forwardNoAnswer, `extension ${e.id} forward_no_answer`),
        externalNumbers: e.externalNumbers ?? [],
        callerIdNumber: e.callerIdNumber,
      };
      cfg.extensions.set(ext.id, ext);
      cfg.extByNumber.set(ext.number, ext);
      cfg.extBySip.set(ext.sipUsername, ext);
    }
    for (const g of groups) {
      cfg.ringGroups.set(g.id, {
        id: g.id,
        name: g.name,
        strategy: g.strategy,
        ringTimeoutSec: g.ringTimeoutSec,
        noAnswer: dest(log, g.noAnswerDestination, `ring_groups ${g.id}`),
        memberIds: [],
      });
    }
    for (const m of members) cfg.ringGroups.get(m.ringGroupId)?.memberIds.push(m.extensionId);
    for (const m of menus) {
      let config;
      try {
        config = parseIvrConfig(m.config);
      } catch (err) {
        log.warn({ err: (err as Error).message, menu: m.id }, 'invalid IVR config; menu will hang up');
        config = parseIvrConfig({ options: {} });
      }
      cfg.ivrMenus.set(m.id, { id: m.id, greetingMediaId: m.greetingMediaId, timeoutSec: m.timeoutSec, maxRetries: m.maxRetries, config });
    }
    for (const mb of mailboxes) cfg.mailboxes.set(mb.id, mb);
    for (const h of hours) {
      const s = WeeklyScheduleSchema.safeParse(h.schedule);
      cfg.businessHours.set(h.id, {
        id: h.id,
        schedule: s.success ? s.data : { intervals: [] },
        open: dest(log, h.openDestination, `business_hours ${h.id} open`) ?? { type: 'hangup' },
        closed: dest(log, h.closedDestination, `business_hours ${h.id} closed`) ?? { type: 'hangup' },
      });
    }
    return cfg;
  }

  async loadRates(): Promise<Rates> {
    const [decks, pricing] = await Promise.all([
      withRetry(() => this.sql<{ vendor: 'us' | 'intl'; prefix: string; destination: string; perMin: string }[]>`
        select vendor, prefix, destination, per_min from rate_decks`),
      withRetry(() => this.sql<{ usPerMin: string; tollFreeInPerMin: string; intlMultiplier: string; intlMinPerMin: string; tollFreeInCostPerMin: string }[]>`
        select us_per_min, toll_free_in_per_min, intl_multiplier, intl_min_per_min, toll_free_in_cost_per_min
          from call_pricing limit 1`),
    ]);
    const rows = (v: 'us' | 'intl') =>
      decks.filter((d) => d.vendor === v).map((d) => ({ prefix: d.prefix, destination: d.destination, perMin: Number(d.perMin) }));
    const p = pricing[0];
    const callPricing: CallPricing = p
      ? {
          usPerMin: Number(p.usPerMin),
          tollFreeInPerMin: Number(p.tollFreeInPerMin),
          intlMultiplier: Number(p.intlMultiplier),
          intlMinPerMin: Number(p.intlMinPerMin),
          tollFreeInCostPerMin: Number(p.tollFreeInCostPerMin),
        }
      : DEFAULT_CALL_PRICING;
    return { us: new PrefixTable(rows('us')), intl: new PrefixTable(rows('intl')), pricing: callPricing };
  }

  // ---- CDRs ---------------------------------------------------------------------------------

  /**
   * Rate and insert a batch of finished legs in ONE transaction (B6: one round trip per batch,
   * insert-only). Idempotent: legs already in `cdrs` (a replayed spool file) are skipped, so
   * included minutes are never consumed twice. US legs consume the account's included seconds for
   * the leg's billing period under a row lock, so two pbx nodes can't both spend the same minutes.
   */
  async insertCdrs(batch: PendingCdr[], pricing: CallPricing): Promise<void> {
    if (batch.length === 0) return;
    await withRetry(() =>
      this.sql.begin(async (tx) => {
        const existing = await tx<{ id: string }[]>`select id from cdrs where id = any(${batch.map((c) => c.id)})`;
        const skip = new Set(existing.map((r) => r.id));
        const rows = [];
        for (const c of batch) {
          if (skip.has(c.id)) continue;
          const answeredSec = c.answeredAt ? Math.max(0, (Date.parse(c.endedAt) - Date.parse(c.answeredAt)) / 1000) : 0;
          let remaining = 0;
          if (c.chargeClass === 'us' && answeredSec > 0 && c.includedAllowanceSec > 0) {
            await tx`insert into usage_periods (tenant_id, period_start) values (${c.tenantId}, ${c.periodStart})
                     on conflict do nothing`;
            const [u] = await tx<{ includedSecUsed: string }[]>`
              select included_sec_used from usage_periods
               where tenant_id = ${c.tenantId} and period_start = ${c.periodStart} for update`;
            remaining = Math.max(0, c.includedAllowanceSec - Number(u?.includedSecUsed ?? 0));
          }
          const r = rateLeg({ chargeClass: c.chargeClass, answeredSec, costPerMin: c.costPerMin }, pricing, remaining);
          if (r.includedSec > 0) {
            await tx`update usage_periods set included_sec_used = included_sec_used + ${r.includedSec}
                      where tenant_id = ${c.tenantId} and period_start = ${c.periodStart}`;
          }
          rows.push({
            id: c.id,
            call_id: c.callId,
            parent_id: c.parentId,
            tenant_id: c.tenantId,
            direction: c.direction,
            from_number: c.fromNumber,
            to_number: c.toNumber,
            did: c.did,
            from_extension: c.fromExtension,
            to_extension: c.toExtension,
            started_at: c.startedAt,
            answered_at: c.answeredAt,
            ended_at: c.endedAt,
            billable_sec: r.billableSec,
            outcome: c.outcome,
            vendor: c.vendor,
            rate_prefix: c.ratePrefix,
            cost: r.cost,
            charge: r.charge,
            included_sec: r.includedSec,
            voicemail: c.voicemail,
            hangup_cause: c.hangupCause,
            pbx_node: c.pbxNode,
          });
        }
        if (rows.length > 0) await tx`insert into cdrs ${tx(rows)} on conflict (id) do nothing`;
      }),
    );
  }

  // ---- media ----------------------------------------------------------------------------------

  async getMediaObjectKey(tenantId: string, mediaId: string): Promise<string | null> {
    const [row] = await withRetry(
      () => this.sql<{ objectKey: string }[]>`select object_key from media where id = ${mediaId} and tenant_id = ${tenantId}`,
    );
    return row?.objectKey ?? null;
  }

  /**
   * Record a finished upload. Idempotent: media.id and voicemails.media_id are unique, so
   * re-running after a crash between "uploaded" and "local file deleted" is harmless.
   */
  async saveUploadedRecording(r: {
    mediaId: string;
    tenantId: string;
    kind: 'recording' | 'voicemail';
    objectKey: string;
    durationMs: number;
    callId: string | null;
    mailboxId: string | null;
    callerNumber?: string | null;
  }): Promise<void> {
    await withRetry(() =>
      this.sql.begin(async (tx) => {
        await tx`
          insert into media (id, tenant_id, kind, object_key, format, duration_ms, call_id)
          values (${r.mediaId}, ${r.tenantId}, ${r.kind}, ${r.objectKey}, 'wav', ${r.durationMs}, ${r.callId})
          on conflict (id) do nothing`;
        if (r.kind === 'voicemail' && r.mailboxId) {
          await tx`
            insert into voicemails (tenant_id, mailbox_id, call_id, media_id, caller_number)
            values (${r.tenantId}, ${r.mailboxId}, ${r.callId}, ${r.mediaId}, ${r.callerNumber ?? null})
            on conflict (media_id) do nothing`;
        }
      }),
    );
  }

  // ---- voicemail access (*98) -----------------------------------------------------------------

  /** New (heard=false) or saved (heard=true) messages, oldest first. */
  async listVoicemails(tenantId: string, mailboxId: string, heard: boolean): Promise<VoicemailMsg[]> {
    const rows = await withRetry(
      () => this.sql<VoicemailMsg[]>`
        select v.id, v.media_id, m.object_key, v.caller_number, v.created_at
          from voicemails v join media m on m.id = v.media_id
         where v.tenant_id = ${tenantId} and v.mailbox_id = ${mailboxId} and v.heard = ${heard}
         order by v.created_at, v.id`,
    );
    return [...rows];
  }

  async countVoicemails(tenantId: string, mailboxId: string): Promise<{ new: number; saved: number }> {
    const [r] = await withRetry(
      () => this.sql<{ newCount: string; savedCount: string }[]>`
        select count(*) filter (where not heard) as new_count, count(*) filter (where heard) as saved_count
          from voicemails where tenant_id = ${tenantId} and mailbox_id = ${mailboxId}`,
    );
    return { new: Number(r?.newCount ?? 0), saved: Number(r?.savedCount ?? 0) };
  }

  async saveVoicemail(tenantId: string, id: string): Promise<void> {
    await withRetry(() => this.sql`update voicemails set heard = true where id = ${id} and tenant_id = ${tenantId}`);
  }

  async deleteVoicemail(tenantId: string, id: string): Promise<void> {
    await withRetry(() => this.sql`delete from voicemails where id = ${id} and tenant_id = ${tenantId}`);
  }
}
