// Optional, opt-in headless capture helper. It is NOT used by any MCP tool and is not
// a dependency: Playwright is imported only when you run `britomartis-capture`, and
// only if you installed it yourself. It opens the URL you give in a headless browser,
// so it makes real network requests unless you pass offline mode (stubs or a 204 for
// every third-party request). Cookie values are redacted in the HAR files by default.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const SCENARIO_FILES = { first_visit: 'first-visit.har', after_reject: 'after-reject.har', after_accept: 'after-accept.har', gpc_visit: 'gpc-visit.har' };

/** Import Playwright if the person installed it (locally, globally, or at BRITOMARTIS_PLAYWRIGHT; "none" turns it off). Returns null when it is not there. */
export async function loadPlaywright() {
  const tries = [];
  if (process.env.BRITOMARTIS_PLAYWRIGHT === 'none') return null;
  if (process.env.BRITOMARTIS_PLAYWRIGHT) tries.push(process.env.BRITOMARTIS_PLAYWRIGHT);
  tries.push('playwright');
  try {
    const g = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
    for (const f of ['playwright/index.mjs', 'playwright/index.js']) if (existsSync(join(g, f))) { tries.push(pathToFileURL(join(g, f)).href); break; }
  } catch { /* npm not on PATH: fine */ }
  for (const t of tries) {
    try { const m = await import(/^[a-z]:|^\//i.test(t) && !t.startsWith('file:') ? pathToFileURL(t).href : t); const pw = m.chromium ? m : m.default; if (pw && pw.chromium) return pw; } catch { /* try the next one */ }
  }
  return null;
}

/** Replace cookie values with "redacted" (names and attributes are kept, which is all Britomartis reads). */
export const redactSetCookie = (v) => String(v).split('\n').map((line) => line.replace(/^(\s*[^=;\s]+)=([^;]*)/, '$1=redacted')).join('\n');
export const redactCookieHeader = (v) => String(v).split(';').map((p) => p.replace(/^(\s*[^=;\s]+)=.*$/, '$1=redacted')).join(';');

function harEntry(req, resStatus, reqHeaders, resHeaders, started, redact) {
  const fix = (arr, isReq) => arr.map(({ name, value }) => {
    const n = name.toLowerCase();
    if (redact && isReq && n === 'cookie') return { name, value: redactCookieHeader(value) };
    if (redact && !isReq && n === 'set-cookie') return { name, value: redactSetCookie(value) };
    return { name, value };
  });
  return { startedDateTime: started, request: { method: req.method(), url: req.url(), headers: fix(reqHeaders, true) }, response: { status: resStatus, headers: fix(resHeaders, false).flatMap((h) => (h.name.toLowerCase() === 'set-cookie' ? h.value.split('\n').map((v) => ({ name: 'Set-Cookie', value: v })) : [h])), cookies: [] } };
}

/**
 * Record HAR captures of a site: first_visit always, after_reject / after_accept when a
 * selector is given, gpc_visit when gpc is true. Returns { files, entries }.
 * originMap: { 'https://www.example.com': 'http://127.0.0.1:8080' } serves an origin from elsewhere.
 * stubs: { 'https://host/path-prefix': { status, contentType, headers: { 'Set-Cookie': [..] }, body } }.
 * offline: any request not mapped or stubbed gets an empty 204 instead of going to the network.
 */
export async function captureHars(o) {
  const { url, outDir, pages = [], afterChoicePages = null, rejectSelector = null, acceptSelector = null, gpc = true, originMap = {}, stubs = null, offline = false, waitMs = 300, redact = true, headless = true } = o;
  if (!/^https?:\/\//.test(String(url || ''))) throw new Error('url must be a full URL like https://www.example.com/');
  if (!outDir) throw new Error('outDir is required');
  const pw = o.playwright || await loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed. It is optional: install it yourself (npm i -g playwright && npx playwright install chromium) or record the HAR files from your browser\'s network panel.');
  const abs = (p) => new URL(p, url).href;
  const visit = [url, ...pages.map(abs)]; const afterVisit = (afterChoicePages || pages.length ? (afterChoicePages || pages) : ['']).map((p) => (p ? abs(p) : url));
  const stubKeys = stubs ? Object.keys(stubs).sort((a, b) => b.length - a.length) : [];
  const scenarios = [['first_visit', null, false], ...(rejectSelector ? [['after_reject', rejectSelector, false]] : []), ...(acceptSelector ? [['after_accept', acceptSelector, false]] : []), ...(gpc ? [['gpc_visit', null, true]] : [])];
  mkdirSync(outDir, { recursive: true });
  const browser = await pw.chromium.launch({ headless });
  const files = {}; const counts = {};
  try {
    for (const [name, choice, withGpc] of scenarios) {
      const context = await browser.newContext(withGpc ? { extraHTTPHeaders: { 'Sec-GPC': '1' } } : {});
      if (withGpc) await context.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }); });
      const fulfilled = new WeakMap(); const entries = []; let recording = !choice; let seq = 0; const order = new WeakMap();
      if (Object.keys(originMap).length || stubs || offline) {
        await context.route('**/*', async (route) => {
          const req = route.request(); const u = req.url();
          const from = Object.keys(originMap).find((k) => u === k || u.startsWith(k.replace(/\/$/, '') + '/'));
          if (from) {
            const resp = await route.fetch({ url: originMap[from].replace(/\/$/, '') + u.slice(from.replace(/\/$/, '').length), maxRedirects: 0 });
            fulfilled.set(req, resp.headersArray()); return route.fulfill({ response: resp });
          }
          const key = stubKeys.find((k) => u.startsWith(k));
          if (key) {
            const s = stubs[key]; const hs = []; for (const [k, v] of Object.entries(s.headers || {})) for (const x of [].concat(v)) hs.push({ name: k, value: String(x) });
            if (s.contentType) hs.push({ name: 'Content-Type', value: s.contentType });
            fulfilled.set(req, hs);
            const headers = {}; for (const h of hs) headers[h.name.toLowerCase()] = headers[h.name.toLowerCase()] ? `${headers[h.name.toLowerCase()]}\n${h.value}` : h.value;
            return route.fulfill({ status: s.status || 200, headers, body: s.body || '' });
          }
          if (offline) { fulfilled.set(req, []); return route.fulfill({ status: 204, body: '' }); }
          return route.continue();
        });
      }
      context.on('request', (req) => { if (recording) order.set(req, { n: seq++, t: new Date().toISOString() }); });
      const done = async (req, failed) => {
        const o2 = order.get(req); if (!o2) return;
        const reqHeaders = await req.headersArray().catch(() => []);
        const resp = failed ? null : await req.response().catch(() => null);
        const resHeaders = fulfilled.get(req) || (resp ? await resp.headersArray().catch(() => []) : []);
        entries.push({ n: o2.n, e: harEntry(req, resp ? resp.status() : 0, reqHeaders, resHeaders, o2.t, redact) });
      };
      const pending = [];
      context.on('requestfinished', (r) => pending.push(done(r, false))); context.on('requestfailed', (r) => pending.push(done(r, true)));
      const page = await context.newPage();
      const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); if (waitMs) await page.waitForTimeout(waitMs); };
      if (choice) {
        await page.goto(url); await settle();
        const el = await page.waitForSelector(choice, { timeout: 5000 }).catch(() => null);
        if (!el) throw new Error(`${name}: no element matches ${choice} on ${url}`);
        recording = true; await el.click(); await settle();
        for (const p of afterVisit) { await page.goto(p); await settle(); }
      } else for (const p of visit) { await page.goto(p); await settle(); }
      await Promise.all(pending); await context.close();
      entries.sort((a, b) => a.n - b.n);
      const har = { log: { version: '1.2', creator: { name: 'britomartis-capture', version: VERSION }, pages: [{ title: `${url} ${name.replace(/_/g, ' ')}${withGpc ? ' (Sec-GPC: 1)' : ''}` }], entries: entries.map((x) => x.e) } };
      const f = join(outDir, SCENARIO_FILES[name]); writeFileSync(f, JSON.stringify(har, null, 1) + '\n'); files[name] = f; counts[name] = entries.length;
    }
  } finally { await browser.close(); }
  return { files, entries: counts };
}
