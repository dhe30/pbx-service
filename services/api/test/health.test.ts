import { describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

const ok = async () => {};
const fail = async () => {
  throw new Error('connection refused');
};

function build(deps: Partial<AppDeps> = {}) {
  return buildApp(
    { LOG_LEVEL: 'silent' },
    { readinessChecks: { db: ok, objectStore: ok }, isDraining: () => false, ...deps },
  );
}

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
    const app = await buildApp(
      { LOG_LEVEL: 'silent' },
      { readinessChecks: { db: hang }, isDraining: () => false },
    );
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(aborted).toBe(true);
  });

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
    SIP_WS_URI: 'wss://localhost/ws',
    SIP_DOMAIN: 'pbx.local',
  };

  it('applies defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.HOST).toBe('127.0.0.1');
  });

  it('lists every bad variable without echoing secret values', () => {
    const env = { ...valid, JWT_SECRET: 'short-secret', DATABASE_URL: undefined };
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
    expect(() => loadConfig(env)).not.toThrowError(/short-secret/);
  });
});
