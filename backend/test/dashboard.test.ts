// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The dashboard is one static HTML file with an inline script. These tests run
// that script against a simulated DOM and a mocked API, so they check what the
// page actually does (escaping, where the token goes) instead of its source text.
// node:path instead of `new URL(...)`: under happy-dom the global URL is the DOM one.
const html = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf8');
const bodyMarkup = html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? '';
const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

const hostile = {
  img: '<img src=x onerror="window.__xss=1">',
  bold: '<b>falha</b>',
  svg: '<svg onload="window.__xss=1"></svg>',
};

type Reply = { status?: number; body: unknown };
type ApiRoutes = Record<string, Reply>;

function defaultRoutes(role = 'operator'): ApiRoutes {
  return {
    '/v1/session': { body: { tenantId: 'loja-a', role, expiresAt: '2027-02-06T12:00:00Z' } },
    '/v1/operations/summary': { body: { statuses: [{ status: 'delivered', count: 1 }] } },
    '/v1/operations/events': { body: { events: [{ externalEventId: hostile.img, orderId: hostile.svg, status: 'delivered', attempts: 0, updatedAt: '2026-11-08T12:00:00Z' }] } },
    '/v1/operations/dead-letters': { body: { deadLetters: [{ id: 'dl-1', externalEventId: 'evt-9', attempts: 5, reason: hostile.bold }] } },
    '/v1/usage/tokens': { body: { summary: { total_tokens: 15 }, usage: [{ provider: 'openai', model: hostile.svg, task: 'demo', requests: 1, input_tokens: 12, cached_input_tokens: 0, output_tokens: 3, reasoning_tokens: 0, total_tokens: 15 }] } },
    '/v1/ai/status': { body: { enabled: false, model: 'm', usedTokensToday: 0, dailyTokenLimit: 5000, remainingTokensToday: 5000, reservedInputTokens: 256, unresolvedRequests: 0 } },
  };
}

function mockApi(routes: ApiRoutes) {
  const fetchMock = vi.fn(async (input: string) => {
    const path = input.split('?')[0] ?? input;
    const reply = routes[path] ?? { status: 404, body: { error: 'not_found' } };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const $ = (id: string) => document.getElementById(id)!;

async function connect(token: string) {
  ($('token') as HTMLInputElement).value = token;
  $('auth').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect($('updated').textContent).not.toBe('Atualizando…'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  document.body.innerHTML = bodyMarkup;
  delete (window as { __xss?: number }).__xss;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function startPage() {
  expect(pageScript.length).toBeGreaterThan(0);
  new Function(pageScript)();
}

describe('portfolio dashboard', () => {
  it('renders API values as text, never as markup', async () => {
    mockApi(defaultRoutes());
    startPage();
    await connect('admin-token-for-test');

    expect($('events').querySelector('img, svg')).toBeNull();
    expect($('events').textContent).toContain(hostile.img);
    expect($('dead').querySelector('b')).toBeNull();
    expect($('dead').textContent).toContain(hostile.bold);
    expect($('tokens').querySelector('svg')).toBeNull();
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it('sends the admin token only as a header and keeps it out of the page and browser storage', async () => {
    const fetchMock = mockApi(defaultRoutes());
    startPage();
    await connect('admin-token-for-test');

    expect(($('token') as HTMLInputElement).value).toBe('');
    expect(fetchMock).toHaveBeenCalled();
    for (const [, options] of fetchMock.mock.calls as unknown as [string, { headers: Record<string, string> }][]) {
      expect(options.headers['x-admin-token']).toBe('admin-token-for-test');
    }
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(document.body.innerHTML).not.toContain('admin-token-for-test');
  });

  it('shows an authorization error instead of data when the API rejects the token', async () => {
    const routes = defaultRoutes();
    for (const path of Object.keys(routes)) routes[path] = { status: 401, body: { error: 'unauthorized' } };
    mockApi(routes);
    startPage();
    await connect('wrong-token');

    expect($('error').textContent).toBe('Token inválido, expirado ou revogado.');
    expect($('events').textContent).toBe('');
  });

  it('shows the session and disables actions for a read-only token', async () => {
    mockApi(defaultRoutes('viewer'));
    startPage();
    await connect('viewer-token');
    expect($('session').textContent).toContain('somente leitura');
    expect($('session').textContent).toContain('loja-a');
    const redrive = $('dead').querySelector('button[data-redrive]') as HTMLButtonElement;
    expect(redrive.disabled).toBe(true);
    expect(($('run-ai') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps actions available to an operator token', async () => {
    mockApi(defaultRoutes('operator'));
    startPage();
    await connect('operator-token');
    expect($('session').textContent).toContain('operador');
    expect(($('dead').querySelector('button[data-redrive]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('states token-only accounting and explains overlapping token categories', () => {
    expect(html).toContain('sem conversão monetária');
    expect(html).toContain('Cache é parte da entrada');
    expect(html).toContain('raciocínio é parte da saída');
  });
});
