/**
 * Automated dashboard review in real browsers (Playwright).
 *
 * For each browser and viewport (desktop 1440×900, mobile 390×844) it checks:
 * - accessibility with axe-core (WCAG 2.0/2.1 A and AA rules);
 * - console errors and page errors (a CSP violation shows up here);
 * - no horizontal scrolling;
 * - keyboard-only login: Tab reaches the token field, Enter submits, and
 *   the focused control has a visible outline;
 * - a viewer token gets action buttons disabled;
 * - the dead-letter "Reprocessar" button is visible without side scrolling (desktop).
 * With --screenshots, saves docs/img/dashboard-{desktop,mobile}.png (Chromium).
 *
 * Usage: tsx scripts/dashboard-review.ts --base URL --demo demo.json [--browsers chromium,firefox,webkit] [--screenshots DIR]
 * Exit code 1 on any finding.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:3000' },
    demo: { type: 'string', default: 'demo.json' },
    browsers: { type: 'string', default: 'chromium,firefox,webkit' },
    screenshots: { type: 'string' },
  },
});
const demo = JSON.parse(await readFile(values.demo!, 'utf8')) as { operatorToken: string; viewerToken: string };
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

type Finding = { browser: string; viewport: string; check: string; detail: string };
const findings: Finding[] = [];
const passed: string[] = [];

async function login(page: Page, token: string): Promise<number> {
  await page.goto(`${values.base}/dashboard`);
  // Keyboard only: count Tab presses until the token field has focus.
  let presses = 0;
  while (presses < 10) {
    await page.keyboard.press('Tab');
    presses += 1;
    if (await page.evaluate(() => document.activeElement?.id === 'token')) break;
  }
  await page.keyboard.type(token);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#events tr').length > 0 && /Atualizado/.test(document.getElementById('updated')?.textContent ?? ''), null, { timeout: 15_000 });
  return presses;
}

for (const name of values.browsers!.split(',')) {
  const engine = engines[name];
  if (!engine) throw new Error(`unknown browser ${name}`);
  const browser = await engine.launch();
  try {
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport, colorScheme: 'dark', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('pageerror', (error) => errors.push(error.message));
      const where = { browser: name, viewport: viewportName };

      const presses = await login(page, demo.operatorToken);
      if (presses >= 10) findings.push({ ...where, check: 'keyboard', detail: 'token field not reachable with Tab' });

      // Focus indicator on the next control (the "Conectar" button).
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { tag: document.activeElement?.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
      });
      if (outline.outlineStyle === 'none' || outline.outlineWidth === '0px') {
        findings.push({ ...where, check: 'focus-visible', detail: `no visible outline on focused ${outline.tag}` });
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) findings.push({ ...where, check: 'horizontal-scroll', detail: `page is ${overflow}px wider than the viewport` });

      // The main action of the dead-letter panel must be visible without
      // scrolling the table sideways (desktop).
      if (viewportName === 'desktop') {
        const clipped = await page.evaluate(() => {
          const button = document.querySelector('#dead button[data-redrive]');
          const wrap = button?.closest('.table-wrap');
          if (!button || !wrap) return 'no redrive button rendered';
          return button.getBoundingClientRect().right > wrap.getBoundingClientRect().right + 1 ? 'redrive button outside the visible table area' : null;
        });
        if (clipped) findings.push({ ...where, check: 'layout', detail: clipped });
      }

      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const violation of axe.violations) {
        findings.push({ ...where, check: `axe:${violation.id}`, detail: `${violation.impact}: ${violation.help} (${violation.nodes.length}x) ${violation.nodes.slice(0, 2).map((node) => node.target.join(' ')).join(' | ')}` });
      }

      if (values.screenshots && name === 'chromium') {
        await mkdir(values.screenshots, { recursive: true });
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.screenshot({ path: `${values.screenshots}/dashboard-${viewportName}.png`, fullPage: true });
      }

      // Viewer token: same page, actions disabled.
      await login(page, demo.viewerToken);
      const viewerState = await page.evaluate(() => ({
        session: document.getElementById('session')?.textContent ?? '',
        redriveEnabled: [...document.querySelectorAll<HTMLButtonElement>('#dead button[data-redrive]')].some((button) => !button.disabled),
        aiEnabled: !(document.getElementById('run-ai') as HTMLButtonElement).disabled,
      }));
      if (!viewerState.session.includes('somente leitura') || viewerState.redriveEnabled || viewerState.aiEnabled) {
        findings.push({ ...where, check: 'viewer-role', detail: JSON.stringify(viewerState) });
      }

      for (const error of errors) findings.push({ ...where, check: 'console', detail: error.slice(0, 300) });
      passed.push(`${name}/${viewportName}: ${axe.passes.length} axe rules passed, ${axe.violations.length} violations, ${errors.length} console errors`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

console.log(JSON.stringify({ checked: passed, findings }, null, 2));
if (findings.length > 0) process.exitCode = 1;
