import type { FastifyInstance } from 'fastify';
import { z, type AnyZodObject, type ZodTypeAny } from 'zod';
import { ACCESS_COOKIE } from '../auth.js';
import { COMPONENTS, sharedRefs } from './components.js';
import { toJsonSchema, type JsonSchema, type RefMap } from './json-schema.js';

// OpenAPI 3.1 document for GET /openapi.json (course spec: "an OpenAPI 3.1 document at
// /openapi.json"; everything the web does must be possible through the API).
//
// Every route documents itself next to its handler, in the route's `config.openapi`:
//
//   app.get('/mailboxes/:id', { ...ownerOnly, config: { openapi: {
//     tag: 'Mailboxes', summary: 'Get a mailbox', auth: 'owner', params: IdParams,
//     responses: { 200: { description: 'The mailbox', schema: MailboxSchema } }, errors: { 404: '...' },
//   } } }, handler)
//
// The zod schemas the route validates with are converted to JSON Schema, so the document can't
// drift from validation. Response schemas are zod too (documentation only). Field descriptions
// come from `.describe()`. test/openapi.test.ts fails if a route, field or parameter has none.

export type Auth = 'public' | 'user' | 'owner';

export interface ResponseDoc {
  description: string;
  schema?: ZodTypeAny;
  /** Binary (non-JSON) response body: its content type, e.g. 'audio/wav'. */
  binary?: string;
  /** Response headers, name -> description. */
  headers?: Record<string, string>;
}

export interface OperationDoc {
  tag: string;
  summary: string;
  description?: string;
  /** public: no login. user: any logged-in user. owner: the account owner only. */
  auth: Auth;
  params?: AnyZodObject;
  query?: AnyZodObject;
  body?: ZodTypeAny;
  /** File upload instead of a JSON body: raw bytes with one of `contentTypes`, or multipart/form-data. */
  upload?: { description: string; contentTypes: string[]; multipartField: string };
  /** Request headers the operation reads, name -> description. */
  headers?: Record<string, { description: string; required?: boolean }>;
  responses: Record<number, ResponseDoc>;
  /** Route-specific error statuses -> when they happen. 400/401/403/503 are added automatically. */
  errors?: Record<number, string>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    openapi?: OperationDoc;
  }
}

interface CollectedRoute {
  method: string;
  url: string;
  doc: OperationDoc | undefined;
}

export interface OpenApiCollector {
  /** Builds (once) and returns the document. */
  document(): JsonSchema;
  /** Routes registered without `config.openapi` (must be empty; checked by tests). */
  undocumented(): string[];
}

/** Records every route registered after this call. Call in buildApp before registering routes. */
export function collectOpenApi(app: FastifyInstance, info: { title: string; version: string; description: string }): OpenApiCollector {
  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue; // Fastify adds HEAD for every GET
      routes.push({ method, url: route.url, doc: route.config?.openapi });
    }
  });
  let doc: JsonSchema | null = null;
  return {
    document: () => (doc ??= buildDocument(routes, info)),
    undocumented: () => routes.filter((r) => !r.doc).map((r) => `${r.method} ${r.url}`),
  };
}

const STANDARD_ERRORS = {
  400: 'Invalid request: malformed body, query or id (`invalid_request`), or an id that does not exist / belongs to another account (`invalid_reference`). `message` names the field.',
  401: 'Not logged in or the session expired (`unauthorized`). Call POST /auth/refresh once, then retry.',
  403: 'Logged in, but this operation is for the account owner only (`forbidden`).',
  503: 'Database failing over (`unavailable`). Retry after the `Retry-After` seconds.',
};

function buildDocument(routes: CollectedRoute[], info: { title: string; version: string; description: string }): JsonSchema {
  const refs = sharedRefs();
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const { method, url, doc } of routes) {
    if (!doc) continue;
    const path = url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[path] ??= {};
    paths[path]![method.toLowerCase()] = operation(method, url, doc, refs);
    tags.add(doc.tag);
  }
  return {
    openapi: '3.1.0',
    info,
    tags: [...tags].sort().map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? name })),
    paths,
    components: {
      schemas: COMPONENTS,
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: ACCESS_COOKIE,
          description:
            'Access token cookie (15 min), set by POST /auth/signup, /auth/login and /auth/refresh. ' +
            'Keep cookies between requests (a cookie jar). The refresh cookie (pbx_refresh, path /auth) ' +
            'renews it via POST /auth/refresh.',
        },
      },
    },
  };
}

function operation(method: string, url: string, doc: OperationDoc, refs: RefMap): JsonSchema {
  const parameters: JsonSchema[] = [];
  const addParams = (schema: AnyZodObject | undefined, where: 'path' | 'query') => {
    if (!schema) return;
    for (const [name, field] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      const s = toJsonSchema(field, refs);
      const { description, ...rest } = s;
      parameters.push({ name, in: where, required: where === 'path' || !field.isOptional(), description, schema: rest });
    }
  };
  addParams(doc.params, 'path');
  addParams(doc.query, 'query');
  for (const [name, h] of Object.entries(doc.headers ?? {})) {
    parameters.push({ name, in: 'header', required: h.required ?? false, description: h.description, schema: { type: 'string' } });
  }

  const responses: Record<string, unknown> = {};
  for (const [status, r] of Object.entries(doc.responses)) {
    responses[status] = {
      description: r.description,
      ...(r.headers && {
        headers: Object.fromEntries(
          Object.entries(r.headers).map(([h, description]) => [h, { description, schema: { type: 'string' } }]),
        ),
      }),
      ...(r.schema && { content: { 'application/json': { schema: toJsonSchema(r.schema, refs) } } }),
      ...(r.binary && { content: { [r.binary]: { schema: { type: 'string', format: 'binary' } } } }),
    };
  }
  const errors: Record<number, string> = { ...doc.errors };
  if (doc.params || doc.query || doc.body || doc.upload) errors[400] ??= STANDARD_ERRORS[400];
  if (doc.auth !== 'public') errors[401] ??= STANDARD_ERRORS[401];
  if (doc.auth === 'owner') errors[403] ??= STANDARD_ERRORS[403];
  if (doc.tag !== 'Health') errors[503] ??= STANDARD_ERRORS[503];
  for (const [status, description] of Object.entries(errors)) {
    responses[status] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  const who = { public: 'No login needed.', user: 'Any logged-in user.', owner: 'Account owner only.' }[doc.auth];
  return {
    operationId: operationId(method, url),
    tags: [doc.tag],
    summary: doc.summary,
    description: doc.description ? `${doc.description}\n\n${who}` : who,
    ...(doc.auth !== 'public' && { security: [{ cookieAuth: [] }] }),
    ...(doc.auth === 'public' && { security: [] }),
    ...(parameters.length && { parameters }),
    ...(doc.body && {
      requestBody: {
        required: !doc.body.isOptional(),
        content: { 'application/json': { schema: toJsonSchema(doc.body, refs) } },
      },
    }),
    ...(doc.upload && { requestBody: uploadBody(doc.upload) }),
    responses,
  };
}

function uploadBody(u: NonNullable<OperationDoc['upload']>): JsonSchema {
  const file = { type: 'string', format: 'binary', description: u.description };
  return {
    required: true,
    description: u.description,
    content: {
      ...Object.fromEntries(u.contentTypes.map((ct) => [ct, { schema: file }])),
      'multipart/form-data': {
        schema: { type: 'object', properties: { [u.multipartField]: file }, required: [u.multipartField] },
      },
    },
  };
}

/** GET /mailboxes/:id -> getMailboxesById. Stable and unique per method + path. */
function operationId(method: string, url: string): string {
  const words = url
    .split('/')
    .filter(Boolean)
    .map((p) => (p.startsWith(':') ? `by-${p.slice(1)}` : p))
    .join('-')
    .split(/[-_.]/)
    .filter(Boolean);
  return method.toLowerCase() + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  Health: 'Liveness, readiness and metrics (used by load balancers and monitoring).',
  Auth: 'Signup, login, sessions and the current user.',
  Billing: 'Saved card, plan and prices.',
  Staff: 'Dashboard logins for employees, and SIP credentials for the softphone.',
  Extensions: 'Extensions: number, SIP account, voicemail box, forwarding, external numbers.',
  Mailboxes: 'Voicemail boxes.',
  'Ring groups': 'Groups of extensions rung at once or in order.',
  'IVR menus': 'Auto-attendant menus: greeting and what each key does.',
  Numbers: "Search, buy, route and release the account's phone numbers.",
  'Business hours': 'Weekly schedules that route calls differently when open or closed.',
  Blocklist: 'Caller numbers that are rejected.',
  Calls: 'Call history (one row per call leg) and call recordings.',
  Voicemail: 'Voicemail inbox: listen, mark heard or new, delete.',
  Settings: 'Active add-ons and plan allowances.',
  Media: 'Audio files: uploaded greetings, call recordings and voicemail messages (8 kHz mono WAV).',
};

/** Route options with OpenAPI docs: `app.get(url, withDoc(ownerOnly, {...}), handler)`. */
export function withDoc<T extends object>(opts: T, openapi: OperationDoc): T & { config: { openapi: OperationDoc } } {
  return { ...opts, config: { openapi } };
}

/**
 * Docs for the usual five routes of a resource (list, get, create, replace, delete).
 * `schema` is the response object, `body` the create/replace body.
 */
export function crudDocs(o: {
  tag: string;
  noun: string;
  plural: string;
  schema: ZodTypeAny;
  body: ZodTypeAny;
  params: AnyZodObject;
  listOrder: string;
  auth?: { read: Auth; write: Auth };
  createErrors?: Record<number, string>;
  replaceErrors?: Record<number, string>;
  deleteDescription?: string;
  deleteErrors?: Record<number, string>;
}): Record<'list' | 'get' | 'create' | 'replace' | 'remove', OperationDoc> {
  const read = o.auth?.read ?? 'owner';
  const write = o.auth?.write ?? 'owner';
  const notFound = { 404: `No such ${o.noun} in this account (\`not_found\`).` };
  return {
    list: {
      tag: o.tag,
      auth: read,
      summary: `List ${o.plural}`,
      description: `All ${o.plural} of the account, ${o.listOrder}.`,
      responses: { 200: { description: `The ${o.plural}`, schema: z.array(o.schema).describe(`The ${o.plural}.`) } },
    },
    get: {
      tag: o.tag,
      auth: read,
      summary: `Get a ${o.noun}`,
      params: o.params,
      responses: { 200: { description: `The ${o.noun}`, schema: o.schema } },
      errors: notFound,
    },
    create: {
      tag: o.tag,
      auth: write,
      summary: `Create a ${o.noun}`,
      body: o.body,
      responses: { 201: { description: `The created ${o.noun}`, schema: o.schema } },
      errors: o.createErrors,
    },
    replace: {
      tag: o.tag,
      auth: write,
      summary: `Replace a ${o.noun}`,
      description: 'Full replace: omitted optional fields go back to their defaults. Send the whole object as returned by GET.',
      params: o.params,
      body: o.body,
      responses: { 200: { description: `The updated ${o.noun}`, schema: o.schema } },
      errors: { ...notFound, ...o.replaceErrors },
    },
    remove: {
      tag: o.tag,
      auth: write,
      summary: `Delete a ${o.noun}`,
      description: o.deleteDescription,
      params: o.params,
      responses: { 204: { description: 'Deleted' } },
      errors: { ...notFound, ...o.deleteErrors },
    },
  };
}

export const IN_USE = 'Still used by call routing (`in_use`); `message` names what uses it. Change those first.';
