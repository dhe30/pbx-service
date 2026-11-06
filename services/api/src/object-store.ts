import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';

// S3-compatible object store (Garage in production). Only the plain S3 API is used.
// Grows in step 6 (greeting upload, presigned URLs); for now it only backs the /ready check.
export class ObjectStore {
  readonly s3: S3Client;
  readonly bucket: string;

  constructor(cfg: Config) {
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

  close(): void {
    this.s3.destroy();
  }
}
