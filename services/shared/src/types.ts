// Shared domain types mirroring db/migrations. Rows come back camelCased (see createDb).

export type UserRole = 'owner' | 'staff';
export type NumberStatus = 'assigned' | 'released';
export type RingStrategy = 'all' | 'sequential';
export type MediaKind = 'greeting' | 'recording' | 'voicemail';
export type CallDisposition = 'answered' | 'voicemail' | 'abandoned' | 'failed';

/** Object store key layout, shared by api (greetings) and ari-app (recordings, voicemail). */
export function mediaObjectKey(tenantId: string, kind: MediaKind, mediaId: string, ext = 'wav'): string {
  return `tenants/${tenantId}/${kind}/${mediaId}.${ext}`;
}
