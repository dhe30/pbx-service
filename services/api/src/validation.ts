import type { z } from 'zod';
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
