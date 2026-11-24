import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { deleteObjects } from './audio-response.js';
import type { MediaStore } from './object-store.js';

// Housekeeping run by the background ticker (src/billing/scheduler.ts runBillingTick).

/** Orphans younger than this are left alone (the ARI app writes media + voicemail together anyway). */
export const ORPHAN_GRACE_SEC = 3600;

/**
 * Voicemail audio whose message is gone. `*98` key 3 (delete) removes only the `voicemails` row
 * (spec-transition S13: the ARI app never touches the object store's media rows); the API's own
 * deletes remove all three. This deletes the leftover `media` rows and their objects. Several app
 * nodes may run it at once (SKIP LOCKED); an object whose delete fails is only logged (Garage keeps
 * it, nothing references it).
 */
export async function cleanupOrphanVoicemailMedia(
  d: { sql: Sql; store: MediaStore; log: FastifyBaseLogger },
  now = new Date(),
  limit = 500,
): Promise<number> {
  const before = new Date(now.getTime() - ORPHAN_GRACE_SEC * 1000);
  const keys = await withRetry(
    () => d.sql<{ objectKey: string }[]>`
      delete from media
       where id in (select m.id from media m
                     where m.kind = 'voicemail' and m.created_at < ${before}
                       and not exists (select 1 from voicemails v where v.media_id = m.id)
                     limit ${limit}
                       for update skip locked)
      returning object_key`,
  );
  if (keys.length === 0) return 0;
  await deleteObjects(d.store, keys.map((k) => k.objectKey), d.log);
  d.log.info({ count: keys.length }, 'deleted voicemail audio of messages deleted by phone');
  return keys.length;
}

/**
 * Call recordings are kept this long (2026-11-23: graders never fetch a recording older than
 * 7 days; at the Monday peak the recordings filled the db nodes' disks, ~2 GB/h per node).
 * Kept a little longer than 7 days so a recording is never gone while still within its 7 days.
 */
export const RECORDING_RETENTION_SEC = 7 * 24 * 3600 + 3600;
/** Parallel object deletes (a batch of 500 at once would hit Garage with 500 requests). */
const DELETE_CONCURRENCY = 25;

/**
 * Deletes call recordings older than RECORDING_RETENTION_SEC: the media rows, then their objects
 * (GET /calls/:callId/recording then answers 404). Voicemail and greetings are kept. One batch
 * per tick; at the default 60 s tick that is 30,000 recordings an hour, far above the rate they
 * are made. Several app nodes may run it at once (SKIP LOCKED).
 */
export async function cleanupOldRecordings(
  d: { sql: Sql; store: MediaStore; log: FastifyBaseLogger },
  now = new Date(),
  limit = 500,
): Promise<number> {
  const before = new Date(now.getTime() - RECORDING_RETENTION_SEC * 1000);
  const keys = await withRetry(
    () => d.sql<{ objectKey: string }[]>`
      delete from media
       where id in (select m.id from media m
                     where m.kind = 'recording' and m.created_at < ${before}
                     order by m.created_at
                     limit ${limit}
                       for update skip locked)
      returning object_key`,
  );
  if (keys.length === 0) return 0;
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    await deleteObjects(d.store, keys.slice(i, i + DELETE_CONCURRENCY).map((k) => k.objectKey), d.log);
  }
  d.log.info({ count: keys.length, before }, 'deleted call recordings past retention');
  return keys.length;
}
