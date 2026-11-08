import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveFileBackedEnv } from '../src/env-files.js';

const dir = mkdtempSync(join(tmpdir(), 'env-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe('file-backed environment variables', () => {
  it('reads NAME from NAME_FILE and strips one trailing newline', () => {
    const env = resolveFileBackedEnv({ WEBHOOK_SECRET_FILE: secretFile('a', 'from-file\n') }, ['WEBHOOK_SECRET']);
    expect(env.WEBHOOK_SECRET).toBe('from-file');
  });

  it('keeps plain environment values when no file is configured', () => {
    expect(resolveFileBackedEnv({ WEBHOOK_SECRET: 'plain' }, ['WEBHOOK_SECRET']).WEBHOOK_SECRET).toBe('plain');
  });

  it('refuses ambiguous configuration with both NAME and NAME_FILE', () => {
    expect(() => resolveFileBackedEnv({ WEBHOOK_SECRET: 'x', WEBHOOK_SECRET_FILE: secretFile('b', 'y') }, ['WEBHOOK_SECRET']))
      .toThrow('Set either WEBHOOK_SECRET or WEBHOOK_SECRET_FILE, not both');
  });

  it('names the variable on read errors without exposing contents', () => {
    expect(() => resolveFileBackedEnv({ WEBHOOK_SECRET_FILE: join(dir, 'missing') }, ['WEBHOOK_SECRET']))
      .toThrow(/WEBHOOK_SECRET_FILE .*ENOENT/);
  });

  it('ignores _FILE variables that are not on the allowlist', () => {
    const env = resolveFileBackedEnv({ PATH_FILE: secretFile('c', 'x') }, ['WEBHOOK_SECRET']);
    expect(env.PATH).toBeUndefined();
  });
});
