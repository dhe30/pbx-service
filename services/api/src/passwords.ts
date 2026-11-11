import argon2 from 'argon2';

// Dashboard passwords (users.password_hash): argon2id, run on libuv's thread pool, not the event
// loop. Not used for SIP passwords: Kamailio needs those in plaintext (CLAUDE.md §6).
//
// Parameters: OWASP's minimum for argon2id (19 MiB, 2 passes, 1 lane; Password Storage Cheat
// Sheet), chosen for API latency under signup/login bursts (graded). Measured with
// loadtest/api/argon2-bench.mjs (2026-11-12, 16 vCPU, 32 concurrent): the library defaults
// (64 MiB, 3 passes, 4 lanes) gave ~28 hashes/s per process with p95 1.1 s, memory-bound, and a
// bigger thread pool didn't help; these give ~160/s with p95 0.2 s. Hashes made with the old
// parameters still verify (argon2 stores its parameters in each hash).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

// Hash of a random password, verified against when the email doesn't exist so a login for an
// unknown email takes as long as one with a wrong password (no account enumeration by timing).
const dummyHash = hashPassword(`dummy-${Math.random()}`);

/**
 * True if `password` matches `hash`. `hash` null = no such user (still spends the same time).
 * Unusable hashes (e.g. '!' for seeded users that can't log in) never match.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  try {
    if (hash === null) {
      await argon2.verify(await dummyHash, password);
      return false;
    }
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash
  }
}
