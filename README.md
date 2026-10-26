# stalker-lab-api

Backend Stalker Lab (АРХИТЕКТУРА v0.2, неделя 1): identity + INVITE-ONLY + каркас доменов.
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
INVITE=$(npm run make-invite --silent | jq -r .code)

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
    identity/              # POST /api/v1/auth/telegram, GET /api/v1/me
    invites/               # одноразовые коды: consume в tx, create (CLI)
    journal/               # скелет нед2: схема в миграциях, эндпоинты 501
    discipline/            # awardDisciplinePoints(): ledger, идемпотентно
    health/                # GET /api/v1/health
migrations/                # 001_identity, 002_journal, 003_discipline
scripts/                   # migrate.ts (runner), make-invite.ts (CLI)
test/                      # auth.e2e.test.ts, discipline.test.ts (jest, runInBand)
```

## Правила недели 1

- **INVITE-ONLY**: новый юзер = валидный initData + валидный одноразовый инвайт;
  погашение кода и создание аккаунта — одна транзакция (битый код → rollback, сирот нет).
- **Stateless**: без сессий/токенов, initData проверяется на каждый запрос (обмен на
  токен — V1).
- **Дисциплина — ledger-only**: `UNIQUE(user_id,event_type,ref_type,ref_id)` +
  `ON CONFLICT DO NOTHING`; повторное начисление — no-op.
- Деплой не входит в неделю 1 (деплоит владелец).
