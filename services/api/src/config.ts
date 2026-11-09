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
  /** Course DID endpoint (CLAUDE.md §3 A6; API shape still unknown). */
  DID_PROVIDER_URL: z.string().url(),
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
