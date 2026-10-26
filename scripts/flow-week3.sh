#!/bin/bash
# Полный нед3-флоу: me → academy/courses → lesson 1 → quiz pass → progress → referrals
# (+ регистрация приглашённого по r_-коду → referrals список).
# Требует: сервер на :8910 (npm run dev / dist), PGDATABASE=stalker_lab, psql.
set -e
cd "$(dirname "$0")/.." # репо-корень
TOKEN="${BOT_TOKEN:-700000002:dev-flow-token}"
BASE="http://localhost:8910/api/v1"

sign_init_data() { node -e '
  const {createHmac}=require("crypto");
  const T=process.argv[1], id=process.argv[2], first=process.argv[3]||"Механик";
  const p=new URLSearchParams({user:JSON.stringify({id:String(id),first_name:first,username:null,language_code:"ru"}),auth_date:String(Math.floor(Date.now()/1000))});
  const dcs=[...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join("\n");
  const s=createHmac("sha256","WebAppData").update(T).digest();
  p.set("hash",createHmac("sha256",s).update(dcs).digest("hex"));
  console.log(p.toString());' "$TOKEN" "$1" "$2"; }

jget() { node -e 'const o=JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((a,k)=>a?.[k],o))' "$1" "$2"; }

echo "== 0) бутстрап-инвайт + auth юзера A =="
INVITE=$(npm run --silent make-invite | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')
INIT_A=$(sign_init_data 888001 "Сталкер")
curl -s -X POST "$BASE/auth/telegram" -H 'content-type: application/json' \
  -d "{\"initData\":\"$INIT_A\",\"inviteCode\":\"$INVITE\"}"
echo
AUTH_A="x-telegram-init-data: $INIT_A"

echo "== 1) /me =="
curl -s "$BASE/me" -H "$AUTH_A"
echo

echo "== 2) academy/courses: курс kodex, 11 уроков =="
curl -s "$BASE/academy/courses" -H "$AUTH_A" | head -c 400
echo " …"

echo "== 3) lesson-01 (заголовок + первый вопрос без поля-ответа) =="
LESSON=$(curl -s "$BASE/academy/lessons/lesson-01" -H "$AUTH_A")
echo "title: $(jget "$LESSON" title)"
echo "quiz[0]: $(echo "$LESSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s).quiz[0];console.log(q.question);console.log("options:",JSON.stringify(q.options));console.log("answer_idx утёк?","answer_idx" in q)})')"

echo "== 3b) lesson-02 до прохождения 1-го → 403 lesson_locked =="
curl -s "$BASE/academy/lessons/lesson-02" -H "$AUTH_A"
echo

echo "== 4) квиз: правильные ответы читаем из сида (dev-flow), отвечаем на 2 из 3 =="
ANSWERS=$(psql -qtAX -d stalker_lab -c \
  "SELECT string_agg(q->>'answer_idx', ',' ORDER BY t.ord) FROM lessons l CROSS JOIN LATERAL jsonb_array_elements(l.quiz) WITH ORDINALITY AS t(q, ord) WHERE l.slug='lesson-01'")
echo "answer_idx урока: $ANSWERS"
A0=$(echo "$ANSWERS" | cut -d, -f1); A1=$(echo "$ANSWERS" | cut -d, -f2)
echo "-- вопрос 0, верный ответ $A0:"
curl -s -X POST "$BASE/academy/lessons/lesson-01/quiz" -H "$AUTH_A" -H 'content-type: application/json' \
  -d "{\"question\":0,\"answer\":$A0}"
echo
echo "-- вопрос 1, верный ответ $A1 (→ 2/3, порог пройден):"
curl -s -X POST "$BASE/academy/lessons/lesson-01/quiz" -H "$AUTH_A" -H 'content-type: application/json' \
  -d "{\"question\":1,\"answer\":$A1}"
echo

echo "== 5) academy/progress (+20 за урок) =="
curl -s "$BASE/academy/progress" -H "$AUTH_A"
echo

echo "== 6) lesson-02 теперь открыт =="
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$BASE/academy/lessons/lesson-02" -H "$AUTH_A"

echo "== 7) referrals/invite: свой r_-код =="
R=$(curl -s -X POST "$BASE/referrals/invite" -H "$AUTH_A")
echo "$R"
RCODE=$(jget "$R" code)

echo "== 8) приглашённый юзер B входит по r_-коду =="
INIT_B=$(sign_init_data 888002 "Новичок")
curl -s -X POST "$BASE/auth/telegram" -H 'content-type: application/json' \
  -d "{\"initData\":\"$INIT_B\",\"inviteCode\":\"$RCODE\"}"
echo

echo "== 9) referrals юзера A: один приглашённый, журнал неактивен =="
curl -s "$BASE/referrals" -H "$AUTH_A"
echo
