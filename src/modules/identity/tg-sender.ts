import { Injectable } from '@nestjs/common';
import { config } from '../../config';

/** Транспор сообщений юзеру через Bot API (нед5: коды web-входа).
 *  Отдельный injectable-класс: тесты подменяют sendMessageTo на singleton-инстансе
 *  (app.get(TelegramBotApiSender)), реальная сеть — только в проде. */
export interface TgSender {
  sendMessageTo(chatId: string, text: string): Promise<void>;
}

@Injectable()
export class TelegramBotApiSender implements TgSender {
  async sendMessageTo(chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!res.ok || !data?.ok) throw new Error(`tg sendMessage failed: HTTP ${res.status}`);
  }
}
