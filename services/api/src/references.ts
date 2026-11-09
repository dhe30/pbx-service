import type { Db } from '@pbx/shared';
import { HttpError } from './errors.js';
import type { DestinationWithId } from './tenancy.js';

// Reference checks beyond "same tenant" (assertOwned in tenancy.ts), and "still in use" checks
// for deletes. See docs/backend-step5.md.
//
// Save side: assertOwned() locks every referenced row FOR SHARE.
// Delete side: lock the row FOR UPDATE, then look for references and refuse with 409 `in_use`.
// Either the save waits for the delete (then fails its reference check) or the delete waits for
// the save (then sees the new reference). No dangling references either way.
//
// Why refuse instead of letting the database clean up: call routing stores Destinations
// ({"type","id"}) in JSON with no foreign keys (IVR configs, number routing, ring group no-answer,
// business hours, extension forwarding), and the ARI app hangs up on a caller when a target is
// missing. Foreign keys with ON DELETE SET NULL (extension mailbox, number -> IVR menu) would
// likewise silently turn "go to voicemail" into "hang up".

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

/** Every place a Destination (`{"type": ..., "id": ...}`) can be stored. */
const DEST_PATH = '$.** ? (@.type == $type && @.id == $id)';

/**
 * Everything of the tenant that routes calls to `{type, id}`: IVR menu options/timeout/invalid,
 * number routing, ring group no-answer, business hours open/closed, extension forwarding.
 * The phase-1 IVR format ({action, target}) is matched too, until old rows are re-saved.
 */
export async function destinationUsages(db: Db, tenantId: string, type: DestinationWithId, id: string): Promise<Usage[]> {
  // jsonpath variables, bound as one jsonb parameter (an object; a pre-stringified JSON string
  // would be serialized again and arrive as a JSON *string*).
  const vars = db.json({ type, id });
  const legacyAction = { ring_group: 'ring_group', voicemail: 'voicemail' }[type as string];
  const [menus, numbers, groups, hours, exts] = await Promise.all([
    db<{ name: string }[]>`
      select name from ivr_menus
       where tenant_id = ${tenantId}
         and (jsonb_path_exists(config, ${DEST_PATH}::jsonpath, ${vars})
              ${legacyAction ? db`or jsonb_path_exists(config, '$.** ? (@.action == $a && @.target == $t)',
                                     jsonb_build_object('a', ${legacyAction}::text, 't', ${id}::text))` : db``})
       order by name, id`,
    db<{ name: string }[]>`
      select did as name from phone_numbers
       where tenant_id = ${tenantId}
         and (jsonb_path_exists(coalesce(destination, '{}'), ${DEST_PATH}::jsonpath, ${vars})
              ${type === 'ivr_menu' ? db`or (destination is null and ivr_menu_id = ${id})` : db``})
       order by did`,
    db<{ name: string }[]>`
      select name from ring_groups
       where tenant_id = ${tenantId}
         and jsonb_path_exists(coalesce(no_answer_destination, '{}'), ${DEST_PATH}::jsonpath, ${vars})
       order by name, id`,
    db<{ name: string }[]>`
      select name from business_hours
       where tenant_id = ${tenantId}
         and (jsonb_path_exists(open_destination, ${DEST_PATH}::jsonpath, ${vars})
              or jsonb_path_exists(closed_destination, ${DEST_PATH}::jsonpath, ${vars}))
       order by name, id`,
    db<{ name: string }[]>`
      select number as name from extensions
       where tenant_id = ${tenantId}
         and (jsonb_path_exists(coalesce(forward_always, '{}'), ${DEST_PATH}::jsonpath, ${vars})
              or jsonb_path_exists(coalesce(forward_busy, '{}'), ${DEST_PATH}::jsonpath, ${vars})
              or jsonb_path_exists(coalesce(forward_no_answer, '{}'), ${DEST_PATH}::jsonpath, ${vars})
              ${type === 'voicemail' ? db`or mailbox_id = ${id}` : db``})
       order by number`,
  ]);
  return [
    ...usages('IVR menu', menus.map((r) => r.name)),
    ...usages('phone number', numbers.map((r) => r.name)),
    ...usages('ring group', groups.map((r) => r.name)),
    ...usages('business hours', hours.map((r) => r.name)),
    ...usages('extension', exts.map((r) => r.name)),
  ];
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
