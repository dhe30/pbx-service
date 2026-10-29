import { z } from 'zod';

// Schema for ivr_menus.config (CLAUDE.md §6). The API validates on write; the ARI app validates
// on read so a bad row degrades to "hang up" instead of crashing a call.

const uuid = z.string().uuid();

export const IvrActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ring_group'), target: uuid }),
  z.object({ action: z.literal('voicemail'), target: uuid }),
  z.object({ action: z.literal('user'), target: uuid }),
]);
export type IvrAction = z.infer<typeof IvrActionSchema>;

/** Keys are single DTMF digits. */
export const DtmfDigitSchema = z.string().regex(/^[0-9*#]$/);

export const IvrConfigSchema = z.object({
  options: z.record(DtmfDigitSchema, IvrActionSchema).default({}),
  /** Action after max_retries with no valid input. Omitted = hang up. */
  on_timeout: IvrActionSchema.optional(),
});
export type IvrConfig = z.infer<typeof IvrConfigSchema>;

export function parseIvrConfig(value: unknown): IvrConfig {
  return IvrConfigSchema.parse(value);
}
