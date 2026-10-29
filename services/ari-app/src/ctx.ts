import type { AriClient } from './ari/client.js';
import type { EventBus } from './ari/events.js';
import type { Config } from './config.js';
import type { GreetingCache } from './greetings.js';
import type { Repo } from './repo.js';
import type { Uploader } from './uploader.js';

/** Dependencies shared by all call flows. */
export interface Ctx {
  cfg: Config;
  ari: AriClient;
  bus: EventBus;
  repo: Repo;
  greetings: GreetingCache;
  uploader: Uploader;
}
