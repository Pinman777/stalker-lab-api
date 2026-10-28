import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { db } from '../src/db/db';

/** Миграционный runner (канон invest-pool/src/scripts/migrate.ts):
 *  применяет migrations/*.sql по порядку, tracking в schema_migrations. */
async function main(): Promise<void> {
  // advisory lock: параллельные запуски (CI + dev) не гоняются (review #6)
  const lock = await db.query('SELECT pg_try_advisory_lock(894221) AS ok');
  if (!lock.rows[0]?.ok) { console.log('migrate: другой запуск держит лок — выходим'); await db.end(); return; }
  try {
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
  } finally {
    await db.query('SELECT pg_advisory_unlock(894221)');
    await db.end();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
