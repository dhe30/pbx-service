// Import a PSTN vendor rate deck (Course Services tab: us-vendor-rates.csv / intl-vendor-rates.csv)
// into rate_decks, replacing that vendor's rows in one transaction. Every pbx node reloads its
// in-memory rate table on the NOTIFY the table trigger sends.
//
//   DATABASE_URL=postgres://... npm run rates:import -w @pbx/ari-app -- us  ./us-vendor-rates.csv
//   DATABASE_URL=postgres://... npm run rates:import -w @pbx/ari-app -- intl ./intl-vendor-rates.csv

import { readFile } from 'node:fs/promises';
import { createDb, parseRateDeckCsv } from '@pbx/shared';

async function main(): Promise<void> {
  const [vendor, file] = process.argv.slice(2);
  if ((vendor !== 'us' && vendor !== 'intl') || !file) {
    console.error('usage: import-rates <us|intl> <file.csv>');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const rows = parseRateDeckCsv(await readFile(file, 'utf8'));
  if (rows.length === 0) throw new Error(`no rate rows found in ${file}`);
  const sql = createDb(url, { max: 1, applicationName: 'import-rates' });
  try {
    await sql.begin(async (tx) => {
      await tx`delete from rate_decks where vendor = ${vendor}`;
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000).map((r) => ({ vendor, prefix: r.prefix, destination: r.destination, per_min: r.perMin }));
        await tx`insert into rate_decks ${tx(chunk)} on conflict (vendor, prefix) do update set destination = excluded.destination, per_min = excluded.per_min`;
      }
    });
    console.log(`imported ${rows.length} ${vendor} rates from ${file}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
