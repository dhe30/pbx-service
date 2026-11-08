import type { Db, IvrAction, IvrConfig } from '@pbx/shared';
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
//  3. Check every id a request wants to STORE (foreign keys, ids inside ivr_menus.config) with
//     assertOwned() before writing. The schema's foreign keys only check that the row exists, not
//     that it belongs to the same tenant, and the IVR config JSON has no foreign keys at all.

/** Tables that have a tenant_id column. Used as SQL identifiers, so keep this a fixed allowlist. */
export const TENANT_TABLES = [
  'users',
  'media',
  'mailboxes',
  'ring_groups',
  'ivr_menus',
  'phone_numbers',
  'calls',
  'voicemails',
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
export const IdParams = z.object({ id: z.string().uuid() });

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

/** Table each IVR action's `target` points into. */
const IVR_ACTION_TABLE: Record<IvrAction['action'], TenantTable> = {
  ring_group: 'ring_groups',
  voicemail: 'mailboxes',
  user: 'users',
};

/** Every id inside an IVR config, ready for assertOwned(). */
export function ivrConfigRefs(config: IvrConfig, field = 'config'): Ref[] {
  const refs: Ref[] = [];
  for (const [digit, a] of Object.entries(config.options) as [string, IvrAction | undefined][]) {
    if (a) refs.push({ table: IVR_ACTION_TABLE[a.action], id: a.target, field: `${field}.options.${digit}.target` });
  }
  if (config.on_timeout) {
    refs.push({
      table: IVR_ACTION_TABLE[config.on_timeout.action],
      id: config.on_timeout.target,
      field: `${field}.on_timeout.target`,
    });
  }
  return refs;
}

function invalidRef(ref: Ref): HttpError {
  return new HttpError(400, 'invalid_reference', `${ref.field}: no such ${singular(ref.table)}`);
}

const SINGULAR: Record<TenantTable, string> = {
  users: 'user',
  media: 'media file',
  mailboxes: 'mailbox',
  ring_groups: 'ring group',
  ivr_menus: 'IVR menu',
  phone_numbers: 'phone number',
  calls: 'call',
  voicemails: 'voicemail',
};

function singular(table: TenantTable): string {
  return SINGULAR[table];
}
