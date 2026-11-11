import type { Db, Destination, IvrConfig } from '@pbx/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors.js';

// Tenant isolation (backend step 3). Every business row belongs to exactly one tenant, and a
// logged-in user must never read, change or point at another tenant's rows.
//
// Enforced in the application (not Postgres row-level security), with three rules every route
// follows. See docs/backend-step3.md for why and for examples.
//
//  1. Scope every query by tenant: take the tenant id ONLY from tenantOf(req) (the verified JWT),
//     never from the URL or body, and include `tenant_id = ${tenantId}` in every
//     select/update/delete on a tenant-owned table.
//  2. Another tenant's row is "not found" (404), never 403, so ids can't be probed for existence.
//     requireOwned() does this for a single id.
//  3. Check every id a request wants to STORE (foreign keys, ids inside Destination JSON) with
//     assertOwned() before writing. The schema's foreign keys only check that the row exists, not
//     that it belongs to the same tenant, and Destination JSON (IVR configs, number routing, ring
//     group no-answer, forwarding) has no foreign keys at all.

/** Tables that have a tenant_id column. Used as SQL identifiers, so keep this a fixed allowlist. */
export const TENANT_TABLES = [
  'users',
  'media',
  'mailboxes',
  'extensions',
  'ring_groups',
  'ivr_menus',
  'business_hours',
  'phone_numbers',
  'cdrs',
  'voicemails',
  'support_tickets',
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

/**
 * The caller's tenant id, from the verified access token. The route must use `authenticate`;
 * if it doesn't, this throws a plain Error (-> 500 and an error log) instead of serving data,
 * because that's a bug in the route, not a client mistake.
 */
export function tenantOf(req: FastifyRequest): string {
  if (!req.auth) {
    throw new Error(`tenantOf() used without authenticate on ${req.method} ${req.routeOptions.url}`);
  }
  return req.auth.tenantId;
}

/** `:id` route params: `const { id } = parse(IdParams, req.params)`. Not a uuid -> 400. */
export const IdParams = z.object({ id: z.string().uuid().describe('Id of the resource (uuid).') });

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/**
 * 404 unless `id` is a row of `table` owned by `tenantId`. For routes that act on one row by URL
 * id but don't otherwise read it first (e.g. adding a member to /ring-groups/:id).
 * Pass a transaction (`tx`) when the check guards a write in that transaction.
 */
export async function requireOwned(sql: Db, tenantId: string, table: TenantTable, id: string): Promise<void> {
  const notFound = new HttpError(404, 'not_found', `No such ${singular(table)}`);
  if (!isUuid(id)) throw notFound;
  const rows = await sql`select 1 from ${sql(table)} where id = ${id} and tenant_id = ${tenantId}`;
  if (rows.length === 0) throw notFound;
}

/** An id a request wants to store, and the request field it came from (for the error message). */
export interface Ref {
  table: TenantTable;
  id: string;
  field: string;
}

/**
 * 400 `invalid_reference` unless every ref is a row owned by `tenantId`. One query per table.
 * Unknown ids and other tenants' ids get the same answer. Call it inside the write's transaction
 * (pass `tx`) right before the insert/update.
 *
 * The referenced rows are locked FOR SHARE until that transaction ends. Delete routes that refuse
 * to delete a row still in use lock it FOR UPDATE first (see src/references.ts), so a save and a
 * delete running at the same time can't both succeed and leave a dangling reference.
 */
export async function assertOwned(sql: Db, tenantId: string, refs: readonly Ref[]): Promise<void> {
  const byTable = new Map<TenantTable, Ref[]>();
  for (const ref of refs) {
    if (!isUuid(ref.id)) throw invalidRef(ref);
    byTable.set(ref.table, [...(byTable.get(ref.table) ?? []), ref]);
  }
  for (const [table, tableRefs] of byTable) {
    const ids = [...new Set(tableRefs.map((r) => r.id))];
    const found = await sql<{ id: string }[]>`
      select id from ${sql(table)} where tenant_id = ${tenantId} and id = any(${ids}::uuid[])
         for share`;
    const owned = new Set(found.map((r) => r.id));
    const missing = tableRefs.find((r) => !owned.has(r.id));
    if (missing) throw invalidRef(missing);
  }
}

/**
 * Table each Destination type's `id` points into (external / hangup carry no id). Destinations
 * are the call-routing JSON shared with the ARI app (DestinationSchema in services/shared).
 */
export const DESTINATION_TABLE = {
  extension: 'extensions',
  ring_group: 'ring_groups',
  ivr_menu: 'ivr_menus',
  voicemail: 'mailboxes',
  business_hours: 'business_hours',
} as const satisfies Partial<Record<Destination['type'], TenantTable>>;
export type DestinationWithId = keyof typeof DESTINATION_TABLE;

/** The id a Destination stores, as a Ref for assertOwned() (none for external / hangup). */
export function destinationRefs(dest: Destination | null | undefined, field: string): Ref[] {
  if (!dest || !('id' in dest)) return [];
  return [{ table: DESTINATION_TABLE[dest.type], id: dest.id, field: `${field}.id` }];
}

/** Every id inside an IVR config (options, timeout, invalid), ready for assertOwned(). */
export function ivrConfigRefs(config: IvrConfig, field = 'config'): Ref[] {
  const refs: Ref[] = [];
  for (const [digit, d] of Object.entries(config.options) as [string, Destination | undefined][]) {
    refs.push(...destinationRefs(d, `${field}.options.${digit}`));
  }
  refs.push(...destinationRefs(config.timeout, `${field}.timeout`));
  refs.push(...destinationRefs(config.invalid, `${field}.invalid`));
  return refs;
}

function invalidRef(ref: Ref): HttpError {
  return new HttpError(400, 'invalid_reference', `${ref.field}: no such ${singular(ref.table)}`);
}

const SINGULAR: Record<TenantTable, string> = {
  users: 'user',
  media: 'media file',
  mailboxes: 'mailbox',
  extensions: 'extension',
  ring_groups: 'ring group',
  ivr_menus: 'IVR menu',
  business_hours: 'business hours schedule',
  phone_numbers: 'phone number',
  cdrs: 'call record',
  voicemails: 'voicemail',
  support_tickets: 'support ticket',
};

function singular(table: TenantTable): string {
  return SINGULAR[table];
}
