import type { Db, IvrAction } from '@pbx/shared';
import { HttpError } from './errors.js';
import type { Ref } from './tenancy.js';

// Reference checks beyond "same tenant" (assertOwned in tenancy.ts), and "still in use" checks
// for deletes. See docs/backend-step5.md.
//
// Save side: assertOwned() locks every referenced row FOR SHARE.
// Delete side: lock the row FOR UPDATE, then look for references and refuse with 409 `in_use`.
// Either the save waits for the delete (then fails its reference check) or the delete waits for
// the save (then sees the new reference). No dangling references either way.
//
// Why refuse instead of letting the database clean up: ivr_menus.config references users,
// mailboxes and ring groups in JSON (no foreign keys), and the ARI app hangs up on a caller when
// an IVR target is missing. Foreign keys with ON DELETE SET NULL (ring group fallback mailbox,
// number -> IVR menu) would likewise silently turn "go to voicemail" into "hang up".

/**
 * 400 unless `mediaId` (if set) is one of the tenant's greetings. Recordings and voicemails are
 * media rows too, but must not be played as a menu or mailbox greeting.
 */
export async function assertGreeting(db: Db, tenantId: string, mediaId: string | null, field: string): Promise<void> {
  if (mediaId === null) return;
  const rows = await db`
    select 1 from media where id = ${mediaId} and tenant_id = ${tenantId} and kind = 'greeting'
       for share`;
  if (rows.length === 0) throw new HttpError(400, 'invalid_reference', `${field}: no such greeting`);
}

/**
 * 400 unless every user ref can actually be rung, i.e. has a SIP account (staff). The ARI app
 * skips members without one and hangs up on an IVR "user" target without one.
 * Run after assertOwned (which already checked the tenant and locked the rows).
 */
export async function assertRingable(db: Db, tenantId: string, refs: readonly Ref[]): Promise<void> {
  const userRefs = refs.filter((r) => r.table === 'users');
  if (userRefs.length === 0) return;
  const ids = [...new Set(userRefs.map((r) => r.id))];
  const found = await db<{ id: string }[]>`
    select id from users
     where tenant_id = ${tenantId} and id = any(${ids}::uuid[]) and sip_username is not null`;
  const ringable = new Set(found.map((r) => r.id));
  const bad = userRefs.find((r) => !ringable.has(r.id));
  if (bad) {
    throw new HttpError(400, 'invalid_reference', `${bad.field}: user has no softphone (only staff can be called)`);
  }
}

/** Names of the tenant's IVR menus whose config routes to `target` with `action`. */
export async function menusUsing(db: Db, tenantId: string, action: IvrAction['action'], target: string): Promise<string[]> {
  const rows = await db<{ name: string }[]>`
    select name from ivr_menus
     where tenant_id = ${tenantId}
       and jsonb_path_exists(config, '$.** ? (@.action == $action && @.target == $target)',
                             jsonb_build_object('action', ${action}::text, 'target', ${target}::text))
     order by name, id`;
  return rows.map((r) => r.name);
}

/** What is still using a row, e.g. `IVR menu "Main"`, `ring group "Sales"`. */
export interface Usage {
  kind: string;
  name: string;
}

export const usages = (kind: string, names: readonly string[]): Usage[] => names.map((name) => ({ kind, name }));

/** Throws 409 `in_use` naming every user of the row, if there are any. */
export function refuseIfUsed(found: readonly Usage[]): void {
  if (found.length === 0) return;
  const list = found.map((u) => `${u.kind} "${u.name}"`).join(', ');
  throw new HttpError(409, 'in_use', `Used by ${list}; change ${found.length > 1 ? 'those' : 'that'} first`);
}
