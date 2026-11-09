import { isValidTimeZone } from '@pbx/shared';
import { z } from 'zod';
import { HttpError } from './errors.js';

/**
 * Validate a request body (or query/params) with zod. Bad input -> 400 in the common error format:
 *   { "error": "invalid_request", "message": "email: Invalid email; password: ..." }
 */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new HttpError(400, 'invalid_request', message);
  }
  return result.data;
}

// Shared field rules (signup, login, staff creation).
// Emails are stored lowercased: users.email is a plain case-sensitive UNIQUE column.
export const email = z.string().trim().toLowerCase().email().max(254);
// Dashboard passwords. The upper bound keeps argon2 work per request bounded.
export const password = z.string().min(8, 'must be at least 8 characters').max(128);
// Display name of a mailbox, ring group or IVR menu.
export const name = z.string().trim().min(1).max(100);
// An optional reference to another row (greeting, owner, fallback mailbox, ...). Omitted = null.
export const nullableId = z.string().uuid().nullable().default(null);
// IANA time zone ("America/New_York"). Stored in its canonical spelling, so "america/new_york"
// and "America/New_York" are the same account setting.
export const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'must be an IANA time zone, e.g. America/New_York')
  .transform((tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone);
