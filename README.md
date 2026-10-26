# stalker-lab-api

Backend Stalker Lab (АРХИТЕКТУРА v0.2, неделя 2): identity + INVITE-ONLY + **журнал (ядро продукта)** + дисциплина из журнала + кодекс.
NestJS 10 (module-per-domain) + TypeScript strict + PostgreSQL (raw `pg`, канон invest-pool).
`main.ts` — только бутстрап; анти-паттерн invest-pool (монолит 1794 строки) не переносится.

## Запуск локально

Вариант A — системный PostgreSQL (unix socket + peer auth, как в каноне):

```bash
createdb stalker_lab            # один раз (dev-база)
cp .env.example .env            # указать BOT_TOKEN
npm install
npm run migrate                 # migrations/*.sql → схема_migrations tracking
npm run dev                     # :8910
```

Вариант B — docker compose (postgres:16 на хост-порту **5433**, т.к. 5432 занят):

```bash
docker compose up -d db
DATABASE_URL=postgres://stalker:stalker@127.0.0.1:5433/stalker_lab npm run migrate
DATABASE_URL=postgres://stalker:stalker@127.0.0.1:5433/stalker_lab BOT_TOKEN=<token> npm run dev
```

## Тесты

```bash
npm test
```

Тесты требуют локальный PostgreSQL с peer-auth (unix socket, user `zeon`) — как в каноне
invest-pool. Используется база `stalker_lab_test` (создаётся автоматически, при прогоне
схема сносится и накатывается заново). `DATABASE_URL` в тестах игнорируется, чтобы не
задеть дев/прод базу.

## curl-флоу: make-invite → auth → me

```bash
# 1) сгенерировать инвайт (ботстрап: created_by NULL; позже --by <userId> --quota N)
INVITE=$(npm run --silent make-invite)
echo "$INVITE"                          # {"code":"...","createdBy":null,"quota":1}
CODE=$(node -e 'console.log(JSON.parse(process.argv[1]).code)' "$INVITE")

# 2) auth: подписанный initData + инвайт (BOT_TOKEN должен совпадать с тем, кем подписано initData)
INIT_DATA=$(node -e '
  const {createHmac}=require("crypto");
  const T=process.env.BOT_TOKEN;
  const p=new URLSearchParams({user:JSON.stringify({id:"424242",first_name:"zeon",username:null,language_code:"ru"}),auth_date:String(Math.floor(Date.now()/1000))});
  const dcs=[...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join("\n");
  const s=createHmac("sha256","WebAppData").update(T).digest();
  p.set("hash",createHmac("sha256",s).update(dcs).digest("hex"));
  console.log(p.toString());')

curl -s -X POST localhost:8910/api/v1/auth/telegram \
  -H 'content-type: application/json' \
  -d "{\"initData\":\"$INIT_DATA\",\"inviteCode\":\"$INVITE\"}"

# 3) me: stateless — initData в заголовке на каждый запрос
curl -s localhost:8910/api/v1/me -H "x-telegram-init-data: $INIT_DATA"
```

Ответы: auth → `{"user":{...},"isNew":true}`; новый юзер без/с битым инвайтом →
`403 {"error":"invite_required"}` (аккаунт не создаётся); битая подпись/просрочка
initData (±24ч) → `401 {"error":"invalid_init_data"}`; 6-я попытка с IP за минуту →
`429 {"error":"rate_limited"}` (+ запись в audit_log).

## Журнал (неделя 2) — ядро продукта

Все эндпоинты за `x-telegram-init-data`; данные — только свои (чужая сессия → `403 forbidden`).

| Endpoint | Что делает | Дисциплина |
|---|---|---|
| `POST /api/v1/journal/entries` `{date, plan}` | сессия-вылазка дня; **одна на день** (`UNIQUE(user_id,date)` → дубль `409 entry_exists`) | `journal_entry` **+5** |
| `POST /api/v1/journal/entries/:id/trades` `{sym, dir: long\|short, entry, stop, exit, r?, setup?, violation_code?}` | сделка только в **свою открытую** сессию (закрыта → `403 entry_closed`); `violation_code` ∈ `codex_rules` (иначе `400 unknown_violation_code`) | `journal_trade` **+5**; сделка с нарушением — **без баллов** + `audit_log(codex_violation)` |
| `PATCH /api/v1/journal/entries/:id` `{review, status:"closed"}` | разбор дня закрывает сессию; повтор → `409 entry_closed` | `journal_review` **+3** |
| `GET /api/v1/journal/entries?from&to` | свои сессии (date DESC, `tradesCount`); `from`/`to` опциональны, включительно, `YYYY-MM-DD` | — |
| `GET /api/v1/journal/entries/:id` | сессия + её `trades` | — |
| `GET /api/v1/me/stats` | `{points, events, byType}` из discipline-ledger | — |

- Гонки закрыты атомарными условными UPDATE и `SELECT … FOR SHARE` перед INSERT сделки
  (нед3-фикс): «trade против закрытия» и «двойное закрытие» не проходят.
- Инвариант дисциплины (review #5): повторное начисление тем же ключом — no-op; если
  существующее событие с другими `points` — расхождение логируется (ledger не молчит).
- Кодекс: `codex_rules` (5 принципов) — сид миграции 004: `risk_moved` (Снаряжение дороже
  артефакта), `no_journal_entry` (Каждая вылазка — урок), `no_setup` (Зона не обещает),
  `no_disclosure` (Тишина — признак опасности), `overtrade` (Сталкер не бросает своих).
- Глобальный exception-filter: ВСЕ ошибки — единый контракт `{error: "<code>"}` (review #10),
  включая nest-дефолты (404 маршрута → `not_found`, битый JSON-body → `invalid_request`).
- Guard-отказы (401/403 без заголовка / битая подпись / неизвестный юзер / blocked) —
  в `audit_log` с деталями (review #4).
- Health: `GET /api/v1/health` → `{"status":"ok","db":"ok"}`; БД лежит → `503 db_unavailable`.

Полный флоу нед2 одной командой (нужен запущенный `npm run dev`):
`PGDATABASE=stalker_lab scripts/flow-week2.sh` — auth → entry → trade (чистый + с
нарушением) → 409-дубль → review → 403-в-закрытую → `/me/stats` = 5+5+3=13.

Известный трейд-офф MVP: у `POST /trades` нет клиентского идемпотентного ключа — сетевой
ретрай может задвоить сделку (баллы дисциплины при этом НЕ дублируются, каждая строка
сделки — отдельное событие). Идемпотентный ключ — кандидат в нед3+.

## Академия (неделя 3) — курс из книги

Курс `kodex` = 11 глав книги «Кодекс рыночного сталкера»: текст главы с полевыми
заметками = `body_md`, «Проверь себя» = квиз (3 вопроса × 3 варианта). Контент-сид —
миграция `006_academy_seed.sql` (сгенерирована `scripts/build-academy-seed.ts` из
глав-черновиков; регенерация перезапишет файл).

Все эндпоинты за `x-telegram-init-data`; локаль `?lang=ru|en` (default `ru`), en без
перевода фолбэчит на ru пер-полево (`lesson_translations`, i18n с первого дня).

| Endpoint | Что делает |
|---|---|
| `GET /api/v1/academy/courses?lang=` | `[{slug, title, lessons: [{ord, slug, title, passed}]}]` |
| `GET /api/v1/academy/lessons/:slug?lang=` | `{slug, ord, title, body_md, quiz: [{question, options[3]}], passed}` — **без поля-ответа** |
| `POST /api/v1/academy/lessons/:slug/quiz` `{question: 0..2, answer: 0..2}` | ответ на один вопрос → `{correct, explanation?, passed}` |
| `GET /api/v1/academy/progress` | `{passed_lessons: [slug…], points}` |

- **Лестница книги**: урок N+1 недоступен (и контент, и квиз), пока не пройден N →
  `403 lesson_locked`. Первый урок открыт всегда.
- Урок пройден = **верных ≥ 2 из 3** вопросов (верные копятся в `lesson_progress.quiz_state`,
  неверный можно переспросить) → `academy_lesson` **+20** в discipline-ledger, идемпотентно.
- Пояснение (`explanation`) отдаётся только к верному ответу — не подсказываем.

## Рефералка (неделя 3) — анти-MLM

Только счётчики приглашённых. Никаких оборотов, комиссий, процентов — в ответах их
физически нет.

| Endpoint | Что делает |
|---|---|
| `POST /api/v1/referrals/invite` | свой код `{code: "r_"+8 символов}`; **лимит 3 активных** (не погашенных) → `409 invite_limit_reached`; ранг вырастет — лимит вырастет |
| `GET /api/v1/referrals` | `{invited: [{username?, first_name?, joined_at, is_active_journal}], count}` — только свои |

Реферальный бейдж: вход НОВОГО юзера по коду юзера X (`created_by` кода) → строка в
`referrals` (атомарно в tx создания аккаунта; `UNIQUE(invited_uid)` — у приглашённого
ровно один реферер). CLI/бутстрап-коды (`created_by IS NULL`) привязку не создают.
`is_active_journal` = была хоть одна запись в журнале.

## Фиксы ревью нед2 (закрыты в нед3)

1. **trade против закрытия**: перед `INSERT` сделки — `SELECT … WHERE status='draft' FOR SHARE`:
   tx сделки держит SHARE-лок на строке сессии, параллельное закрытие ждёт коммита —
   «закрытие сквозь сделку» невозможно (раньше был только атомарный INSERT..SELECT,
   не закрывавший окно между snapshot и коммитом).
2. **guard-отказы через authRateLimiter** (общий с `/auth`): спам-поток с одного IP после
   исчерпания лимита получает `429` БЕЗ audit-записи — audit_log не заливается.
3. **clamp будущей даты**: `date > today+1d (UTC)` → `400 invalid_request` (допуск +1d на
   таймзону клиента); прошлые даты свободны — дебриф задним числом легален.
4. **Канон дня дисциплины** (зафиксировано в коде): день события = `entry.date`, который
   задал юзер, а не `created_at`.

## Структура (module-per-domain)

```
src/
  main.ts                  # только бутстрап
  app.module.ts            # импорт доменов + shutdown (закрытие пула pg)
  config.ts                # env: BOT_TOKEN, PORT, DATABASE_URL
  db/db.ts                 # raw pg pool + tx (канон invest-pool/src/db.ts)
  common/
    tg-auth.ts             # verifyInitData: HMAC-SHA256, freshness ±24ч, timing-safe (канон tgAuth.ts)
    rate-limit.ts          # in-process sliding window, 5/мин/IP на auth
    guards/tma-auth.guard.ts  # stateless per-request: заголовок x-telegram-init-data
    errors.ts, audit.ts, ip.ts
  modules/
    identity/              # POST /api/v1/auth/telegram, GET /api/v1/me (+ реферальная привязка в tx)
    invites/               # одноразовые коды: consume в tx (возвращает created_by), create (CLI)
    journal/               # нед2: entries/trades/review + дисциплина в tx; нед3: FOR SHARE-фикс
    discipline/            # awardDisciplinePoints() ledger + GET /me/stats + инвариант
    academy/               # нед3: курс kodex из книги, квизы, лестница уроков
    referrals/             # нед3: r_-инвайты юзера + список приглашённых (только счётчики)
    health/                # GET /api/v1/health (+SELECT 1)
migrations/                # 001_identity … 005_academy, 006_academy_seed, 007_referrals
scripts/                   # migrate.ts, make-invite.ts, build-academy-seed.ts,
                           # flow-week2.sh, flow-week3.sh (демо-флоу)
test/                      # auth.e2e, journal.e2e, discipline, academy.e2e, referrals.e2e,
                           # week3-fixes (jest, runInBand — файлы делят одну тест-БД)
```

## Правила недели 1

- **INVITE-ONLY**: новый юзер = валидный initData + валидный одноразовый инвайт;
  погашение кода и создание аккаунта — одна транзакция (битый код → rollback, сирот нет).
- **Stateless**: без сессий/токенов, initData проверяется на каждый запрос (обмен на
  токен — V1).
- **Дисциплина — ledger-only**: `UNIQUE(user_id,event_type,ref_type,ref_id)` +
  `ON CONFLICT DO NOTHING`; повторное начисление — no-op; расхождение points при
  повторе — лог-инвариант.
- **Журнал — источник дисциплины** (нед2): entry +5 / trade +5 (без нарушения) / review +3,
  начисление в той же tx, что и запись журнала.
- Деплой не входит в недели 1–2 (деплоит владелец).
