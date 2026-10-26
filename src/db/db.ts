import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

/** Пул raw pg (канон invest-pool/src/db.ts):
 *  DATABASE_URL (TCP) — прод/docker; иначе unix socket + peer auth локально. */
const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl })
  : new Pool({ user: 'zeon', host: '/var/run/postgresql', database: process.env.PGDATABASE || 'stalker_lab' });

/** Минимальный интерфейс исполнителя SQL: ему удовлетворяют и db, и клиент транзакции. */
export interface Executor {
  query(text: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>>;
}

export interface DbClient extends Executor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export const db: DbClient = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return pool.query(text, params);
  },
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
  end() {
    return pool.end();
  },
};
