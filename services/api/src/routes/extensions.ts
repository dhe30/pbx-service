import { randomBytes } from 'node:crypto';
import { ForwardDestinationSchema, withRetry, type Db, type ForwardDestination, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { destinationUsages, refuseIfUsed } from '../references.js';
import { IdParams, assertOwned, destinationRefs, tenantOf, type Ref } from '../tenancy.js';
import { name, nullableId, parse } from '../validation.js';
import { IN_USE, crudDocs, withDoc } from '../openapi/document.js';

// Extensions (course spec §3): "Number unique in the account (e.g. 101), name, SIP username and
// password (returned by your API), voicemail box, and forwarding (always, busy, no answer) to an
// extension or external number. Any number of phones register ..."
// Contract with the call path: docs/telephony-contract.md §2.
//
// GET    /extensions          any user   200 [extension]   sorted by number (sipPassword: owner only)
// GET    /extensions/:id      any user   200 extension     404
// POST   /extensions          owner      201 extension     400, 402 payment_required, 409 number_taken | extension_limit
// PUT    /extensions/:id      owner      200 extension     400, 404, 409 number_taken
// DELETE /extensions/:id      owner      204               404, 409 in_use (something routes to it, or it is a
//                                                                     ring group's only member)
//
// extension = { id, number, name, sipUsername, sipPassword, mailboxId, ringTimeoutSec,
//               forwardAlways, forwardBusy, forwardNoAnswer, externalNumbers, callerIdNumber, userId }
//
// The SIP account is a kamailio.subscriber row written in the SAME transaction as the extension
// (tenant_id/extension_id on it keep the account's calls on one pbx node). Kamailio authenticates
// every REGISTER/INVITE against it (auth_db calculate_ha1=yes reads the plaintext password).
// Desk phones register as <sipUsername>@<SIP_DOMAIN> (found via the _sip._udp / _sips._tcp SRV
// records); the softphone gets the same credentials from GET /me/sip-credentials.

export interface ExtensionOptions {
  sql: Sql;
  /** SIP_DOMAIN: must equal Ansible's `sip_domain` (subscriber rows, Kamailio alias). */
  sipDomain: string;
}

const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'must be an E.164 number, e.g. +12015550123');

const ExtensionBody = z.object({
  number: z.string().regex(/^[0-9]{1,8}$/, 'must be 1-8 digits').describe('Extension number: 1-8 digits, unique in the account.'),
  name,
  /**
   * Voicemail box. Omitted on create: a mailbox "<name> (<number>)" is created for it. null: no
   * voicemail (unanswered calls hang up unless forwarded). On PUT, omitted = keep the current one.
   */
  mailboxId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Voicemail box. Omitted on create: a new mailbox is created. null: no voicemail. Omitted on replace: unchanged.'),
  // Same bounds as the CHECK constraint on extensions.ring_timeout_sec.
  ringTimeoutSec: z.number().int().min(5).max(120).default(20).describe('Seconds to ring before no-answer handling.'),
  forwardAlways: ForwardDestinationSchema.nullable().default(null).describe('Forward every call (phones do not ring). null = off.'),
  forwardBusy: ForwardDestinationSchema.nullable().default(null).describe('Forward when busy. null = off.'),
  forwardNoAnswer: ForwardDestinationSchema.nullable().default(null).describe('Forward when not answered. null = off (voicemail).'),
  /** Rung together with the extension's devices; each is a charged outgoing leg. */
  externalNumbers: z
    .array(e164.describe('E.164 number.'))
    .max(10)
    .default([])
    .refine((n) => new Set(n).size === n.length, 'must not contain duplicates')
    .describe('Up to 10 external numbers rung together with the phones (each a billed outgoing call).'),
  /** Caller ID for outgoing calls: must be one of the account's numbers. */
  callerIdNumber: e164.nullable().default(null).describe("Caller ID for outgoing calls: one of the account's numbers. null = the account's first number."),
  /** Web user whose softphone uses this extension by default. */
  userId: nullableId.describe('Web user whose softphone uses this extension by default. null = none.'),
});
type ExtensionBody = z.infer<typeof ExtensionBody>;

export interface Extension {
  id: string;
  number: string;
  name: string;
  sipUsername: string;
  sipPassword?: string;
  mailboxId: string | null;
  ringTimeoutSec: number;
  forwardAlways: ForwardDestination | null;
  forwardBusy: ForwardDestination | null;
  forwardNoAnswer: ForwardDestination | null;
  externalNumbers: string[];
  callerIdNumber: string | null;
  userId: string | null;
}

/**
 * Generated SIP username: "x" + 16 hex chars. Globally unique (one SIP domain for every account,
 * Kamailio looks users up by username only), so it can't be the per-account extension number.
 * Letters + digits only: it ends up in Asterisk dial strings (PJSIP/<username>@edge-a).
 */
const newSipUsername = () => `x${randomBytes(8).toString('hex')}`;
/** 24 chars of base64url (144 bits). Fits subscriber.password VARCHAR(64). */
const newSipPassword = () => randomBytes(18).toString('base64url');

const notFound = () => new HttpError(404, 'not_found', 'No such extension');

/** Extensions with their SIP password. `id` null = all of the tenant's. */
export function selectExtensions(db: Db, tenantId: string, sipDomain: string, id: string | null) {
  return db<(Extension & { sipPassword: string })[]>`
    select e.id, e.number, e.name, e.sip_username, s.password as sip_password, e.mailbox_id,
           e.ring_timeout_sec, e.forward_always, e.forward_busy, e.forward_no_answer,
           e.external_numbers, e.caller_id_number, e.user_id
      from extensions e
      left join kamailio.subscriber s on s.username = e.sip_username and s.domain = ${sipDomain}
     where e.tenant_id = ${tenantId} ${id ? db`and e.id = ${id}` : db``}
     order by length(e.number), e.number`;
}

/** Owners see SIP passwords (spec: returned by the API); other users get them via /me/sip-credentials. */
function present(req: FastifyRequest, ext: Extension & { sipPassword: string }): Extension {
  if (req.auth?.role === 'owner') return ext;
  const { sipPassword: _secret, ...rest } = ext;
  return rest;
}

async function checkRefs(tx: Db, tenantId: string, body: ExtensionBody): Promise<void> {
  const refs: Ref[] = [
    ...destinationRefs(body.forwardAlways, 'forwardAlways'),
    ...destinationRefs(body.forwardBusy, 'forwardBusy'),
    ...destinationRefs(body.forwardNoAnswer, 'forwardNoAnswer'),
  ];
  if (body.mailboxId) refs.push({ table: 'mailboxes', id: body.mailboxId, field: 'mailboxId' });
  if (body.userId) refs.push({ table: 'users', id: body.userId, field: 'userId' });
  await assertOwned(tx, tenantId, refs);
  if (body.callerIdNumber) {
    const [n] = await tx`
      select 1 from phone_numbers
       where tenant_id = ${tenantId} and did = ${body.callerIdNumber} and status = 'assigned'`;
    if (!n) throw new HttpError(400, 'invalid_reference', "callerIdNumber: not one of the account's numbers");
  }
}

/**
 * Course spec §2 / billing-flows §3: "The API must refuse to create more than the plan includes
 * plus the extensions bought", and the plan must be paid (signup card) before extensions are
 * added. Locks the account's settings row so concurrent creates can't both take the last slot.
 */
async function assertCanAddExtension(tx: Db, tenantId: string): Promise<void> {
  const [limits] = await tx<{ allowed: number; planPaidThrough: Date | null }[]>`
    select ts.included_extensions + ts.extra_extensions as allowed, ba.plan_paid_through
      from tenant_settings ts
      left join billing_accounts ba on ba.tenant_id = ts.tenant_id
     where ts.tenant_id = ${tenantId}
       for update of ts`;
  if (!limits?.planPaidThrough) {
    throw new HttpError(402, 'payment_required', 'Save a card and pay the plan first (POST /billing/card)');
  }
  const [{ used }] = (await tx`select count(*)::int as used from extensions where tenant_id = ${tenantId}`) as unknown as [
    { used: number },
  ];
  if (used >= limits.allowed) {
    throw new HttpError(
      409,
      'extension_limit',
      `Your plan allows ${limits.allowed} extensions and all are in use; buy an additional extension or delete one`,
    );
  }
}

const json = (tx: Db, v: ForwardDestination | null) => (v ? tx.json(v) : null);

function numberTaken(err: unknown): never | void {
  if (isUniqueViolation(err, 'extensions_tenant_id_number_key')) {
    throw new HttpError(409, 'number_taken', 'Another extension already has this number');
  }
}

const ExtensionSchema = z
  .object({
    id: z.string().uuid().describe('Extension id.'),
    number: z.string().describe('Extension number, unique in the account (dial it from any phone of the account).'),
    name: z.string().describe('Display name.'),
    sipUsername: z.string().describe('SIP username for phones (register at the SIP domain; SRV records point to us).'),
    sipPassword: z.string().optional().describe('SIP password. Only returned to the account owner.'),
    mailboxId: z.string().uuid().nullable().describe('Voicemail box for unanswered calls and *98; null = none.'),
    ringTimeoutSec: z.number().int().describe('Seconds to ring before no-answer handling.'),
    forwardAlways: ForwardDestinationSchema.nullable().describe('Forward every call (phones do not ring); null = off.'),
    forwardBusy: ForwardDestinationSchema.nullable().describe('Forward when busy; null = off.'),
    forwardNoAnswer: ForwardDestinationSchema.nullable().describe('Forward when not answered (before voicemail); null = off.'),
    externalNumbers: z.array(z.string().describe('E.164 number.')).describe('External numbers rung together with the phones.'),
    callerIdNumber: z.string().nullable().describe("Caller ID for outgoing calls (one of the account's numbers); null = the account's first number."),
    userId: z.string().uuid().nullable().describe('Web user whose softphone uses this extension by default.'),
  })
  .describe('An extension.');

const docs = crudDocs({
  tag: 'Extensions',
  noun: 'extension',
  plural: 'extensions',
  schema: ExtensionSchema,
  body: ExtensionBody,
  params: IdParams,
  listOrder: 'sorted by number',
  auth: { read: 'user', write: 'owner' },
  createErrors: {
    402: 'The plan is not paid yet (`payment_required`): save a card first (POST /billing/card).',
    409: 'Another extension already has this number (`number_taken`), or the plan limit is reached (`extension_limit`; see GET /billing).',
  },
  replaceErrors: { 409: 'Another extension already has this number (`number_taken`).' },
  deleteDescription: 'Deletes its SIP account (its phones stop working). Its mailbox and voicemails stay.',
  deleteErrors: {
    409: `${IN_USE} (numbers, IVR digits, ring groups, business hours, other extensions' forwarding, or a ring group it is the only member of).`,
  },
});
docs.create.description = 'Creates the extension, its SIP account and (unless mailboxId is given) a mailbox, in one step.';

export const extensionRoutes: FastifyPluginAsync<ExtensionOptions> = async (app, { sql, sipDomain }) => {
  const anyUser = { preHandler: [authenticate] };
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/extensions', withDoc(anyUser, docs.list), async (req) => {
    const rows = await withRetry(() => selectExtensions(sql, tenantOf(req), sipDomain, null));
    return rows.map((r) => present(req, r));
  });

  app.get('/extensions/:id', withDoc(anyUser, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(() => selectExtensions(sql, tenantOf(req), sipDomain, id));
    if (!row) throw notFound();
    return present(req, row);
  });

  app.post('/extensions', withDoc(ownerOnly, docs.create), async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(ExtensionBody, req.body);
    // A username collision (2^64 space) is practically impossible, but cheap to handle.
    for (let attempt = 1; ; attempt++) {
      const sipUsername = newSipUsername();
      try {
        const ext = await withRetry(() =>
          sql.begin(async (tx) => {
            await assertCanAddExtension(tx, tenantId);
            await checkRefs(tx, tenantId, body);
            let mailboxId = body.mailboxId ?? null;
            if (body.mailboxId === undefined) {
              const [mb] = await tx<{ id: string }[]>`
                insert into mailboxes (tenant_id, name) values (${tenantId}, ${`${body.name} (${body.number})`})
                returning id`;
              mailboxId = mb!.id;
            }
            const [created] = await tx<{ id: string }[]>`
              insert into extensions (tenant_id, number, name, sip_username, mailbox_id, ring_timeout_sec,
                                      forward_always, forward_busy, forward_no_answer, external_numbers,
                                      caller_id_number, user_id)
              values (${tenantId}, ${body.number}, ${body.name}, ${sipUsername}, ${mailboxId}, ${body.ringTimeoutSec},
                      ${json(tx, body.forwardAlways)}, ${json(tx, body.forwardBusy)}, ${json(tx, body.forwardNoAnswer)},
                      ${body.externalNumbers}, ${body.callerIdNumber}, ${body.userId})
              returning id`;
            await tx`
              insert into kamailio.subscriber (username, domain, password, tenant_id, extension_id)
              values (${sipUsername}, ${sipDomain}, ${newSipPassword()}, ${tenantId}, ${created!.id})`;
            const [row] = await selectExtensions(tx, tenantId, sipDomain, created!.id);
            return row!;
          }),
        );
        req.log.info({ tenantId, extensionId: ext.id, number: ext.number }, 'extension created');
        return reply.status(201).send(ext);
      } catch (err) {
        numberTaken(err);
        const usernameTaken =
          isUniqueViolation(err, 'extensions_sip_username_key') || isUniqueViolation(err, 'subscriber_account_idx');
        if (usernameTaken && attempt < 3) continue;
        throw err;
      }
    }
  });

  app.put('/extensions/:id', withDoc(ownerOnly, docs.replace), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(ExtensionBody, req.body);
    try {
      return await withRetry(() =>
        sql.begin(async (tx) => {
          await checkRefs(tx, tenantId, body);
          const [updated] = await tx`
            update extensions
               set number = ${body.number}, name = ${body.name},
                   mailbox_id = ${body.mailboxId === undefined ? tx`mailbox_id` : body.mailboxId},
                   ring_timeout_sec = ${body.ringTimeoutSec},
                   forward_always = ${json(tx, body.forwardAlways)}, forward_busy = ${json(tx, body.forwardBusy)},
                   forward_no_answer = ${json(tx, body.forwardNoAnswer)}, external_numbers = ${body.externalNumbers},
                   caller_id_number = ${body.callerIdNumber}, user_id = ${body.userId}
             where id = ${id} and tenant_id = ${tenantId}
            returning id`;
          if (!updated) throw notFound();
          const [row] = await selectExtensions(tx, tenantId, sipDomain, id);
          return row!;
        }),
      );
    } catch (err) {
      numberTaken(err);
      throw err;
    }
  });

  app.delete('/extensions/:id', withDoc(ownerOnly, docs.remove), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [ext] = await tx<{ sipUsername: string }[]>`
          select sip_username from extensions where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!ext) throw notFound();
        // Numbers, IVR digits, business hours, ring group no-answer or another extension's
        // forwarding may route here; the ARI app would hang up on those callers. Refuse. Same for
        // a ring group it is the only member of: the group would ring nobody.
        const soleMemberOf = await tx<{ name: string }[]>`
          select g.name from ring_groups g join ring_group_members m on m.ring_group_id = g.id
           where g.tenant_id = ${tenantId} and m.extension_id = ${id}
             and not exists (select 1 from ring_group_members o where o.ring_group_id = g.id and o.extension_id <> ${id})
           order by g.name, g.id`;
        refuseIfUsed([
          ...(await destinationUsages(tx, tenantId, 'extension', id)),
          ...soleMemberOf.map((g) => ({ kind: 'ring group', name: g.name, note: 'its only member' })),
        ]);
        // Its devices can't authenticate any more; existing registrations (in Kamailio memory)
        // expire within max_expires, and the ARI app stops ringing it as soon as its cache drops
        // the account (NOTIFY). Memberships in ring groups that have other members cascade; its
        // mailbox (and voicemails) stay.
        await tx`delete from kamailio.subscriber where username = ${ext.sipUsername}`;
        await tx`delete from extensions where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );
    req.log.info({ tenantId, extensionId: id }, 'extension deleted');
    return reply.status(204).send();
  });
};
