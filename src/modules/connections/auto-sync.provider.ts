import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { db } from '../../db/db';
import { ConnectionsService } from './connections.service';

/** Авто-синк BingX: фоновый поллер закрытых позиций всех подключений.
 *  Ручной POST /sync остаётся (принудительный); поллер — обещание UI
 *  «сделки падают в журнал сами». Идемпотентность синка (UNIQUE + advisory
 *  lock) делает повторные прогоны безопасными; свежие last_sync_at (<15 мин)
 *  пропускаются, чтобы не дублировать только что отработанный ручной синк. */

const AUTO_SYNC_INTERVAL_MS = 20 * 60 * 1000; // поллер: каждые 20 минут
const AUTO_SYNC_START_DELAY_MS = 30 * 1000; // не в момент рестарта сервиса
const SKIP_IF_SYNCED_WITHIN = 15 * 60 * 1000; // свежесть последнего синка

/** Один проход по всем bingx-подключениям. Отдельная функция — для теста. */
export async function runAutoSync(svc: ConnectionsService): Promise<{ userId: string; ok: boolean; imported?: number; error?: string }[]> {
  const r = await db.query<{ user_id: string; last_sync_at: Date | null }>(
    `SELECT user_id::text, last_sync_at FROM connections WHERE venue = 'bingx'`,
  );
  const out: { userId: string; ok: boolean; imported?: number; error?: string }[] = [];
  for (const row of r.rows) {
    if (row.last_sync_at && Date.now() - new Date(row.last_sync_at).getTime() < SKIP_IF_SYNCED_WITHIN) {
      out.push({ userId: row.user_id, ok: true }); // свежесинканный — пропущен, это норма
      continue;
    }
    try {
      const res = await svc.syncBingx(row.user_id, 'system');
      out.push({ userId: row.user_id, ok: true, imported: res.imported });
    } catch (e) {
      // API-фейлы уже в audit_log (handleSyncError); сюда падают прочие (напр. sync_in_progress)
      console.warn(`[auto-sync] user=${row.user_id} skipped: ${String(e)}`);
      out.push({ userId: row.user_id, ok: false, error: String(e) });
    }
  }
  console.log(`[auto-sync] connections=${r.rowCount} done=${out.filter((x) => x.ok).length}/${out.length}`);
  return out;
}

@Injectable()
export class AutoSync implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly connections: ConnectionsService) {}

  onModuleInit(): void {
    setTimeout(() => {
      void runAutoSync(this.connections).catch((e) => console.error('[auto-sync] first tick failed:', e));
      this.timer = setInterval(() => {
        void runAutoSync(this.connections).catch((e) => console.error('[auto-sync] tick failed:', e));
      }, AUTO_SYNC_INTERVAL_MS);
    }, AUTO_SYNC_START_DELAY_MS).unref();
    console.log(`[auto-sync] поллер включён: интервал ${AUTO_SYNC_INTERVAL_MS / 60000} мин`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
