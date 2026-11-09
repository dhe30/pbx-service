import { z } from 'zod';

// Call-routing configuration shared by the API (validates on write) and the ARI app (validates on
// read, so a bad row degrades to "hang up" instead of crashing a call). Course spec §3.
//
// A Destination is where a call goes next. It is stored as jsonb in:
//   phone_numbers.destination, ivr_menus.config (options / timeout / invalid),
//   ring_groups.no_answer_destination, business_hours.open_destination / closed_destination,
//   extensions.forward_always / forward_busy / forward_no_answer (extension | external only).

const uuid = z.string().uuid();
/** Single DTMF key. */
export const DtmfDigitSchema = z.string().regex(/^[0-9*#]$/);
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'E.164 number, e.g. +12015550123');

export const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extension'), id: uuid }),
  z.object({ type: z.literal('ring_group'), id: uuid }),
  z.object({ type: z.literal('ivr_menu'), id: uuid }),
  /** id = mailbox id */
  z.object({ type: z.literal('voicemail'), id: uuid }),
  z.object({ type: z.literal('business_hours'), id: uuid }),
  /** A PSTN number, dialed through a vendor and charged to the account like any outgoing leg. */
  z.object({ type: z.literal('external'), number: e164 }),
  z.object({ type: z.literal('hangup') }),
]);
export type Destination = z.infer<typeof DestinationSchema>;

/** Forwarding targets of an extension: another extension or an external number. */
export const ForwardDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extension'), id: uuid }),
  z.object({ type: z.literal('external'), number: e164 }),
]);
export type ForwardDestination = z.infer<typeof ForwardDestinationSchema>;

// Phase-1 format: {"action": "ring_group"|"voicemail"|"user", "target": "<uuid>"}.
const LegacyActionSchema = z.object({ action: z.enum(['ring_group', 'voicemail', 'user']), target: uuid });

/** Accepts the current format and the phase-1 {action, target} format. Throws on anything else. */
export function parseDestination(value: unknown): Destination {
  const legacy = LegacyActionSchema.safeParse(value);
  if (legacy.success) {
    const { action, target } = legacy.data;
    if (action === 'ring_group') return { type: 'ring_group', id: target };
    if (action === 'voicemail') return { type: 'voicemail', id: target };
    return { type: 'hangup' }; // 'user' targets were users, which no longer ring (extensions do)
  }
  return DestinationSchema.parse(value);
}

const DestinationInput = z.unknown().transform((v, ctx) => {
  try {
    return parseDestination(v);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid destination: ${(err as Error).message}` });
    return z.NEVER;
  }
});

/**
 * ivr_menus.config. Behaviour (together with ivr_menus.timeout_sec / max_retries):
 *  - Play the greeting, then wait timeout_sec for one digit.
 *  - Digit in `options` -> go there.
 *  - `repeat_digit` (default '*') -> play the menu again (does not count as a retry).
 *  - Any other digit = invalid input -> `invalid` destination if set; otherwise say "invalid" and
 *    replay (counts as a retry).
 *  - No digit -> replay; after max_retries plays without a valid choice -> `timeout` (or hang up).
 * Phase-1 key `on_timeout` is read as `timeout`.
 */
export const IvrConfigSchema = z
  .object({
    options: z.record(DtmfDigitSchema, DestinationInput).default({}),
    timeout: DestinationInput.optional(),
    invalid: DestinationInput.optional(),
    repeat_digit: DtmfDigitSchema.optional(),
    on_timeout: DestinationInput.optional(),
  })
  .transform(({ on_timeout, ...c }) => ({ ...c, timeout: c.timeout ?? on_timeout }));
export type IvrConfig = z.infer<typeof IvrConfigSchema>;

export function parseIvrConfig(value: unknown): IvrConfig {
  return IvrConfigSchema.parse(value);
}

/** Back-compat alias (phase 1 called destinations "actions"). */
export type IvrAction = Destination;

/**
 * business_hours.schedule: weekly opening intervals in the ACCOUNT's time zone.
 * day: 0 = Sunday ... 6 = Saturday. end <= start means the interval runs past midnight.
 * "24:00" is allowed as an end time.
 */
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/, 'HH:MM');
export const WeeklyScheduleSchema = z.object({
  intervals: z.array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).default([]),
});
export type WeeklySchedule = z.infer<typeof WeeklyScheduleSchema>;
