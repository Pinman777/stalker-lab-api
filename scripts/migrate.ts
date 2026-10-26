import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { db } from '../src/db/db';

/** Миграционный runner (канон invest-pool/src/scripts/migrate.ts):
 *  применяет migrations/*.sql по порядку, tracking в schema_migrations. */
async function main(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = join(process.cwd(), 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const applied = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
    if (applied.rowCount) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    console.log('applied', f);
  }
  await db.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
