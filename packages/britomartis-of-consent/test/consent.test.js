import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, audit, scanHtml, readHar, parseSetCookie, validateDeclared, knownHost, knownCookie, draftTable } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const har = (n) => readHar(readFileSync(join(fixtures, 'har', n), 'utf8'), n);
const declared = JSON.parse(readFileSync(join(fixtures, 'declared.json'), 'utf8'));
const full = () => audit({ siteDir: join(fixtures, 'site'), siteHost: 'www.example.com', hars: { first_visit: har('first-visit.har'), after_reject: har('after-reject.har') }, declared });
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'brito-')); cpSync(fixtures, r, { recursive: true }); return r; };
const has = (r, check, subject) => r.findings.some((f) => f.check === check && (!subject || f.subject.includes(subject)));

test('Set-Cookie parsing, vendor lists and policy validation', () => {
  const c = parseSetCookie('a=1; Domain=.Example.com; Max-Age=86400; Secure; HttpOnly; SameSite=Lax');
  assert.deepEqual([c.name, c.domain, c.lifetime_days, c.secure, c.httponly, c.samesite], ['a', 'example.com', 1, true, true, 'Lax']);
  assert.equal(parseSetCookie('b=2; Expires=Wed, 11 Nov 2026 15:00:00 GMT', Date.parse('2026-11-10T15:00:00Z')).lifetime_days, 1);
  assert.equal(knownHost('region1.google-analytics.com').purpose, 'analytics'); assert.equal(knownHost('notgoogle-analytics.com'), null);
  assert.equal(knownCookie('_ga_ABC123').vendor, 'Google Analytics');
  assert.throws(() => validateDeclared({ cookies: [] }), /declared.source is required/);
  assert.throws(() => validateDeclared({ source: 'x', cookies: [{ name: 'a', purpose: 'tracking' }] }), /purpose must be one of/);
});
test('HTML scan: gated vs ungated scripts, inline calls, claims, policy link', () => {
  const r = scanHtml(readFileSync(join(fixtures, 'site/index.html'), 'utf8'), 'index.html', 'www.example.com');
  assert.ok(r.items.some((i) => i.host === 'www.googletagmanager.com' && !i.gated));
  assert.ok(r.items.some((i) => i.kind === 'inline_script' && i.vendor === 'Google tag (gtag)'));
  assert.deepEqual(r.claims.map((c) => c.label), ['no tracking cookies']); assert.equal(r.policyLink, true);
  const o = scanHtml(readFileSync(join(fixtures, 'site/order.html'), 'utf8'), 'order.html', 'www.example.com');
  assert.ok(o.items.find((i) => i.host === 'connect.facebook.net').gated); assert.ok(o.items.find((i) => i.kind === 'inline_script').gated);
  assert.deepEqual(scanHtml('<p>No trackers, no cookies, no analytics on this page.</p>', 'x', null).claims.map((c) => c.kind), ['any_cookie', 'tracker', 'analytics']);
});
test('HAR: header cookies, script cookies seen in later requests, third-party hosts', () => {
  const h = har('first-visit.har');
  assert.deepEqual([...new Set(h.cookies.map((c) => c.name))].sort(), ['VISITOR_INFO1_LIVE', 'YSC', '_ga', '_gid', 'promo_seen', 'sid']);
  assert.equal(h.cookies.find((c) => c.name === '_ga').set_by, 'sent');
  assert.throws(() => readHar('{"x":1}', 'bad.har'), /no log.entries/);
});
test('full audit: before consent, after reject, claims, insecure and undeclared', () => {
  const r = full();
  assert.equal(r.issues, 25); assert.equal(r.by_severity.error, 11);
  assert.ok(has(r, 'nonessential_before_consent', '_ga')); assert.ok(has(r, 'nonessential_after_reject', 'google-analytics'));
  assert.ok(!has(r, 'nonessential_before_consent', 'sid'), 'necessary cookie is fine before consent');
  assert.ok(!has(r, 'nonessential_after_reject', '__stripe_mid'), 'necessary third party is fine after reject');
  assert.ok(has(r, 'claim_contradicted', 'no tracking cookies')); assert.ok(has(r, 'samesite_none_insecure', 'VISITOR_INFO1_LIVE'));
  assert.ok(has(r, 'cookie_long_lifetime', 'promo_seen')); assert.ok(has(r, 'declared_not_seen', 'csrftoken'));
  assert.equal(r.cookies.find((c) => c.name === 'YSC').purpose_source, 'known_list (guess)');
  assert.equal(r.cookies.find((c) => c.name === '_ga').purpose_source, 'declared');
  const d = draftTable(r, declared); assert.match(d.rows.find((x) => x.name === 'promo_seen').purpose, /TO CONFIRM/);
});
test('a clean site with an honest "no cookies" claim has no gaps', () => {
  const d = mkdtempSync(join(tmpdir(), 'brito-clean-')); mkdirSync(join(d, 'site'));
  writeFileSync(join(d, 'site/index.html'), '<html lang="en"><head><link rel="stylesheet" href="/assets/s.css"><script src="/assets/a.js"></script></head><body><footer>No trackers, no cookies, no analytics on this page.</footer></body></html>');
  const r = audit({ siteDir: join(d, 'site'), siteHost: 'www.example.com' });
  assert.equal(r.issues, 0); assert.equal(r.claims.length, 3); assert.equal(r.cookies.length, 0);
});
test('draft on Auto; publish is one-click, hash-bound and marker-gated; deploy blocked', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['britomartis_draft_policy_table'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['britomartis_request_publish'] }), /one-click/);
  const f = { site: 'site', base_url: 'https://www.example.com', har_first_visit: 'har/first-visit.har', declared: 'declared.json' };
  const d = await rt.call('britomartis_draft_policy_table', f); assert.equal(d.status, 'executed');
  const args = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('britomartis_request_publish', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Ana');
  assert.match((await rt.call('britomartis_request_publish', args)).reason, /TO CONFIRM/);
  const reviewed = { source: 'Reviewed policy', cookies: ['sid', '_ga', '_gid', 'promo_seen', 'YSC', 'VISITOR_INFO1_LIVE'].map((n) => ({ name: n, provider: 'x', purpose: n === 'sid' ? 'necessary' : 'marketing', duration: '1 day' })), third_parties: ['fonts.googleapis.com', 'googletagmanager.com', 'google-analytics.com', 'youtube.com', 'connect.facebook.net', 'stripe.com'].map((h) => ({ host: h, name: h, purpose: 'other' })) };
  writeFileSync(join(root, 'reviewed.json'), JSON.stringify(reviewed));
  const d2 = await rt.call('britomartis_draft_policy_table', { ...f, declared: 'reviewed.json', out_dir: 'mythos-out/r' });
  const a2 = { proposal: d2.result.proposal, proposal_sha256: d2.result.proposal_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('britomartis_request_publish', a2)).approval_id, 'Ana');
  const ok = await rt.call('britomartis_request_publish', a2); assert.equal(ok.status, 'executed', ok.reason); assert.equal(ok.approved_by, 'Ana');
  assert.equal(parseCsv(readFileSync(join(root, 'mythos-out/britomartis/publish-requests.csv'), 'utf8'))[0].status, 'approved - a person publishes it');
  const d3 = await rt.call('britomartis_draft_policy_table', { ...f, declared: 'reviewed.json', out_dir: 'mythos-out/t' });
  const a3 = { proposal: d3.result.proposal, proposal_sha256: d3.result.proposal_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('britomartis_request_publish', a3)).approval_id, 'Ana');
  writeFileSync(join(root, 'mythos-out/t/cookie-table.md'), 'edited');
  assert.match((await rt.call('britomartis_request_publish', a3)).reason, /changed after the proposal/);
  for (const t of ['deploy_site', 'http_fetch']) assert.equal((await rt.call(t, {})).status, 'blocked');
});
test('cookie values from HAR captures never appear in results', () => {
  const out = JSON.stringify(full());
  for (const v of ['s0000', 'GA1.1.000', 'y000', 'v000', 'm000']) assert.ok(!out.includes(v), `${v} leaked`);
});
