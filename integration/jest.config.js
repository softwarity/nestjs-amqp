/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/specs/**/*.spec.ts'],
  // Brokers spin up + connection + a handful of message round-trips per test:
  // 60s gives plenty of slack on cold CI runners without masking real issues.
  testTimeout: 60_000,
  globalSetup: '<rootDir>/setup.ts',
  globalTeardown: '<rootDir>/teardown.ts',
  // Single worker so RabbitMQ + Artemis containers are shared across specs
  // and we don't double-spend ports / addresses.
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
