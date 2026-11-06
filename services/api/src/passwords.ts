import argon2 from 'argon2';

// Dashboard passwords (users.password_hash). argon2id with the library defaults
// (64 MiB memory, 3 passes): ~50-100 ms per hash, run on libuv's thread pool, not the event loop.
// Not used for SIP passwords: Kamailio needs those in plaintext (CLAUDE.md §6).

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
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
