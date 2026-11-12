import { withRetry, type Sql } from '@pbx/shared';
import type { AuthUser } from './auth.js';
import { HttpError } from './errors.js';

// What a staff member may see of call history and voicemail (backend step 7). The owner sees
// everything in the account. A staff member sees:
//   - calls where one of THEIR extensions (extensions.user_id) called or was called, and the
//     recordings of those calls;
//   - voicemails in mailboxes they own (mailboxes.owner_user_id) or that are the mailbox of one of
//     their extensions.
// Rows outside that are 404, like another account's ids (docs/backend-step3.md rule 2).

/** Extension numbers assigned to the user; null = no restriction (owner). */
export async function visibleExtensions(sql: Sql, auth: AuthUser): Promise<string[] | null> {
  if (!auth.tenantId || auth.role === 'unassigned') {
    throw new HttpError(403, 'business_required', 'Create or join a business before using this endpoint');
  }
  if (auth.role === 'owner') return null;
  const rows = await withRetry(
    () => sql<{ number: string }[]>`
      select number from extensions where tenant_id = ${auth.tenantId} and user_id = ${auth.userId}`,
  );
  return rows.map((r) => r.number);
}

/** Mailbox ids the user may read; null = no restriction (owner). */
export async function visibleMailboxes(sql: Sql, auth: AuthUser): Promise<string[] | null> {
  if (!auth.tenantId || auth.role === 'unassigned') {
    throw new HttpError(403, 'business_required', 'Create or join a business before using this endpoint');
  }
  if (auth.role === 'owner') return null;
  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      select id from mailboxes where tenant_id = ${auth.tenantId} and owner_user_id = ${auth.userId}
      union
      select mailbox_id from extensions
       where tenant_id = ${auth.tenantId} and user_id = ${auth.userId} and mailbox_id is not null`,
  );
  return rows.map((r) => r.id);
}
