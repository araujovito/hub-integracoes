import { readFileSync } from 'node:fs';

/**
 * Variables that may come from a file instead of the environment. With
 * `NAME_FILE=/run/secrets/name`, the value is read from that file. This is the
 * convention used by Docker/Compose secrets, Kubernetes secret volumes and
 * secret-manager agents, and keeps secrets out of `docker inspect`, process
 * listings and crash dumps of the environment.
 */
export const FILE_BACKED_VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'PLATFORM_ADMIN_TOKEN',
  'TENANT_SECRETS_KEY',
  'TENANT_SECRETS_KEY_PREVIOUS',
] as const;

type Env = Record<string, string | undefined>;

/** Return a copy of `env` with every `NAME_FILE` resolved into `NAME`. */
export function resolveFileBackedEnv(env: Env, names: readonly string[] = FILE_BACKED_VARIABLES): Env {
  const resolved: Env = { ...env };
  for (const name of names) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`Set either ${name} or ${name}_FILE, not both`);
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      // Report which variable failed without echoing file contents.
      throw new Error(`Cannot read ${name}_FILE (${path}): ${(error as NodeJS.ErrnoException).code ?? 'read_error'}`, { cause: error });
    }
    // Files written by editors or `echo` usually end with a newline.
    resolved[name] = content.replace(/\r?\n$/, '');
  }
  return resolved;
}
