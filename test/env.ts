// setupFiles: до импорта src (config читает env при импорте).
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '7000000001:test-stalker-token';
process.env.PGDATABASE = process.env.PGDATABASE || 'stalker_lab_test';
// Тесты всегда на локальном peer-auth pg (канон invest-pool): DATABASE_URL игнорируем,
// чтобы случайно не снести схему дев/прод базы.
delete process.env.DATABASE_URL;
