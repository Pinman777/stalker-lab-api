#!/bin/bash
# Полный нед2-флоу: auth → entry → trade (clean + violation) → review → discipline в /me/stats.
set -e
cd "$(dirname "$0")/.." # репо-корень
TOKEN="${BOT_TOKEN:-700000002:dev-flow-token}"
BASE="http://localhost:8910/api/v1"
TODAY=$(date +%F)

echo "== 0) инвайт (бутстрап) =="
INVITE=$(npm run --silent make-invite | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')
echo "code=$INVITE"

echo "== 1) подписанный initData (тем же токеном) =="
INIT_DATA=$(node -e '
  const {createHmac}=require("crypto");
  const T=process.argv[1];
  const p=new URLSearchParams({user:JSON.stringify({id:"777001",first_name:"Механик",username:"mech",language_code:"ru"}),auth_date:String(Math.floor(Date.now()/1000))});
  const dcs=[...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join("\n");
  const s=createHmac("sha256","WebAppData").update(T).digest();
  p.set("hash",createHmac("sha256",s).update(dcs).digest("hex"));
  console.log(p.toString());' "$TOKEN")

echo "== 2) auth/telegram =="
curl -s -X POST "$BASE/auth/telegram" -H 'content-type: application/json' \
  -d "{\"initData\":\"$INIT_DATA\",\"inviteCode\":\"$INVITE\"}"
echo

AUTH="x-telegram-init-data: $INIT_DATA"

echo "== 3) создать сессию дня ($TODAY) =="
ENTRY=$(curl -s -X POST "$BASE/journal/entries" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"date\":\"$TODAY\",\"plan\":\"Разведка: BTC-сквиз на открытии, риск 0.5R\"}")
echo "$ENTRY"
ENTRY_ID=$(node -e 'console.log(JSON.parse(process.argv[1]).entry.id)' "$ENTRY")

echo "== 3b) дубль того же дня → 409 =="
curl -s -o /dev/null -w '%{http_code} ' -X POST "$BASE/journal/entries" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"date\":\"$TODAY\",\"plan\":\"дубль\"}"
curl -s -X POST "$BASE/journal/entries" -H "$AUTH" -H 'content-type: application/json' -d "{\"date\":\"$TODAY\",\"plan\":\"дубль\"}"
echo

echo "== 4) чистая сделка (+5) =="
curl -s -X POST "$BASE/journal/entries/$ENTRY_ID/trades" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sym":"BTCUSDT","dir":"long","entry":100000.5,"stop":99000,"exit":102000,"r":2,"setup":"сквиз 15м"}'
echo

echo "== 5) сделка с нарушением кодекса (баллов нет, аудит есть) =="
curl -s -X POST "$BASE/journal/entries/$ENTRY_ID/trades" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sym":"ETHUSDT","dir":"short","entry":3000,"stop":3100,"exit":2950,"r":0.5,"violation_code":"risk_moved"}'
echo

echo "== 6) список за день =="
curl -s "$BASE/journal/entries?from=$TODAY&to=$TODAY" -H "$AUTH"
echo

echo "== 7) разбор дня: закрыть сессию (+3) =="
curl -s -X PATCH "$BASE/journal/entries/$ENTRY_ID" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"review":"Сквиз отработал, вторая сделка — стоп тянул, нарушение зафиксировал","status":"closed"}'
echo

echo "== 7b) сделка в закрытую → 403 =="
curl -s -X POST "$BASE/journal/entries/$ENTRY_ID/trades" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sym":"XRPUSDT","dir":"long","entry":1,"stop":0.9,"exit":1.2}'
echo

echo "== 8) детали сессии (с trades) =="
curl -s "$BASE/journal/entries/$ENTRY_ID" -H "$AUTH"
echo

echo "== 9) дисциплина: /me/stats (ожидаем 5+5+3=13) =="
curl -s "$BASE/me/stats" -H "$AUTH"
echo
