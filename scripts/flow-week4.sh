#!/bin/bash
# Полный нед4-флоу (killer-фича «сделки добавляются сами»):
# guide → bind (мок BingX проверяет подпись) → bind-дубль 409 → sync ×2 (дедуп) →
# journal/auto → me/stats (auto-факты БЕЗ баллов дисциплины) → unbind.
# Сам поднимает мок BingX (:8931) и API (:8912); psql для проверки шифрования в БД.
set -e
cd "$(dirname "$0")/.." # репо-корень

TOKEN="${BOT_TOKEN:-700000002:dev-flow-token}"
PORT=8912
BASE="http://localhost:$PORT/api/v1"
export PGDATABASE="${PGDATABASE:-stalker_lab}"
export CONN_ENC_KEY="${CONN_ENC_KEY:-flow-only-enc-key-not-for-prod}"
export BINGX_API_BASE="http://127.0.0.1:8931"
export BINGX_MOCK_API_KEY="flow-bingx-api-key-abcdefghijklmnop"
export BINGX_MOCK_API_SECRET="flow-bingx-secret-0123456789abcdefghij"
API_KEY="$BINGX_MOCK_API_KEY"
API_SECRET="$BINGX_MOCK_API_SECRET"

# ── подъём мока BingX + API, прибираемся на выходе ──
node scripts/bingx-mock.js & MOCK_PID=$!
PORT=$PORT BOT_TOKEN="$TOKEN" npx ts-node src/main.ts >/tmp/flow-week4-api.log 2>&1 & API_PID=$!
trap 'kill $MOCK_PID $API_PID 2>/dev/null || true' EXIT
for i in $(seq 1 50); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done
echo "== 0) мок BingX + API подняты (health: $(curl -s "$BASE/health")) =="

sign_init_data() { node -e '
  const {createHmac}=require("crypto");
  const T=process.argv[1], id=process.argv[2], first=process.argv[3]||"Механик";
  const p=new URLSearchParams({user:JSON.stringify({id:String(id),first_name:first,username:null,language_code:"ru"}),auth_date:String(Math.floor(Date.now()/1000))});
  const dcs=[...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join("\n");
  const s=createHmac("sha256","WebAppData").update(T).digest();
  p.set("hash",createHmac("sha256",s).update(dcs).digest("hex"));
  console.log(p.toString());' "$TOKEN" "$1" "$2"; }

jget() { node -e 'const o=JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((a,k)=>a?.[k],o))' "$1" "$2"; }

INVITE=$(npm run --silent make-invite | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')
INIT_A=$(sign_init_data 889001 "АвтоСталкер")
curl -s -X POST "$BASE/auth/telegram" -H 'content-type: application/json' \
  -d "{\"initData\":\"$INIT_A\",\"inviteCode\":\"$INVITE\"}" >/dev/null
AUTH_A="x-telegram-init-data: $INIT_A"
echo "== 1) юзер зарегистрирован =="

echo "== 2) connections/bingx/guide (фронт покажет шаги) =="
curl -s "$BASE/connections/bingx/guide" -H "$AUTH_A" | head -c 300
echo " …"

echo "== 3) bind: ключ проверен живым balance-запросом к моку (каноническая подпись) =="
BIND=$(curl -s -X POST "$BASE/connections/bingx/bind" -H "$AUTH_A" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$API_KEY\",\"apiSecret\":\"$API_SECRET\"}")
echo "$BIND"
echo "   masked: $(jget "$BIND" masked)"

echo "== 3b) секрет в БД зашифрован (AES-256-GCM, v1:…), НЕ в открытом виде =="
psql -qtAX -d "$PGDATABASE" -c "SELECT left(api_secret_enc, 40) || '…' FROM connections WHERE venue='bingx' ORDER BY id DESC LIMIT 1"
SECRET_IN_DB=$(psql -qtAX -d "$PGDATABASE" -c "SELECT count(*) FROM connections WHERE api_secret_enc LIKE '%$API_SECRET%'")
echo "   plaintext-секрет в БД: строк со вхождением = $SECRET_IN_DB (ожидаем 0)"

echo "== 4) bind повторно → 409 connection_exists =="
curl -s -o /dev/null -w '%{http_code} ' -X POST "$BASE/connections/bingx/bind" -H "$AUTH_A" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$API_KEY\",\"apiSecret\":\"$API_SECRET\"}"
curl -s -X POST "$BASE/connections/bingx/bind" -H "$AUTH_A" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$API_KEY\",\"apiSecret\":\"$API_SECRET\"}"
echo

echo "== 5) GET /connections (masked, last_sync_at) =="
curl -s "$BASE/connections" -H "$AUTH_A"
echo

echo "== 6) sync №1 → импорт закрытых позиций (открытая не берётся) =="
SYNC1=$(curl -s -X POST "$BASE/connections/bingx/sync" -H "$AUTH_A")
echo "$SYNC1"

echo "== 7) sync №2 → ДЕДУП: 0 новых, те же строки перезаписаны =="
SYNC2=$(curl -s -X POST "$BASE/connections/bingx/sync" -H "$AUTH_A")
echo "$SYNC2"
echo "   imported#1=$(jget "$SYNC1" imported) imported#2=$(jget "$SYNC2" imported) — дублей нет"

echo "== 8) journal/auto (сделки добавились сами) =="
curl -s "$BASE/journal/auto" -H "$AUTH_A" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const t=JSON.parse(s).trades; console.log(`trades=${t.length}`);
  for (const x of t) console.log(`  ${x.symbol} ${x.side} entry=${x.entryPrice} exit=${x.exitPrice} pnl=${x.pnlUsd} lev=${x.leverage} close=${x.closeTime.slice(0,10)}`)})'

echo "== 9) me/stats: auto-факты есть, баллы дисциплины за них НЕ начислены (идеология) =="
curl -s "$BASE/me/stats" -H "$AUTH_A" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const o=JSON.parse(s); console.log(`points=${o.points} events=${o.events} autoTradesCount=${o.autoTradesCount} autoPnlSum=${o.autoPnlSum}`)})'

echo "== 10) unbind → авто-сделки каскадом, список пуст =="
curl -s -X POST "$BASE/connections/bingx/unbind" -H "$AUTH_A"
echo
curl -s "$BASE/connections" -H "$AUTH_A"
echo
LEFT=$(curl -s "$BASE/journal/auto" -H "$AUTH_A" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).trades.length))')
echo "   авто-сделок после unbind: $LEFT (ожидаем 0)"

echo "== флоу нед4 пройден =="
