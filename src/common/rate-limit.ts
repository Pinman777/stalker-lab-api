/** In-process rate-limit (кластер/Redis — V1, АРХИТЕКТУРА §0). Скользящее окно по ключу. */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** true — пропустить; false — лимит исчерпан (попытка НЕ записывается). */
  check(key: string, now: number = Date.now()): boolean {
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }
}

/** Auth-эндпоинт: 5 попыток/мин/IP — защита от brute-force инвайт-кодов (нед1, задача 3). */
export const authRateLimiter = new SlidingWindowRateLimiter(5, 60_000);
