import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/passwords.js';

describe('password hashing', () => {
  it('uses argon2id with the OWASP minimum parameters', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('still verifies hashes made with the earlier (library default) parameters', async () => {
    const old = await argon2.hash('correct horse battery', { type: argon2.argon2id });
    expect(old).toMatch(/m=65536,t=3,p=4/);
    expect(await verifyPassword(old, 'correct horse battery')).toBe(true);
  });
});
