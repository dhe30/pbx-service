import { DestinationSchema, ForwardDestinationSchema, IvrConfigSchema, WeeklyScheduleSchema } from '@pbx/shared';
import type { JsonSchema, RefMap } from './json-schema.js';

// Hand-written JSON Schemas for the shared call-routing types (services/shared/src/ivr-config.ts).
// They are zod schemas with transforms (phase-1 formats are accepted on input), which can't be
// converted mechanically into something readable. Keep in sync with ivr-config.ts and
// docs/telephony-contract.md §3.

const uuid = (description: string): JsonSchema => ({ type: 'string', format: 'uuid', description });
const e164: JsonSchema = {
  type: 'string',
  pattern: '^\\+[1-9][0-9]{6,14}$',
  description: 'Phone number in E.164 format, e.g. "+12015550123".',
};

const withId = (type: string, what: string): JsonSchema => ({
  type: 'object',
  description: `Send the call to ${what}.`,
  properties: {
    type: { const: type, description: 'Destination kind.' },
    id: uuid(`Id of the ${what} (must belong to the same account).`),
  },
  required: ['type', 'id'],
});

const external: JsonSchema = {
  type: 'object',
  description: 'Dial an external PSTN number; billed like any outgoing call.',
  properties: {
    type: { const: 'external', description: 'Destination kind.' },
    number: e164,
  },
  required: ['type', 'number'],
};

export const COMPONENTS: Record<string, JsonSchema> = {
  Error: {
    type: 'object',
    description: 'Every error response has this shape.',
    properties: {
      error: {
        type: 'string',
        description:
          'Machine-readable code: invalid_request, invalid_reference, unauthorized, invalid_credentials, ' +
          'forbidden, not_found, email_taken, number_taken, in_use, payment_required, ' +
          'extension_limit, payment_failed, card_not_saved, payment_gateway_error, invalid_audio, range_not_satisfiable, ' +
          'unavailable, internal_error.',
      },
      message: {
        type: 'string',
        description: 'Human-readable explanation. For 400s it starts with the path of each bad field.',
      },
    },
    required: ['error', 'message'],
  },
  Destination: {
    description:
      'Where a call goes next (number routing, IVR digits, ring group no-answer, business hours). ' +
      'A missing target makes the call hang up.',
    oneOf: [
      withId('extension', 'extension'),
      withId('ring_group', 'ring group'),
      withId('ivr_menu', 'IVR menu'),
      withId('voicemail', 'mailbox (voicemail)'),
      withId('business_hours', 'business hours schedule'),
      external,
      {
        type: 'object',
        description: 'Hang up.',
        properties: { type: { const: 'hangup', description: 'Destination kind.' } },
        required: ['type'],
      },
    ],
  },
  ForwardDestination: {
    description: 'Forwarding target of an extension: another extension or an external number.',
    oneOf: [withId('extension', 'extension'), external],
  },
  IvrConfig: {
    type: 'object',
    description:
      'What each key does in an IVR menu. The greeting plays, then the menu waits timeoutSec for a key; ' +
      'after maxRetries plays without a valid key it goes to `timeout`. The phase-1 format ' +
      '({action: ring_group|voicemail, target}, on_timeout) is accepted on input and returned in this format.',
    properties: {
      options: {
        type: 'object',
        description: 'Key ("0"-"9", "*", "#") -> Destination.',
        propertyNames: { type: 'string', pattern: '^[0-9*#]$', description: 'One DTMF key.' },
        additionalProperties: { $ref: '#/components/schemas/Destination' },
        default: {},
      },
      timeout: {
        $ref: '#/components/schemas/Destination',
        description: 'After maxRetries plays without valid input. Omitted: hang up.',
      },
      invalid: {
        $ref: '#/components/schemas/Destination',
        description: 'On a key that is not in options. Omitted: say "invalid option" and replay (counts as a retry).',
      },
      repeat_digit: {
        type: 'string',
        pattern: '^[0-9*#]$',
        description: 'Key that replays the menu without counting as a retry. Default "*".',
      },
    },
  },
  WeeklySchedule: {
    type: 'object',
    description: "Weekly opening hours in the account's time zone (GET /me -> tenant.timezone).",
    properties: {
      intervals: {
        type: 'array',
        description: 'Open intervals. Outside all of them the schedule is closed.',
        default: [],
        items: {
          type: 'object',
          description: 'One open interval.',
          properties: {
            day: { type: 'integer', minimum: 0, maximum: 6, description: 'Day the interval starts: 0 = Sunday ... 6 = Saturday.' },
            start: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Opening time, "HH:MM".' },
            end: {
              type: 'string',
              pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$',
              description: 'Closing time, "HH:MM" or "24:00". end <= start runs past midnight into the next day.',
            },
          },
          required: ['day', 'start', 'end'],
        },
      },
    },
  },
};

/** Shared zod schemas documented by a component above instead of being converted. */
export function sharedRefs(extra: [unknown, string][] = []): RefMap {
  const refs: RefMap = new Map();
  refs.set(DestinationSchema, 'Destination');
  refs.set(ForwardDestinationSchema, 'ForwardDestination');
  refs.set(IvrConfigSchema, 'IvrConfig');
  refs.set(WeeklyScheduleSchema, 'WeeklySchedule');
  for (const [schema, name] of extra) refs.set(schema as never, name);
  return refs;
}
