import { classifyE164, type PstnVendor } from '@pbx/shared';
import type { Ctx } from './ctx.js';
import type { TenantConfig } from './tenant.js';

// Legs we place to the PSTN (course spec §1 "PSTN vendors", §3 "Outgoing calls", §5 "Usage").
//
// Path: Asterisk PJSIP endpoint vendor-<us|intl>-<edge trunk> (outbound_proxy = that edge's
// Kamailio, digest auth with the vendor credentials) -> Kamailio route TO_VENDOR (rtpengine,
// leg=vendor) -> vendor. Asterisk has no public IP, so the edge both relays and anchors media.

export type PstnPlan =
  | { ok: false; reason: 'past_due' | 'intl_disabled' | 'no_caller_id' }
  | {
      ok: true;
      vendor: PstnVendor;
      host: string;
      chargeClass: 'us' | 'intl';
      costPerMin: number;
      ratePrefix: string | null;
      callerId: string;
    };

/** Can this account place a leg to `e164` right now, and how is it routed and rated? */
export async function planPstnLeg(ctx: Ctx, t: TenantConfig, e164: string, callerId: string | null): Promise<PstnPlan> {
  // "Unpaid 24 hours after period end: past due, outgoing calls blocked." Every external leg is an
  // outgoing call we pay for (dialed, forwarded, simultaneous ring, transferred).
  if (t.status === 'past_due') return { ok: false, reason: 'past_due' };
  const cls = classifyE164(e164);
  // "Without it [international calling], calls outside the US (including other +1 countries) are blocked."
  if (cls.region === 'intl' && !t.intlCalling) return { ok: false, reason: 'intl_disabled' };
  if (!callerId) return { ok: false, reason: 'no_caller_id' };
  const rates = await ctx.cache.getRates();
  const table = cls.region === 'us' ? rates.us : rates.intl;
  const row = table.match(e164);
  return {
    ok: true,
    vendor: cls.region,
    host: cls.region === 'us' ? ctx.cfg.VENDOR_US_HOST : ctx.cfg.VENDOR_INTL_HOST,
    chargeClass: cls.region,
    costPerMin: row?.perMin ?? 0,
    ratePrefix: row?.prefix ?? null,
    callerId,
  };
}

/** ARI originate endpoint for a vendor leg through edge trunk `trunk` (edge-a, edge-b, ...). */
export function vendorEndpoint(ctx: Ctx, vendor: PstnVendor, host: string, trunk: string, e164: string): string {
  const user = ctx.cfg.VENDOR_NUMBER_FORMAT === 'e164' ? e164 : e164.replace(/^\+/, '');
  return `PJSIP/vendor-${vendor}-${trunk}/sip:${user}@${host}`;
}

/**
 * Caller ID for legs we place: "present one of the account's numbers". The extension's configured
 * number if it is (still) the account's, else the account's first number. For calls arriving on a
 * DID (forwarding, simultaneous ring, IVR -> external), the DID that was called.
 */
export function accountCallerId(t: TenantConfig, preferred: string | null | undefined): string | null {
  if (preferred && t.numbers.has(preferred)) return preferred;
  return t.accountNumbers[0] ?? null;
}
