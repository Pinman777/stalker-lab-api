import { createInviteCode } from '../src/modules/invites/invites.service';
import { db } from '../src/db/db';

/** Генерация инвайт-кода (INVITE-ONLY, нед1).
 *  Использование: npm run make-invite -- [--by <userId>] [--quota N]
 *  --by — id создателя (users.id); без флага — системный бутстрап-инвайт (created_by NULL). */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const by = arg('--by');
  const quotaArg = Number(arg('--quota') || 1);
  const quota = Number.isInteger(quotaArg) && quotaArg > 0 ? quotaArg : 1;
  const code = await createInviteCode(db, by ?? null, quota);
  console.log(JSON.stringify({ code, createdBy: by ?? null, quota }));
  await db.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
