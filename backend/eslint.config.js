import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', URL: 'readonly', Date: 'readonly', Math: 'readonly', Promise: 'readonly', Error: 'readonly', Number: 'readonly', String: 'readonly', Object: 'readonly', JSON: 'readonly', RegExp: 'readonly', Map: 'readonly', Set: 'readonly', Array: 'readonly', BigInt: 'readonly', describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly', beforeAll: 'readonly', afterAll: 'readonly', vi: 'readonly' } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
