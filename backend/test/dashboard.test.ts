import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const html = await readFile(new URL('../../dashboard/index.html', import.meta.url), 'utf8');

describe('portfolio dashboard', () => {
  it('keeps the admin credential in memory and does not persist it in browser storage', () => {
    expect(html).toContain("let adminToken = ''");
    expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it('escapes event and provider-controlled text before rendering HTML', () => {
    expect(html).toContain('const esc = (value)');
    expect(html).toContain('esc(event.externalEventId)');
    expect(html).toContain('esc(item.reason)');
    expect(html).toContain('esc(item.model)');
  });

  it('states token-only accounting and explains overlapping token categories', () => {
    expect(html).toContain('sem conversão monetária');
    expect(html).toContain('Cache é parte da entrada');
    expect(html).toContain('raciocínio é parte da saída');
  });
});
