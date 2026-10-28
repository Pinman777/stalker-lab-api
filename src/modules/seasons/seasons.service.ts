import { db } from '../../db/db';

/** Сезоны-рейды: лига считается на лету из журнала за окно сезона.
 *  Лестница (из макета Raids): бумажная → деревянная → каменная → железная →
 *  золотая → платиновая (последняя — только приглашение Кураторов, вручную). */

export interface SeasonRow {
  id: string;
  code: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  fund_usd: number | null;
  status: 'active' | 'finished';
}

export interface SeasonMetrics {
  user_id: string;
  nick: string;
  days: number;        // дней с записью в журнале (в окне сезона)
  trades: number;      // сделок (созданных в окне)
  r_sum: number;       // ΣR
  violations: number;  // сделок с нарушением кодекса
  streak: number;      // макс. серия дней журнала подряд (в окне)
  score: number;       // ΣR × доля чистых сделок (сортировка лидерборда)
}

export interface LeagueStep {
  tier: number;
  code: 'paper' | 'wooden' | 'stone' | 'iron' | 'gold' | 'platinum';
  req: { days?: number; r?: number; streak?: number; clean?: boolean; invite?: boolean };
}

export const LADDER: LeagueStep[] = [
  { tier: 1, code: 'paper', req: {} },
  { tier: 2, code: 'wooden', req: { days: 7, r: 0 } },
  { tier: 3, code: 'stone', req: { days: 21, r: 0.5, streak: 5 } },
  { tier: 4, code: 'iron', req: { days: 50, r: 0.8, streak: 10 } },
  { tier: 5, code: 'gold', req: { days: 100, r: 1.0, clean: true } },
  { tier: 6, code: 'platinum', req: { invite: true } },
];

function meets(m: SeasonMetrics, s: LeagueStep): boolean {
  const r = s.req;
  if (r.days !== undefined && m.days < r.days) return false;
  if (r.r !== undefined && m.r_sum < r.r) return false;
  if (r.streak !== undefined && m.streak < r.streak) return false;
  if (r.clean && m.violations > 0) return false;
  if (r.invite) return false; // только вручную Кураторами
  return true;
}

export function leagueOf(m: SeasonMetrics): { tier: number; code: LeagueStep['code'] } {
  let best: LeagueStep = LADDER[0];
  for (const s of LADDER) if (s.tier > 1 && meets(m, s)) best = s;
  return { tier: best.tier, code: best.code };
}

/** Прогресс к следующей лиге: что не хватает. */
export function nextStep(m: SeasonMetrics): { step: LeagueStep; missing: { days?: number; r?: number; streak?: number; violations?: number } } | null {
  const cur = leagueOf(m);
  const next = LADDER.find((s) => s.tier === cur.tier + 1);
  if (!next || next.req.invite) return null;
  const missing: { days?: number; r?: number; streak?: number; violations?: number } = {};
  if (next.req.days !== undefined && m.days < next.req.days) missing.days = next.req.days - m.days;
  if (next.req.r !== undefined && m.r_sum < next.req.r) missing.r = Math.round((next.req.r - m.r_sum) * 100) / 100;
  if (next.req.streak !== undefined && m.streak < next.req.streak) missing.streak = next.req.streak - m.streak;
  if (next.req.clean && m.violations > 0) missing.violations = m.violations;
  return { step: next, missing };
}

async function currentSeason(): Promise<SeasonRow | null> {
  const r = await db.query<SeasonRow>(
    `SELECT id::text, code, title, starts_at, ends_at, fund_usd, status
     FROM seasons
     WHERE starts_at <= now() AND now() < ends_at AND status = 'active'
     ORDER BY starts_at DESC LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

interface RawRow {
  user_id: string;
  nick: string | null;
  days: number;
  dates: string[] | null;
  trades: number;
  r_sum: string | null;
  violations: number;
}

/** Метрики всех участников сезона (юзеры с записями/сделками в окне). */
export async function seasonBoard(season: SeasonRow): Promise<SeasonMetrics[]> {
  const r = await db.query<RawRow>(
    `SELECT u.id::text AS user_id,
            COALESCE(u.username, u.first_name, 'stalker') AS nick,
            COUNT(DISTINCT je.date) AS days,
            (ARRAY_AGG(DISTINCT to_char(je.date, 'YYYY-MM-DD'))) AS dates,
            COUNT(jt.id) AS trades,
            COALESCE(SUM(jt.r), 0) AS r_sum,
            COUNT(jt.id) FILTER (WHERE jt.violation_code IS NOT NULL) AS violations
     FROM journal_entries je
     JOIN users u ON u.id = je.user_id
     LEFT JOIN journal_trades jt
            ON jt.entry_id = je.id
           AND jt.created_at >= $1 AND jt.created_at < $2
     WHERE je.date >= $1::date AND je.date <= $2::date
     GROUP BY u.id, u.username, u.first_name`,
    [season.starts_at, season.ends_at],
  );
  return r.rows.map((row) => {
    const dates = [...(row.dates ?? [])].sort();
    let streak = 0;
    let run = 0;
    let prev: string | null = null;
    for (const d of dates) {
      if (prev) {
        const gap = (Date.parse(d + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) / 86400000;
        run = gap === 1 ? run + 1 : 1;
      } else run = 1;
      if (run > streak) streak = run;
      prev = d;
    }
    const trades = Number(row.trades);
    const violations = Number(row.violations);
    const rSum = Number(row.r_sum ?? 0);
    const cleanRatio = trades > 0 ? (trades - violations) / trades : 0;
    return {
      user_id: row.user_id,
      nick: row.nick ?? 'stalker',
      days: Number(row.days),
      trades,
      r_sum: Math.round(rSum * 100) / 100,
      violations,
      streak,
      score: Math.round(rSum * cleanRatio * 100) / 100,
    };
  });
}

export interface SeasonDto {
  season: {
    code: string;
    title: string;
    starts_at: string;
    ends_at: string;
    status: string;
    fund_usd: number | null;
    days_left: number;
    total_days: number;
    participants: number;
  };
  me: (SeasonMetrics & { rank: number | null; league: { tier: number; code: string }; next: ReturnType<typeof nextStep> }) | null;
}

export async function getSeasonDto(userId: string | null): Promise<SeasonDto> {
  const season = await currentSeason();
  if (!season) {
    return {
      season: { code: '', title: '', starts_at: '', ends_at: '', status: 'none', fund_usd: null, days_left: 0, total_days: 0, participants: 0 },
      me: null,
    };
  }
  const board = await seasonBoard(season);
  const sorted = [...board].sort((a, b) => b.score - a.score || b.r_sum - a.r_sum);
  const daysLeft = Math.max(0, Math.ceil((season.ends_at.getTime() - Date.now()) / 86400000));
  const totalDays = Math.ceil((season.ends_at.getTime() - season.starts_at.getTime()) / 86400000);
  const base = {
    code: season.code,
    title: season.title,
    starts_at: season.starts_at.toISOString(),
    ends_at: season.ends_at.toISOString(),
    status: season.status,
    fund_usd: season.fund_usd,
    days_left: daysLeft,
    total_days: totalDays,
    participants: board.length,
  };
  if (!userId) return { season: base, me: null };
  const mine = board.find((m) => m.user_id === String(userId));
  if (!mine) {
    const zero: SeasonMetrics = { user_id: String(userId), nick: '', days: 0, trades: 0, r_sum: 0, violations: 0, streak: 0, score: 0 };
    return { season: base, me: { ...zero, rank: null, league: leagueOf(zero), next: nextStep(zero) } };
  }
  const rank = sorted.findIndex((m) => m.user_id === String(userId)) + 1;
  return { season: base, me: { ...mine, rank: rank || null, league: leagueOf(mine), next: nextStep(mine) } };
}

export async function getLeaderboardDto(userId: string | null): Promise<{ rows: Record<string, unknown>[] }> {
  const season = await currentSeason();
  if (!season) return { rows: [] };
  const sorted = (await seasonBoard(season)).sort((a, b) => b.score - a.score || b.r_sum - a.r_sum);
  return {
    rows: sorted.slice(0, 50).map((m, i) => ({
      rank: i + 1,
      nick: m.nick,
      days: m.days,
      trades: m.trades,
      r_sum: m.r_sum,
      disc_pct: m.trades > 0 ? Math.round(((m.trades - m.violations) / m.trades) * 100) : 100,
      streak: m.streak,
      score: m.score,
      league: leagueOf(m).code,
      me: !!userId && m.user_id === String(userId),
    })),
  };
}

/** Записан ли журнал на сегодня (для кнопки «войти в рейд»). */
export async function journaledToday(userId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM journal_entries WHERE user_id = $1 AND date = CURRENT_DATE LIMIT 1`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}
