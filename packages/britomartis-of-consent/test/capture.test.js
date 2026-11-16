// The headless capture helper is optional. This test runs only when Playwright (and a
// Chromium build) is installed; otherwise it is skipped. It never touches the network:
// the site comes from a local static server and every third-party request is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, readHar } from '../src/index.js';
import { loadPlaywright, captureHars, redactSetCookie, redactCookieHeader } from '../src/capture.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const siteDir = join(fixtures, 'capture-site');
const pw = await loadPlaywright();
let browserOk = false;
if (pw) { try { const b = await pw.chromium.launch(); await b.close(); browserOk = true; } catch { browserOk = false; } }
const skip = !pw ? 'Playwright is not installed (optional)' : !browserOk ? 'Playwright is installed but no Chromium build is available' : false;

test('cookie values are redacted in captured headers', () => {
  assert.equal(redactSetCookie('sid=abc123; Path=/; Secure'), 'sid=redacted; Path=/; Secure');
  assert.equal(redactCookieHeader('sid=abc; _ga=GA1.2.3'), 'sid=redacted; _ga=redacted');
});

function serve() {
  const headers = JSON.parse(readFileSync(join(siteDir, '_headers.json'), 'utf8'));
  const types = { '.html': 'text/html', '.js': 'application/javascript' };
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname; const file = join(siteDir, path === '/' ? 'index.html' : path.slice(1));
    if (path.includes('..') || path.startsWith('/_') || path.endsWith('.json') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    for (const [k, v] of Object.entries(headers[path] || {})) res.setHeader(k, v);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const shape = (r) => ({
  cookies: r.cookies.map((c) => ({ name: c.name, domain: c.domain, party: c.party, set_by: c.set_by, purpose: c.purpose, lifetime_days: c.lifetime_days, secure: c.secure, samesite: c.samesite, seen_in: c.seen_in.slice().sort() })),
  hosts: r.third_parties.map((t) => ({ host: t.host, purpose: t.purpose, seen_in: t.seen_in.slice().sort() })),
  findings: r.findings.map((f) => `${f.check}|${f.subject}`).sort(),
});

test('capture of the local fixture site gives the same inventory as the bundled HARs', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const out = mkdtempSync(join(tmpdir(), 'brito-cap-'));
  try {
    const r = await captureHars({ playwright: pw, url: 'https://www.example.com/', outDir: out, afterChoicePages: ['/order.html'], rejectSelector: '#reject-all', gpc: true, originMap: { 'https://www.example.com': `http://127.0.0.1:${srv.address().port}` }, stubs: JSON.parse(readFileSync(join(siteDir, 'stubs.json'), 'utf8')), offline: true, waitMs: 200 });
    assert.deepEqual(Object.keys(r.files), ['first_visit', 'after_reject', 'gpc_visit']);
    const cap = (k) => readHar(readFileSync(r.files[k], 'utf8'), k);
    const bundled = (f) => readHar(readFileSync(join(fixtures, 'har', f), 'utf8'), f);
    const declared = JSON.parse(readFileSync(join(fixtures, 'declared.json'), 'utf8'));
    const mine = audit({ siteHost: 'www.example.com', hars: { first_visit: cap('first_visit'), after_reject: cap('after_reject') }, declared });
    const theirs = audit({ siteHost: 'www.example.com', hars: { first_visit: bundled('first-visit.har'), after_reject: bundled('after-reject.har') }, declared });
    assert.deepEqual(shape(mine), shape(theirs));
    const raw = readFileSync(r.files.first_visit, 'utf8');
    for (const v of ['s0000', 'GA1.1.000', 'y000', 'v000']) assert.ok(!raw.includes(v), `${v} not redacted`);
    const g = audit({ siteHost: 'www.example.com', hars: { gpc_visit: cap('gpc_visit') } });
    assert.ok(cap('gpc_visit').gpc); assert.ok(g.findings.some((f) => f.check === 'gpc_signal_ignored'));
    const text = JSON.stringify(mine) + JSON.stringify(g);
    assert.ok(!/\b(is|are) (GDPR|CCPA)[- ]compliant|makes? (you|the site) compliant/i.test(text), 'never claims compliance');
  } finally { srv.close(); }
});
