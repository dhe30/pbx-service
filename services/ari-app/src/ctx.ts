import type { Ari } from './ari/client.js';
import type { EventBus } from './ari/events.js';
import type { ConfigCache } from './cache.js';
import type { CdrWriter } from './cdr.js';
import type { Config } from './config.js';
import type { Conversation } from './conversation.js';
import type { MediaCache } from './greetings.js';
import type { LegTracker } from './legs.js';
import type { Repo } from './repo.js';
import type { Uploader } from './uploader.js';

/** Dependencies shared by all call flows. */
export interface Ctx {
  cfg: Config;
  ari: Ari;
  bus: EventBus;
  repo: Repo;
  cache: ConfigCache;
  cdr: CdrWriter;
  media: Pick<MediaCache, 'soundUri' | 'objectUri'>;
  uploader: Pick<Uploader, 'begin' | 'finish' | 'abandon'>;
  legs: LegTracker;
  /** Conversation (bridged call) each channel currently belongs to; used by attended transfer. */
  conversations: Map<string, Conversation>;
}

/** Call-flow timer in ms for a duration in seconds (TIME_SCALE speeds up tests). */
export function ms(ctx: Ctx, seconds: number): number {
  return Math.max(1, Math.round(seconds * 1000 * ctx.cfg.TIME_SCALE));
}
