import { describe, expect, it } from 'vitest';
import { build } from './helpers.js';

// Course spec: "an OpenAPI 3.1 document at /openapi.json", with a description for every
// operation, parameter and field. These tests keep it complete as routes are added.

type Json = Record<string, unknown>;

/** Every place in a JSON Schema that describes a value but has no description. */
function missingDescriptions(schema: unknown, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Json;
  if (s.properties) {
    for (const [key, prop] of Object.entries(s.properties as Json)) {
      const p = prop as Json;
      if (!p.description) out.push(`${path}.${key}`);
      missingDescriptions(p, `${path}.${key}`, out);
    }
  }
  for (const k of ['items', 'additionalProperties']) {
    if (s[k] && typeof s[k] === 'object') missingDescriptions(s[k], `${path}.${k}`, out);
  }
  for (const k of ['oneOf', 'anyOf']) {
    (s[k] as unknown[] | undefined)?.forEach((v, i) => missingDescriptions(v, `${path}.${k}[${i}]`, out));
  }
}

describe('GET /openapi.json', () => {
  it('is an OpenAPI 3.1 document, public', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: '3.1.0', info: { title: expect.any(String), version: expect.any(String) } });
  });

  it('documents every route', async () => {
    const app = await build();
    await app.ready();
    expect(app.openapiUndocumented()).toEqual([]);
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    // Spot checks of the path conversion and a couple of known operations.
    expect(doc.paths['/mailboxes/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(doc.paths['/auth/signup'].post.requestBody.content['application/json'].schema.required).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
    expect(doc.paths['/auth/signup'].post.requestBody.content['application/json'].schema.required).not.toEqual(
      expect.arrayContaining(['businessName', 'timezone']),
    );
    expect(doc.paths['/businesses'].post.requestBody.content['application/json'].schema.required).toEqual(
      expect.arrayContaining(['name', 'timezone']),
    );
  });

  it('has a summary and description on every operation, and on every parameter and field', async () => {
    const app = await build();
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const missing: string[] = [];
    const ids = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, Json>>)) {
      for (const [method, op] of Object.entries(ops)) {
        const where = `${method.toUpperCase()} ${path}`;
        if (!op.summary || !op.description) missing.push(`${where}: summary/description`);
        if (ids.has(op.operationId as string)) missing.push(`${where}: duplicate operationId`);
        ids.add(op.operationId as string);
        for (const p of (op.parameters as Json[] | undefined) ?? []) {
          if (!p.description) missing.push(`${where}: parameter ${p.name}`);
        }
        const body = (op.requestBody as Json | undefined)?.content as Json | undefined;
        missingDescriptions((body?.['application/json'] as Json | undefined)?.schema, `${where} body`, missing);
        for (const [status, r] of Object.entries(op.responses as Record<string, Json>)) {
          if (!r.description) missing.push(`${where} ${status}: description`);
          const content = r.content as Json | undefined;
          missingDescriptions((content?.['application/json'] as Json | undefined)?.schema, `${where} ${status}`, missing);
        }
      }
    }
    for (const [name, schema] of Object.entries(doc.components.schemas as Json)) {
      missingDescriptions(schema, `#/components/schemas/${name}`, missing);
    }
    expect(missing).toEqual([]);
  });
});
