import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/** Шифрование apiSecret подключений к биржам: AES-256-GCM (crypto builtin, без новых зависимостей).
 *
 *  Формат шифротекста (одна TEXT-колонка api_secret_enc):
 *    v1:<salt b64>:<iv b64>:<tag b64>:<ct b64>
 *
 *  Ключ выводится scrypt'ом из env CONN_ENC_KEY (passphrase произвольной длины,
 *  salt случайный на каждую запись — одинаковые секреты дают разный шифротекст).
 *  AAD = apiKey: шифротекст привязан к ключу, который нельзя «переставить»
 *  между подключениями (tamper → GCM-тег не сойдётся).
 *
 *  При отсутствии CONN_ENC_KEY throw на старте модуля (понятная ошибка запуска,
 *  а не загаданный fallback-ключ). */

const VERSION = 'v1';

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(
      'CONN_ENC_KEY is not set: ConnectionsModule cannot start. ' +
        'Set CONN_ENC_KEY (passphrase для AES-256-GCM шифрования apiSecret бирж) в env.',
    );
    this.name = 'EncryptionKeyMissingError';
  }
}

/** 32-байтный ключ AES-256 из passphrase. scrypt (memory-hard) — crypto builtin. */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

export function encryptSecret(apiKey: string, apiSecret: string): string {
  const passphrase = process.env.CONN_ENC_KEY;
  if (!passphrase) throw new EncryptionKeyMissingError();
  const salt = randomBytes(16);
  const iv = randomBytes(12); // GCM: 96-bit IV — канонический размер
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(apiKey, 'utf8'));
  const ct = Buffer.concat([cipher.update(apiSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Расшифровка; AAD/тег не сошлись (перезаписан/переставлен) → throw. */
export function decryptSecret(apiKey: string, enc: string): string {
  const passphrase = process.env.CONN_ENC_KEY;
  if (!passphrase) throw new EncryptionKeyMissingError();
  const parts = enc.split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('bad api_secret_enc format');
  const [, saltB64, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(saltB64, 'base64')),
    Buffer.from(ivB64, 'base64'),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(apiKey, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 'ABCDEFGH…YZ' — первые/последние 2 символа (UI показывает, что ключ тот). */
export function maskKey(apiKey: string): string {
  const a = apiKey.slice(0, 2).toUpperCase();
  const b = apiKey.slice(-2).toUpperCase();
  return apiKey.length <= 4 ? `${a}…` : `${a}…${b}`;
}
