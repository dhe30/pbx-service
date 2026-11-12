import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// db/migrations is applied by dbmate on deploy (role db_schema). dbmate records each migration by
// its VERSION (the leading number), not the file name. Two files with one version broke the first
// cloud deploy (2026-11-12: 20261115000000_support_tickets + 20261115000000_unassigned_role ->
// "duplicate key value violates unique constraint schema_migrations_pkey"). The test databases
// (PGlite) apply the files by name, so nothing else catches it.

const DIR = join(import.meta.dirname, '../../../db/migrations');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('db/migrations (dbmate)', () => {
  it('every file is <14-digit version>_<name>.sql', () => {
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it('no two migrations share a version', () => {
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const v = f.split('_')[0]!;
      byVersion.set(v, [...(byVersion.get(v) ?? []), f]);
    }
    const dupes = [...byVersion].filter(([, fs]) => fs.length > 1).map(([v, fs]) => `${v}: ${fs.join(', ')}`);
    expect(dupes, 'give one of each pair a later version (see the comment above)').toEqual([]);
  });

  it('every file has a migrate:up section', () => {
    for (const f of files) expect(readFileSync(join(DIR, f), 'utf8'), f).toContain('-- migrate:up');
  });
});
