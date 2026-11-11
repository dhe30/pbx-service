// Shared domain types mirroring db/migrations. Rows come back camelCased (see createDb).
// Contract for the API team: docs/telephony-contract.md.

export type UserRole = 'owner' | 'staff' | 'unassigned';
export type NumberStatus = 'assigned' | 'released';
export type NumberKind = 'local' | 'toll_free';
export type RingStrategy = 'all' | 'sequential';
export type MediaKind = 'greeting' | 'recording' | 'voicemail';
export type AccountStatus = 'active' | 'past_due';

/** cdrs.direction (spec §5: incoming, outgoing, internal). */
export type CdrDirection = 'incoming' | 'outgoing' | 'internal';
/** cdrs.outcome (spec §5: answered, busy, no answer, failed, blocked). */
export type CdrOutcome = 'answered' | 'busy' | 'no_answer' | 'failed' | 'blocked';
export type PstnVendor = 'us' | 'intl';

/** Object store key layout, shared by api (greetings) and ari-app (recordings, voicemail). */
export function mediaObjectKey(tenantId: string, kind: MediaKind, mediaId: string, ext = 'wav'): string {
  return `tenants/${tenantId}/${kind}/${mediaId}.${ext}`;
}

/** Postgres NOTIFY channels the ARI app listens on (fired by triggers in the migrations). */
export const NOTIFY_CONFIG_CHANNEL = 'pbx_config'; // payload: tenant id
export const NOTIFY_RATES_CHANNEL = 'pbx_rates'; // payload: '' (rate decks or call_pricing changed)
