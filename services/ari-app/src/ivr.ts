import type { Destination } from '@pbx/shared';
import type { Ctx } from './ctx.js';
import { DigitReader, playOnce } from './playback.js';
import type { CallSession } from './session.js';
import type { IvrMenuCfg } from './tenant.js';

// IVR menus (spec §3): "Greeting (customer-uploaded WAV, 16-bit PCM mono 8 kHz); digits route to
// an extension, ring group, menu, voicemail box, or external number; timeout, invalid-input
// action, repeat." Exact semantics: IvrConfigSchema in services/shared/src/ivr-config.ts.

const DEFAULT_MENU_PROMPT = 'sound:hello-world';
const INVALID_OPTION_PROMPT = 'sound:option-is-invalid';
export const DEFAULT_REPEAT_DIGIT = '*';

/** Play the menu and return where the caller goes next (null = hang up). */
export async function runIvr(ctx: Ctx, s: CallSession, menu: IvrMenuCfg): Promise<Destination | null> {
  await s.ensureAnswered(ctx.ari);
  const greeting = menu.greetingMediaId && s.tenant ? await ctx.media.soundUri(s.tenant.id, menu.greetingMediaId) : null;
  const prompt = [greeting ?? DEFAULT_MENU_PROMPT];
  const repeat = menu.config.repeat_digit ?? DEFAULT_REPEAT_DIGIT;
  const reader = new DigitReader(ctx, s);
  try {
    let attempts = 0;
    while (attempts < menu.maxRetries) {
      const digit = await reader.prompt(prompt, menu.timeoutSec);
      if (digit === null) {
        attempts++;
        s.log.debug({ attempts }, 'ivr: no input');
        continue;
      }
      if (digit === repeat && !menu.config.options[digit]) {
        s.log.info('ivr: repeat');
        continue;
      }
      const dest = menu.config.options[digit];
      if (dest) {
        s.log.info({ digit, dest }, 'ivr: option selected');
        return dest;
      }
      s.log.info({ digit, attempts }, 'ivr: invalid option');
      if (menu.config.invalid) return menu.config.invalid;
      attempts++;
      await playOnce(ctx, s, INVALID_OPTION_PROMPT);
    }
    s.log.info('ivr: retries exhausted');
    return menu.config.timeout ?? null;
  } finally {
    reader.close();
  }
}
