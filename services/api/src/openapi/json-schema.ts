import type { ZodTypeAny } from 'zod';

// Minimal zod (v3) -> JSON Schema (2020-12, the dialect of OpenAPI 3.1) converter for the
// constructs the API's request/response schemas use. Written in-house instead of adding
// zod-to-json-schema; zod's own z.toJSONSchema only handles zod v4 schemas.
//
// - `.describe("...")` becomes `description` (the course spec wants one on every field).
// - Request bodies are documented as the client sends them: transforms/refinements document their
//   input side (pipes their output side), defaults are shown as `default`, and a field is required unless it may be omitted.
// - Schemas registered in `refs` are emitted as `$ref: #/components/schemas/<name>` (shared
//   schemas from @pbx/shared, whose JSON Schema is written by hand in components.ts).
// Unknown constructs throw, so a new kind of field can't silently show up as "anything".

export type JsonSchema = Record<string, unknown>;

export type RefMap = Map<ZodTypeAny, string>;

interface Def {
  typeName: string;
  description?: string;
  [key: string]: unknown;
}

const def = (s: ZodTypeAny) => s._def as Def;

export function toJsonSchema(schema: ZodTypeAny, refs: RefMap): JsonSchema {
  const ref = refFor(schema, refs);
  if (ref) return withDescription({ $ref: `#/components/schemas/${ref}` }, schema);
  return withDescription(convert(schema, refs), schema);
}

/**
 * The component name for `schema`, if it is a registered schema. `.describe()` returns a copy with
 * a new _def, so compare the defs field by field, ignoring the description.
 */
function refFor(schema: ZodTypeAny, refs: RefMap): string | undefined {
  const direct = refs.get(schema);
  if (direct) return direct;
  const d = def(schema);
  for (const [candidate, name] of refs) {
    const c = def(candidate);
    const keys = new Set([...Object.keys(c), ...Object.keys(d)]);
    keys.delete('description');
    if ([...keys].every((k) => c[k] === d[k])) return name;
  }
  return undefined;
}

function withDescription(out: JsonSchema, schema: ZodTypeAny): JsonSchema {
  const d = def(schema).description;
  return d && out.description === undefined ? { ...out, description: d } : out;
}

function convert(schema: ZodTypeAny, refs: RefMap): JsonSchema {
  const d = def(schema);
  switch (d.typeName) {
    case 'ZodString':
      return stringSchema(d);
    case 'ZodNumber':
      return numberSchema(d);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodLiteral':
      return { const: d.value };
    case 'ZodEnum':
      return { type: 'string', enum: d.values };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodUnknown':
    case 'ZodAny':
      return {};
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: toJsonSchema(d.type as ZodTypeAny, refs) };
      if (d.minLength) out.minItems = (d.minLength as { value: number }).value;
      if (d.maxLength) out.maxItems = (d.maxLength as { value: number }).value;
      return out;
    }
    case 'ZodObject':
      return objectSchema(schema, refs);
    case 'ZodRecord':
      return {
        type: 'object',
        propertyNames: toJsonSchema(d.keyType as ZodTypeAny, refs),
        additionalProperties: toJsonSchema(d.valueType as ZodTypeAny, refs),
      };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return { oneOf: (d.options as ZodTypeAny[]).map((o) => toJsonSchema(o, refs)) };
    case 'ZodNullable':
      return { anyOf: [toJsonSchema(d.innerType as ZodTypeAny, refs), { type: 'null' }] };
    case 'ZodOptional':
      return toJsonSchema(d.innerType as ZodTypeAny, refs);
    case 'ZodDefault':
      return { ...toJsonSchema(d.innerType as ZodTypeAny, refs), default: (d.defaultValue as () => unknown)() };
    case 'ZodEffects': // refine / transform / preprocess: document what the client sends
      return toJsonSchema(d.schema as ZodTypeAny, refs);
    case 'ZodPipeline': // x.pipe(y): x is preprocessing (e.g. z.unknown()), y is the real schema
      return toJsonSchema(d.out as ZodTypeAny, refs);
    default:
      throw new Error(`toJsonSchema: unsupported zod type ${d.typeName}`);
  }
}

function stringSchema(d: Def): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const c of d.checks as { kind: string; value?: number; regex?: RegExp }[]) {
    if (c.kind === 'min') out.minLength = c.value;
    else if (c.kind === 'max') out.maxLength = c.value;
    else if (c.kind === 'length') out.minLength = out.maxLength = c.value;
    else if (c.kind === 'regex') out.pattern = c.regex!.source;
    else if (c.kind === 'uuid') out.format = 'uuid';
    else if (c.kind === 'email') out.format = 'email';
    else if (c.kind === 'url') out.format = 'uri';
    else if (c.kind === 'datetime') out.format = 'date-time';
    // trim / toLowerCase: normalization, nothing to document as a constraint
  }
  return out;
}

function numberSchema(d: Def): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const c of d.checks as { kind: string; value?: number; inclusive?: boolean }[]) {
    if (c.kind === 'int') out.type = 'integer';
    else if (c.kind === 'min') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
    else if (c.kind === 'max') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
  }
  return out;
}

function objectSchema(schema: ZodTypeAny, refs: RefMap): JsonSchema {
  const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = toJsonSchema(field, refs);
    if (!field.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: 'object', properties };
  if (required.length) out.required = required;
  return out;
}
