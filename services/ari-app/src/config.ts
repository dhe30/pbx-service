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
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  /** PJSIP trunk endpoints toward Kamailio, in preference order (edge-a,edge-b). */
  TRUNKS: csv.default('edge-a'),
  /** PSTN vendor SIP hosts (Course Services tab). Calls go Asterisk -> Kamailio -> vendor. */
  VENDOR_US_HOST: z.string().default('us-vendor.cse356.compas.cs.stonybrook.edu'),
  VENDOR_INTL_HOST: z.string().default('intl-vendor.cse356.compas.cs.stonybrook.edu'),
  /** How the dialed number is written in the vendor Request-URI. [VERIFY] with the vendors. */
  VENDOR_NUMBER_FORMAT: z.enum(['e164', 'e164_noplus']).default('e164'),

  /** Where Asterisk writes recordings (ARI record name is relative to this). */
  SPOOL_DIR: z.string().default('/var/spool/asterisk/recording'),
  /** Local cache of tenant greetings and voicemail messages, played with an absolute sound: path. */
  SOUNDS_CACHE_DIR: z.string().default('/var/lib/asterisk/sounds/cache'),
  /** Durable CDR queue: one file per finished call until it is in Postgres (B6). */
  CDR_SPOOL_DIR: z.string().default('/var/spool/pbx/cdr'),
  /** Flush CDRs to Postgres this often (ms). Keeps "just-ended calls" searchable within ~1 s. */
  CDR_FLUSH_MS: z.coerce.number().int().min(10).default(250),
  /** Max age of cached account config (s). NOTIFY invalidates sooner; this bounds a missed one. */
  CONFIG_TTL_SEC: z.coerce.number().int().min(1).max(55).default(30),

  VOICEMAIL_MAX_SEC: z.coerce.number().int().min(10).max(600).default(120),
  /** musiconhold.conf class played to the other party while one side holds. */
  HOLD_MOH_CLASS: z.string().min(1).default('default'),
  /** Max destination hops per call (forward -> ring group -> menu ...), guards against loops. */
  MAX_ROUTE_HOPS: z.coerce.number().int().min(1).max(50).default(10),

  HEALTH_HOST: z.string().default('127.0.0.1'),
  HEALTH_PORT: z.coerce.number().int().default(9101),
  PBX_NODE: z.string().default(hostname()),
  LOG_LEVEL: z.string().default('info'),
  /** Tests only: multiply every call-flow timer (ring timeouts, IVR waits) by this. */
  TIME_SCALE: z.coerce.number().positive().default(1),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
