import { hostname } from 'node:os';
import { z } from 'zod';

// All config comes from the environment (systemd EnvironmentFile=/etc/pbx/ari-app.env, rendered
// by the ari_app Ansible role). Validated once at startup: fail fast on a bad deploy.

const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string()).min(1));

const EnvSchema = z.object({
  ARI_URL: z.string().url().default('http://127.0.0.1:8088'),
  ARI_USER: z.string().min(1),
  ARI_PASSWORD: z.string().min(1),
  ARI_APP: z.string().default('pbx-app'),

  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  /** PJSIP trunk endpoints toward Kamailio, in preference order (edge-a,edge-b). */
  TRUNKS: csv.default('edge-a'),
  /** Where Asterisk writes recordings (ARI record name is relative to this). */
  SPOOL_DIR: z.string().default('/var/spool/asterisk/recording'),
  /** Local cache of tenant greetings, played with an absolute sound: path. */
  SOUNDS_CACHE_DIR: z.string().default('/var/lib/asterisk/sounds/cache'),

  /** Ring timeout for single-user targets (ring groups have their own). */
  USER_RING_TIMEOUT_SEC: z.coerce.number().int().min(5).max(120).default(20),
  VOICEMAIL_MAX_SEC: z.coerce.number().int().min(10).max(600).default(120),
  /** musiconhold.conf class played to the caller while the agent holds the call. */
  HOLD_MOH_CLASS: z.string().min(1).default('default'),

  HEALTH_HOST: z.string().default('127.0.0.1'),
  HEALTH_PORT: z.coerce.number().int().default(9101),
  PBX_NODE: z.string().default(hostname()),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
