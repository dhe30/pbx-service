import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';

// S3-compatible object store (Garage). Only the plain S3 API is used so the backend can change.
export class ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: Config) {
    this.bucket = cfg.S3_BUCKET;
    this.s3 = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
      forcePathStyle: true, // Garage (and most self-hosted stores) need path-style URLs
      maxAttempts: 3,
      // Recent SDK versions add CRC checksums by default; only send them when the API requires it,
      // for compatibility with non-AWS servers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async putFile(key: string, filePath: string, contentType = 'audio/wav'): Promise<void> {
    const { size } = await stat(filePath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async getToFile(key: string, filePath: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty body for ${key}`);
    await pipeline(res.Body as Readable, createWriteStream(filePath));
  }
}
