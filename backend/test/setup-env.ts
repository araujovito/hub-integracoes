// Unit tests import modules that load `src/config.ts`, which validates the
// environment at import time. Under Vitest NODE_ENV is `test`, so `.env` is not
// read. Fill only missing variables with inert placeholders so `yarn test`
// works on a fresh clone. Nothing connects to these URLs in unit tests.
//
// Integration runs are left untouched: they must receive real connection
// settings explicitly and fail loudly if they are absent.
if (process.env.RUN_INTEGRATION_TESTS !== 'true') {
  const placeholders: Record<string, string> = {
    DATABASE_URL: 'postgres://unit:unit@127.0.0.1:1/unit-tests-do-not-connect',
    REDIS_URL: 'redis://127.0.0.1:1',
    WEBHOOK_SECRET: 'unit-test-placeholder-webhook-secret-32+',
    ADMIN_API_TOKEN: 'unit-test-placeholder-admin-token-32-chars',
  };
  for (const [name, value] of Object.entries(placeholders)) process.env[name] ??= value;
}
