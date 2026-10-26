/** Тесты: e2e по HTTP (канон invest-pool — fetch на слушающий порт) + service-тесты.
 *  runInBand: одна общая тестовая БД (stalker_lab_test, локальный peer-auth pg). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 30000,
};
