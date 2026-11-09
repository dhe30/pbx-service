import type { Ctx } from './ctx.js';
import { DigitReader, playOnce } from './playback.js';
import type { VoicemailMsg } from './repo.js';
import type { CallSession } from './session.js';

// *98: voicemail by phone, Cisco Unity Connection "standard conversation" (spec §3):
//   Main menu:        1 = new messages, 3 then 1 = saved messages
//   During playback:  1 restart, 2 save, 3 delete, ## next (unchanged)
//   After playback:   1 replay, 2 save, 3 delete, # next (unchanged)
// "##" falls out naturally: the first # ends playback (-> after-playback menu), the second # there
// means "next". Digits are buffered (DigitReader), so a fast "##" is never lost.
// Changes are written to Postgres immediately, so the web inbox shows them too (new = heard false,
// saved = heard true, deleted = row gone). The caller is identified by their SIP account: no PIN.

const P = {
  youHave: 'sound:vm-youhave',
  newMsgs: 'sound:vm-INBOX',
  savedMsgs: 'sound:vm-Old',
  messages: 'sound:vm-messages',
  noMessages: 'sound:vm-no',
  mainMenu: 'sound:vm-onefor', // "press 1 for ..." (stand-in for the Unity main-menu prompt)
  afterMenu: 'sound:beep',
  saved: 'sound:vm-msgsaved',
  deleted: 'sound:vm-deleted',
  noMore: 'sound:vm-nomore',
  goodbye: 'sound:vm-goodbye',
};
const MENU_WAIT_SEC = 6;
const MAX_MENU_TIMEOUTS = 3;

type ListResult = 'main' | 'hangup';

export async function voicemailAccess(ctx: Ctx, s: CallSession, mailboxId: string | null): Promise<void> {
  const t = s.tenant!;
  await s.ensureAnswered(ctx.ari);
  if (!mailboxId || !t.mailboxes.has(mailboxId)) {
    await playOnce(ctx, s, P.noMessages);
    return;
  }
  const reader = new DigitReader(ctx, s);
  try {
    let timeouts = 0;
    for (;;) {
      const c = await ctx.repo.countVoicemails(t.id, mailboxId);
      const prompts = [P.youHave, `number:${c.new}`, P.newMsgs, P.messages, P.mainMenu];
      const d = await reader.prompt(prompts, MENU_WAIT_SEC);
      if (d === null) {
        if (++timeouts >= MAX_MENU_TIMEOUTS) break;
        continue;
      }
      timeouts = 0;
      let r: ListResult = 'main';
      if (d === '1') r = await playList(ctx, s, reader, mailboxId, false);
      else if (d === '3') {
        const d2 = await reader.digit(MENU_WAIT_SEC);
        if (d2 === '1') r = await playList(ctx, s, reader, mailboxId, true);
      } else if (d === '*') break;
      if (r === 'hangup') return;
    }
    await playOnce(ctx, s, P.goodbye).catch(() => {});
  } finally {
    reader.close();
  }
}

/** Play the new (saved=false) or saved messages one by one with the Unity keys. */
async function playList(ctx: Ctx, s: CallSession, reader: DigitReader, mailboxId: string, saved: boolean): Promise<ListResult> {
  const t = s.tenant!;
  const msgs = await ctx.repo.listVoicemails(t.id, mailboxId, saved);
  if (msgs.length === 0) {
    await playOnce(ctx, s, P.noMessages);
    return 'main';
  }
  for (let i = 0; i < msgs.length; ) {
    const action = await playMessage(ctx, s, reader, msgs[i]!);
    if (action === 'save') {
      if (!saved) await ctx.repo.saveVoicemail(t.id, msgs[i]!.id);
      await playOnce(ctx, s, P.saved);
      i++;
    } else if (action === 'delete') {
      await ctx.repo.deleteVoicemail(t.id, msgs[i]!.id);
      await playOnce(ctx, s, P.deleted);
      i++;
    } else if (action === 'next') {
      i++;
    } else if (action === 'main') {
      return 'main';
    }
  }
  await playOnce(ctx, s, P.noMore);
  return 'main';
}

type MsgAction = 'save' | 'delete' | 'next' | 'main';

async function playMessage(ctx: Ctx, s: CallSession, reader: DigitReader, m: VoicemailMsg): Promise<MsgAction> {
  const uri = await ctx.media.objectUri(m.mediaId, m.objectKey);
  for (;;) {
    // ---- during playback ----
    let d: string | null = uri ? await reader.prompt([uri], 0) : null;
    if (d === '1') continue; // restart
    if (d === '2') return 'save';
    if (d === '3') return 'delete';
    // '#' (first of "##") or the message simply ended: after-playback menu.
    let timeouts = 0;
    for (;;) {
      d = await reader.prompt([P.afterMenu], MENU_WAIT_SEC);
      if (d === null) {
        if (++timeouts >= MAX_MENU_TIMEOUTS) return 'main';
        continue;
      }
      if (d === '1') break; // replay
      if (d === '2') return 'save';
      if (d === '3') return 'delete';
      if (d === '#') return 'next';
    }
  }
}
