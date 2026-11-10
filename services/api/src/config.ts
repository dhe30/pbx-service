import { z } from 'zod';

// All config comes from the environment: in production a systemd/docker EnvironmentFile rendered by
// the `api` Ansible role; locally the repo-root .env (copy .env.example). Validated once at startup
// so a bad deploy fails immediately and visibly instead of on the first request.

const EnvSchema = z.object({
  /** Interface to bind. Production: the app node's private IP (HAProxy on the edges connects to it). */
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Local HAProxy (127.0.0.1:5432) in production, which always points at the Patroni primary. */
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  /** ffmpeg binary for greeting uploads (converted to 8 kHz mono WAV). Must be installed on app nodes. */
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),

  /** Signs the auth cookie. Must be identical on every app-N replica (Ansible Vault). */
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /** Access cookie lifetime: how long a copied/stolen token or a deleted user keeps working. */
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  /** Refresh cookie lifetime: how long a user stays logged in without activity. */
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(3600).max(30 * 86400).default(7 * 86400),
  /**
   * Secure flag on auth cookies (sent over HTTPS only). Keep true: browsers also accept Secure
   * cookies on http://localhost. Set false only for plain-HTTP testing on another host.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * Course payment gateway (Stripe clone). STRIPE_API_URL: REST API base ([VERIFY] the host);
   * STRIPE_JS_URL: where browsers load Stripe.js from (the spec requires the gateway's copy).
   * The secret key stays on the server; the publishable key is given to browsers.
   */
  STRIPE_API_URL: z.string().url().default('https://stripe.cse356.compas.cs.stonybrook.edu'),
  STRIPE_JS_URL: z.string().url().default('https://stripe.cse356.compas.cs.stonybrook.edu/v3/'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  /**
   * DID provider (course DIDWW API v3 clone, CLAUDE.md §3 A6). `fake` = an in-memory provider
   * selling fictional numbers (tests and local dev; one API process only).
   */
  DID_PROVIDER_MODE: z.enum(['didww', 'fake']).default('didww'),
  /** API base URL, e.g. https://<didww clone>/v3. */
  DID_PROVIDER_URL: z.string().url(),
  /** `Api-Key` header value (Ansible Vault). Required in didww mode. */
  DID_PROVIDER_API_KEY: z.string().optional(),
  /**
   * Where bought numbers send their calls: our inbound trunk group (both edges, A7) or a single
   * trunk. Exactly one is required in didww mode (DIDWW voice_in_trunk_groups / voice_in_trunks id).
   */
  DID_TRUNK_GROUP_ID: z.string().optional(),
  DID_TRUNK_ID: z.string().optional(),
  /** Returned to staff browsers by GET /me/sip-credentials. */
  SIP_WS_URI: z.string().url(),
  SIP_DOMAIN: z.string().min(1),

  /**
   * On SIGTERM: how long /ready reports 503 (so the edge HAProxies stop sending new requests)
   * before the server stops accepting connections. Should exceed HAProxy's health-check
   * interval x fall count. 0 is fine for local dev.
   */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(5000),
  /** Hard limit for finishing in-flight requests after draining; then we exit anyway. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
}).superRefine((c, ctx) => {
  if (c.DID_PROVIDER_MODE !== 'didww') return;
  if (!c.DID_PROVIDER_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['DID_PROVIDER_API_KEY'], message: 'Required (or set DID_PROVIDER_MODE=fake)' });
  }
  if (!c.DID_TRUNK_GROUP_ID === !c.DID_TRUNK_ID) {
    ctx.addIssue({ code: 'custom', path: ['DID_TRUNK_GROUP_ID'], message: 'Set exactly one of DID_TRUNK_GROUP_ID, DID_TRUNK_ID' });
  }
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // One line per bad variable, never echoing values (they may be secrets).
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
