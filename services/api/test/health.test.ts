import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import { FakeStripe, MemoryStore, build, testConfig, unusedDb } from './helpers.js';
import { FfmpegConverter } from '../src/audio.js';
import { FakeDidProvider } from '../src/numbers/fake-provider.js';

const ok = async () => {};
const fail = async () => {
  throw new Error('connection refused');
};

describe('GET /health', () => {
  it('is 200 even when dependencies are down', async () => {
    const app = await build({ readinessChecks: { db: fail } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('is 200 when all checks pass', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', objectStore: 'ok' } });
  });

  it('is 503 and names the failing check', async () => {
    const app = await build({ readinessChecks: { db: fail, objectStore: ok } });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'fail', checks: { db: 'fail', objectStore: 'ok' } });
  });

  it('treats a hanging check as failed and aborts it', async () => {
    let aborted = false;
    const hang = (signal: AbortSignal) =>
      new Promise<void>(() => signal.addEventListener('abort', () => (aborted = true)));
    const app = await buildApp(testConfig, {
      sql: unusedDb(),
      readinessChecks: { db: hang },
      isDraining: () => false,
      stripe: new FakeStripe(),
      store: new MemoryStore(),
      audio: new FfmpegConverter(),
      didProvider: new FakeDidProvider(),
    });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    // The check times out after 1.5 s. The bound is loose because timers fire late while the other
    // test files (run in parallel) keep the CPU busy; what matters is that it doesn't hang.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(aborted).toBe(true);
  }, 15_000);

  it('is 503 while draining, without running checks', async () => {
    let ran = false;
    const app = await build({
      readinessChecks: { db: async () => void (ran = true) },
      isDraining: () => true,
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'draining' });
    expect(ran).toBe(false);
  });
});

describe('GET /metrics', () => {
  it('exposes Prometheus metrics including request latency', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('pbx_api_http_request_duration_seconds_count{method="GET",route="/health",status="200"}');
  });
});

describe('error handling', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('maps HttpError, transient DB errors and bugs', async () => {
    const app = await build();
    app.get('/http-error', async () => {
      throw new HttpError(409, 'conflict', 'already exists');
    });
    app.get('/db-down', async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    app.get('/bug', async () => {
      throw new Error('secret internal detail');
    });

    const conflict = await app.inject({ method: 'GET', url: '/http-error' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'conflict', message: 'already exists' });

    const dbDown = await app.inject({ method: 'GET', url: '/db-down' });
    expect(dbDown.statusCode).toBe(503);
    expect(dbDown.headers['retry-after']).toBe('2');

    const bug = await app.inject({ method: 'GET', url: '/bug' });
    expect(bug.statusCode).toBe(500);
    expect(bug.body).not.toContain('secret');
  });
});

describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgres://pbx:pbx@127.0.0.1:5432/pbx',
    S3_ENDPOINT: 'http://127.0.0.1:3900',
    S3_BUCKET: 'pbx-media',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    JWT_SECRET: 'x'.repeat(32),
    DID_PROVIDER_URL: 'http://127.0.0.1:4000',
    DID_PROVIDER_API_KEY: 'didww-key',
    DID_TRUNK_GROUP_ID: 'tg-1',
    SIP_WS_URI: 'wss://localhost/ws',
    SIP_DOMAIN: 'pbx.local',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  };

  it('applies defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.STRIPE_JS_URL).toBe('https://stripe.cse356.compas.cs.stonybrook.edu/v3/');
  });

  it('needs the DID provider key and exactly one trunk in didww mode, neither in fake mode', () => {
    expect(loadConfig(valid).DID_PROVIDER_MODE).toBe('didww');
    expect(() => loadConfig({ ...valid, DID_PROVIDER_API_KEY: undefined })).toThrowError(/DID_PROVIDER_API_KEY/);
    expect(() => loadConfig({ ...valid, DID_TRUNK_GROUP_ID: undefined })).toThrowError(/exactly one/);
    expect(() => loadConfig({ ...valid, DID_TRUNK_ID: 't-1' })).toThrowError(/exactly one/);
    const fake = { ...valid, DID_PROVIDER_MODE: 'fake', DID_PROVIDER_API_KEY: undefined, DID_TRUNK_GROUP_ID: undefined };
    expect(loadConfig(fake).DID_PROVIDER_MODE).toBe('fake');
  });

  it('lists every bad variable without echoing secret values', () => {
    const env = { ...valid, JWT_SECRET: 'short-secret', DATABASE_URL: undefined };
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
    expect(() => loadConfig(env)).not.toThrowError(/short-secret/);
  });
});
