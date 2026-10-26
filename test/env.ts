// setupFiles: до импорта src (config читает env при импорте).
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '7000000001:test-stalker-token';
process.env.PGDATABASE = process.env.PGDATABASE || 'stalker_lab_test';
// Тесты всегда на локальном peer-auth pg (канон invest-pool): DATABASE_URL игнорируем,
// чтобы случайно не снести схему дев/прод базы.
delete process.env.DATABASE_URL;
// нед4: ключ шифрования apiSecret бирж + мок-сервер BingX (порт ставит сам тест).
process.env.CONN_ENC_KEY = process.env.CONN_ENC_KEY || 'test-conn-enc-key-do-not-use-in-prod';
// нед5: подпись web-login JWT (LoginCodesService fail-fast без него)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.BINGX_API_BASE = 'http://127.0.0.1:1'; // перезаписывается тестом на мок-сервер
