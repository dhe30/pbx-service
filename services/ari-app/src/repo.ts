import { parseIvrConfig, withRetry, type CallDisposition, type IvrConfig, type Sql } from '@pbx/shared';

// All SQL used by the ARI app. Queries on the call path are wrapped in withRetry so a Patroni
// failover (connection errors for a few seconds) doesn't fail calls that could still succeed.

export interface InboundRoute {
  phoneNumberId: string;
  tenantId: string;
  menuId: string;
  greetingMediaId: string | null;
  timeoutSec: number;
  maxRetries: number;
  config: IvrConfig;
  recordCalls: boolean;
}

export interface StaffTarget {
  userId: string;
  sipUsername: string;
}

export interface RingGroup {
  strategy: 'all' | 'sequential';
  ringTimeoutSec: number;
  fallbackMailboxId: string | null;
  members: StaffTarget[];
}

export class Repo {
  constructor(private readonly sql: Sql) {}

  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  async findInboundRoute(dids: string[]): Promise<InboundRoute | null> {
    if (dids.length === 0) return null;
    const rows = await withRetry(
      () => this.sql<(Omit<InboundRoute, 'config'> & { config: unknown })[]>`
        select pn.id as phone_number_id, pn.tenant_id, m.id as menu_id, m.greeting_media_id,
               m.timeout_sec, m.max_retries, m.config,
               coalesce(ts.record_calls, false) as record_calls
          from phone_numbers pn
          join ivr_menus m on m.id = pn.ivr_menu_id and m.tenant_id = pn.tenant_id
          left join tenant_settings ts on ts.tenant_id = pn.tenant_id
         where pn.did = any(${dids}) and pn.status = 'assigned'
         limit 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, config: parseIvrConfig(r.config) };
  }

  async insertCall(c: { tenantId: string; phoneNumberId: string; callerNumber: string; pbxNode: string }): Promise<string> {
    const [row] = await withRetry(
      () => this.sql<{ id: string }[]>`
        insert into calls (tenant_id, phone_number_id, caller_number, pbx_node)
        values (${c.tenantId}, ${c.phoneNumberId}, ${c.callerNumber}, ${c.pbxNode})
        returning id`,
    );
    return row!.id;
  }

  async markCallAnswered(callId: string, userId: string): Promise<void> {
    await withRetry(
      () => this.sql`update calls set answered_at = now(), answered_by_user_id = ${userId} where id = ${callId}`,
    );
  }

  async finishCall(callId: string, disposition: CallDisposition): Promise<void> {
    await withRetry(
      () => this.sql`update calls set ended_at = now(), disposition = ${disposition} where id = ${callId}`,
    );
  }

  async getMediaObjectKey(tenantId: string, mediaId: string): Promise<string | null> {
    const [row] = await withRetry(
      () => this.sql<{ objectKey: string }[]>`
        select object_key from media where id = ${mediaId} and tenant_id = ${tenantId}`,
    );
    return row?.objectKey ?? null;
  }

  async getRingGroup(tenantId: string, groupId: string): Promise<RingGroup | null> {
    const [group] = await withRetry(
      () => this.sql<Omit<RingGroup, 'members'>[]>`
        select strategy, ring_timeout_sec, fallback_mailbox_id
          from ring_groups where id = ${groupId} and tenant_id = ${tenantId}`,
    );
    if (!group) return null;
    const members = await withRetry(
      () => this.sql<StaffTarget[]>`
        select u.id as user_id, u.sip_username
          from ring_group_members rgm
          join users u on u.id = rgm.user_id and u.tenant_id = ${tenantId}
         where rgm.ring_group_id = ${groupId} and u.sip_username is not null
         order by rgm.position, u.id`,
    );
    return { ...group, members: [...members] };
  }

  /** A staff user plus the mailbox they own (used as their no-answer fallback). */
  async getStaffUser(tenantId: string, userId: string): Promise<(StaffTarget & { mailboxId: string | null }) | null> {
    const [row] = await withRetry(
      () => this.sql<(StaffTarget & { mailboxId: string | null })[]>`
        select u.id as user_id, u.sip_username,
               (select mb.id from mailboxes mb
                 where mb.owner_user_id = u.id and mb.tenant_id = u.tenant_id
                 order by mb.id limit 1) as mailbox_id
          from users u
         where u.id = ${userId} and u.tenant_id = ${tenantId} and u.sip_username is not null`,
    );
    return row ?? null;
  }

  async getMailbox(tenantId: string, mailboxId: string): Promise<{ id: string; greetingMediaId: string | null } | null> {
    const [row] = await withRetry(
      () => this.sql<{ id: string; greetingMediaId: string | null }[]>`
        select id, greeting_media_id from mailboxes where id = ${mailboxId} and tenant_id = ${tenantId}`,
    );
    return row ?? null;
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
  }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into media (id, tenant_id, kind, object_key, format, duration_ms)
        values (${r.mediaId}, ${r.tenantId}, ${r.kind}, ${r.objectKey}, 'wav', ${r.durationMs})
        on conflict (id) do nothing`;
      if (r.kind === 'voicemail' && r.mailboxId) {
        await tx`
          insert into voicemails (tenant_id, mailbox_id, call_id, media_id)
          values (${r.tenantId}, ${r.mailboxId}, ${r.callId}, ${r.mediaId})
          on conflict (media_id) do nothing`;
      }
      if (r.kind === 'recording' && r.callId) {
        await tx`update calls set recording_media_id = ${r.mediaId} where id = ${r.callId}`;
      }
    });
  }
}
