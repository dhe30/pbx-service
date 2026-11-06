# Backend step 3: tenant isolation

Owner: Aaron (Track 3 backend). Status: done (2026-11-06).

Every business row belongs to one tenant. A logged-in user must never read, change or point at
another tenant's rows. Step 3 adds the helpers and rules that every route from step 4 on follows.
No new endpoints.

## The three rules

1. **Scope every query by tenant.** Take the tenant id only from `tenantOf(req)` (the verified
   access token), never from the URL or body. Every select/update/delete on a tenant-owned table
   includes `tenant_id = ${tenantId}`.
2. **Another tenant's row is "not found" (404), never 403**, so ids can't be probed for
   existence. Unknown and foreign ids get identical responses.
3. **Check every id a request wants to store** with `assertOwned()` before writing, inside the
   same transaction. This is needed because:
   - the schema's foreign keys only check that a row exists, not that it belongs to the same
     tenant (tenant A could otherwise point a ring group at tenant B's mailbox);
   - `ring_group_members` has no `tenant_id` of its own;
   - `ivr_menus.config` is JSON, with no foreign keys at all.

## Helpers (`services/api/src/tenancy.ts`)

| Helper | Use |
|---|---|
| `tenantOf(req)` | The caller's tenant id. Throws (-> 500 + error log) if the route forgot `authenticate`: a route bug fails closed instead of serving data. |
| `IdParams` | zod schema for `:id` params: `const { id } = parse(IdParams, req.params)`. Non-uuid -> 400. |
| `requireOwned(db, tenantId, table, id)` | 404 `not_found` ("No such ring group") unless the row exists and belongs to the tenant. For routes that act on a URL id without reading the row first. |
| `assertOwned(db, tenantId, refs)` | 400 `invalid_reference` naming the field (`members.1: no such user`) unless every ref is owned by the tenant. One query per table. |
| `ivrConfigRefs(config)` | Turns every `target` in an IVR config into refs for `assertOwned` (`config.options.2.target`). |
| `TENANT_TABLES` | Allowlist of tables with a `tenant_id` column. Table names are used as SQL identifiers, so only these are accepted. |

`db` can be the pool (`sql`) or a transaction (`tx`): new shared types `Db` and
`TransactionSql` in `services/shared/src/db.ts`.

## Example: how a step 5 route will look

```ts
app.put('/ring-groups/:id', { preHandler: [authenticate, requireRole('owner')] }, async (req) => {
  const tenantId = tenantOf(req);                          // rule 1: from the token only
  const { id } = parse(IdParams, req.params);
  const body = parse(RingGroupBody, req.body);

  return sql.begin(async (tx) => {
    await assertOwned(tx, tenantId, [                      // rule 3: every stored id
      ...(body.fallbackMailboxId
        ? [{ table: 'mailboxes', id: body.fallbackMailboxId, field: 'fallbackMailboxId' }]
        : []),
      ...body.memberIds.map((uid, i) => ({ table: 'users', id: uid, field: `memberIds.${i}` })),
    ]);
    const [row] = await tx`
      update ring_groups set name = ${body.name}, fallback_mailbox_id = ${body.fallbackMailboxId}
      where id = ${id} and tenant_id = ${tenantId}           -- rule 1
      returning id`;
    if (!row) throw new HttpError(404, 'not_found', 'No such ring group');   // rule 2
    // ... replace ring_group_members ...
    return row;
  });
});
```

## Also changed

- `src/errors.ts`: Postgres `22P02` (malformed value, e.g. `"abc"` for a uuid column) now returns
  400 `invalid_request` instead of 500, as a safety net for routes that forget `IdParams`.

## Design decisions

- **Application-level checks, not Postgres row-level security (RLS).** RLS would need every
  request wrapped in a transaction with a per-request `set_config` (through the pooling local
  HAProxy), plus separate DB roles. The ARI app and Kamailio share these tables, so it would
  touch other tracks' code and Muhammad's DB setup. The helpers above cover the same risks for
  course scope.
- **Check-then-write is safe without locks.** A row's `tenant_id` never changes after creation
  (except `phone_numbers` on release, handled in step 8), and a concurrent delete is caught by
  the foreign key.
- **Possible later hardening (needs a migration, so coordinate first):** composite foreign keys
  such as `(fallback_mailbox_id, tenant_id) -> mailboxes (id, tenant_id)` would make the
  database itself reject cross-tenant references. Not done now because schema changes go through
  one reviewed migration shared with the telephony track.

## Verification

- 38 API tests pass (12 new in `test/tenancy.test.ts`, 8 of them against Postgres with two
  tenants, A and B):
  - a scoped route returns A's row and 404s B's row, identically to a nonexistent id;
  - `requireOwned` / `assertOwned` reject B's ids, unknown ids and malformed ids;
  - an IVR config pointing at B's ring group is rejected with the exact field path;
  - `assertOwned` works inside a transaction before a write;
  - `tenantOf` without `authenticate` is a 500, and it ignores tenant ids in the URL and body;
  - a malformed uuid reaching Postgres is a 400.
- All workspaces type-check; shared (4) and ari-app (8) tests still pass. Test rows are cleaned
  up.

## Gotcha found along the way

`services/shared/dist/` (gitignored, local only) was a stale build from zod 4, while zod 3.25 is
installed, so `IvrAction` and other shared types resolved to `unknown` in the API. Fixed by
rebuilding. **After pulling changes to `services/shared`, run `npm run build -w @pbx/shared`.**
