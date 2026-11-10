import { z } from 'zod';
import { HttpError } from './errors.js';

// Keyset paging for long, newest-first lists (call history, voicemails): the client passes back
// `nextCursor` from the previous page, and the next query continues with
// `(ts, id) < (cursor.ts, cursor.id)`. Unlike OFFSET this stays fast deep into millions of rows,
// and rows inserted meanwhile don't shift pages.
//
// The cursor carries the timestamp as Postgres text with microseconds. A JS
// Date has only milliseconds, so going through Date could skip or repeat rows that share a
// millisecond.

// Queries select the cursor timestamp as
//   to_char(<column> at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts
// and compare with `(<column>, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`.

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface Cursor {
  ts: string;
  id: string;
}

export const encodeCursor = (c: Cursor): string => Buffer.from(`${c.ts}|${c.id}`).toString('base64url');

export function decodeCursor(cursor: string): Cursor {
  const [ts, id, extra] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (extra !== undefined || !ts || !TS.test(ts) || !id || !z.string().uuid().safeParse(id).success) {
    throw new HttpError(400, 'invalid_request', 'cursor: not a cursor from a previous page');
  }
  return { ts, id };
}

export const PageQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Page size, 1-200 (default 50).'),
  cursor: z.string().max(200).optional().describe('`nextCursor` of the previous page. Omitted = first (newest) page.'),
};

/** Splits `limit + 1` fetched rows into a page and the cursor of the next one (null = last page). */
export function page<T extends { cursorTs: string; id: string }>(rows: T[], limit: number): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const last = rows[limit - 1]!;
  return { rows: rows.slice(0, limit), nextCursor: encodeCursor({ ts: last.cursorTs, id: last.id }) };
}
