import type { IvrAction } from '@pbx/shared';
import type { Ctx } from './ctx.js';
import { playAndCollect, playOnce } from './playback.js';
import type { InboundRoute } from './repo.js';
import type { CallSession } from './session.js';

// Used when the menu has no greeting or it can't be fetched. Stock Asterisk core sound.
// [DECISION] replace with a real "default menu" recording once the API can upload greetings.
const DEFAULT_MENU_PROMPT = 'sound:hello-world';
const INVALID_OPTION_PROMPT = 'sound:option-is-invalid';

/**
 * Play the menu and collect one digit, up to max_retries times.
 * Returns the chosen action, the menu's on_timeout action, or null (= hang up).
 */
export async function runIvr(ctx: Ctx, s: CallSession, route: InboundRoute): Promise<IvrAction | null> {
  const greeting = route.greetingMediaId ? await ctx.greetings.soundUri(route.tenantId, route.greetingMediaId) : null;
  const prompt = [greeting ?? DEFAULT_MENU_PROMPT];

  for (let attempt = 1; attempt <= route.maxRetries; attempt++) {
    const digit = await playAndCollect(ctx, s, prompt, route.timeoutSec * 1000);
    if (digit === null) {
      s.log.debug({ attempt }, 'ivr: no input');
      continue;
    }
    const action = route.config.options[digit];
    if (action) {
      s.log.info({ digit, action }, 'ivr: option selected');
      return action;
    }
    s.log.info({ digit, attempt }, 'ivr: invalid option');
    await playOnce(ctx, s, INVALID_OPTION_PROMPT);
  }
  s.log.info('ivr: retries exhausted');
  return route.config.on_timeout ?? null;
}
