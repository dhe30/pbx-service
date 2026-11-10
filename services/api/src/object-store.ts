import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';

// S3-compatible object store (Garage in production). Only the plain S3 API is used.
// Objects: tenants/<tenant_id>/<kind>/<media_id>.wav (mediaObjectKey() in @pbx/shared), never
// overwritten. The API writes greetings and reads/deletes every kind; the ARI app writes
// recordings and voicemails (docs/split-contracts.md §6).
//
// Audio goes to browsers THROUGH the API (GET /media/:id/audio), not via presigned URLs: the
// store's endpoint is on the private network, so a presigned URL would not open in a browser.

/** A stored object being read. `body` must be consumed or destroyed. */
export interface StoredObject {
  body: Readable;
  contentLength: number | undefined;
  /** Set for a ranged read: `bytes <first>-<last>/<total>`. */
  contentRange: string | undefined;
}

/** What the media routes need from the store (tests use an in-memory fake). */
export interface MediaStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * Reads an object. `range` is an HTTP Range header value (`bytes=0-99`).
   * Returns null if there is no such object; throws RangeNotSatisfiable for a bad range.
   */
  get(key: string, range?: string): Promise<StoredObject | null>;
  /** Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** The object store didn't answer or failed (-> 503, like a DB failover). */
export class ObjectStoreError extends Error {}

/** The requested byte range is outside the object (-> 416). */
export class RangeNotSatisfiable extends Error {}

export class ObjectStore implements MediaStore {
  readonly s3: S3Client;
  readonly bucket: string;

  constructor(cfg: Pick<Config, 'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'>) {
    this.bucket = cfg.S3_BUCKET;
    this.s3 = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
      forcePathStyle: true, // Garage (and most self-hosted stores) need path-style URLs
      maxAttempts: 3,
      // Same as ari-app: only send/validate CRC checksums when required, for non-AWS servers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    } catch (err) {
      throw storeError('put', err);
    }
  }

  async get(key: string, range?: string): Promise<StoredObject | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      return { body: res.Body as Readable, contentLength: res.ContentLength, contentRange: res.ContentRange };
    } catch (err) {
      if (err instanceof S3ServiceException) {
        if (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404) return null;
        if (err.name === 'InvalidRange' || err.$metadata.httpStatusCode === 416) throw new RangeNotSatisfiable();
      }
      throw storeError('get', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw storeError('delete', err);
    }
  }

  close(): void {
    this.s3.destroy();
  }
}

function storeError(op: string, err: unknown): ObjectStoreError {
  const e = new ObjectStoreError(`object store ${op} failed: ${(err as Error)?.message ?? String(err)}`);
  e.cause = err;
  return e;
}
