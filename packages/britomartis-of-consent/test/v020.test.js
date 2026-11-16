import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, createMcpHandler, validate } from 'mythos-agent-core';
import { manifest, audit, readHar, knownHost, knownCookie, VENDOR_LIST, snapshot, diffInventory } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const bin = fileURLToPath(new URL('../bin/britomartis-of-consent.js', import.meta.url));
const har = (n) => readHar(readFileSync(join(fixtures, 'har', n), 'utf8'), n);
const declared = JSON.parse(readFileSync(join(fixtures, 'declared.json'), 'utf8'));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'brito2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const f = { site: 'site', base_url: 'https://www.example.com', har_first_visit: 'har/first-visit.har', har_after_reject: 'har/after-reject.har', declared: 'declared.json' };

test('vendor list is versioned, larger, and every guess cites its version', () => {
  assert.match(VENDOR_LIST.version, /^\d{4}\.\d{1,2}\.\d+$/); assert.ok(VENDOR_LIST.source.length > 20);
  assert.ok(VENDOR_LIST.hosts.length >= 100, 'at least 100 hosts'); assert.ok(VENDOR_LIST.cookies.length >= 80, 'at least 80 cookie patterns');
  for (const e of [...VENDOR_LIST.hosts, ...VENDOR_LIST.cookies]) assert.ok(['necessary', 'preferences', 'analytics', 'marketing', 'other'].includes(e.purpose), e.match);
  assert.equal(knownHost('px.ads.linkedin.com').vendor_list, `britomartis-vendor-list v${VENDOR_LIST.version}`);
  assert.equal(knownCookie('_ttp').vendor, 'TikTok Pixel');
  const r = audit({ siteHost: 'www.example.com', hars: { first_visit: har('first-visit.har') }, declared });
  for (const x of [...r.cookies, ...r.third_parties].filter((c) => c.purpose_source !== 'declared' && c.purpose)) {
    assert.equal(x.purpose_source, 'known_list (guess)', 'purposes stay labelled as guesses'); assert.equal(x.vendor_list, `britomartis-vendor-list v${VENDOR_LIST.version}`);
  }
  for (const fd of r.findings.filter((x) => /looks like/.test(x.detail))) assert.match(fd.detail, new RegExp(`a guess from britomartis-vendor-list v${VENDOR_LIST.version.replace(/\./g, '\\.')}`));
  assert.deepEqual(r.vendor_lists, [`britomartis-vendor-list v${VENDOR_LIST.version}`]);
});

test('your own vendor list is matched first and cited by its version', () => {
  const mine = { name: 'acme-vendors', version: '3', source: 'Our tag inventory (fictional)', cookies: [{ match: 'promo_seen', vendor: 'Promo widget (fictional)', purpose: 'marketing' }] };
  const r = audit({ siteHost: 'www.example.com', hars: { first_visit: har('first-visit.har') }, vendorLists: [mine, VENDOR_LIST] });
  const c = r.cookies.find((x) => x.name === 'promo_seen'); assert.equal(c.vendor_list, 'acme-vendors v3'); assert.equal(c.purpose, 'marketing');
  assert.ok(r.findings.some((x) => x.check === 'nonessential_before_consent' && x.subject.includes('promo_seen')));
});

test('Global Privacy Control: a Sec-GPC capture that still sets trackers is flagged', () => {
  const g = har('gpc-visit.har'); assert.equal(g.gpc, true); assert.equal(g.gpc_requests, 6);
  assert.equal(har('first-visit.har').gpc, false);
  const r = audit({ siteHost: 'www.example.com', hars: { gpc_visit: g } });
  const hit = r.findings.find((x) => x.check === 'gpc_signal_ignored'); assert.ok(hit); assert.equal(hit.severity, 'warning');
  assert.match(hit.detail, /cookie _fbp/); assert.match(hit.detail, /host connect\.facebook\.net/); assert.ok(!/cookie sid/.test(hit.detail), 'necessary cookie is fine');
  assert.deepEqual(r.gpc.captures_with_signal, ['gpc_visit']);
  const d = mkdtempSync(join(tmpdir(), 'brito-gpc-')); mkdirSync(join(d, 'site/.well-known'), { recursive: true });
  writeFileSync(join(d, 'site/index.html'), '<html><body><script>if (navigator.globalPrivacyControl) {}</script></body></html>');
  writeFileSync(join(d, 'site/.well-known/gpc.json'), JSON.stringify({ gpc: true, lastUpdate: '2026-11-01' }));
  const w = audit({ siteDir: join(d, 'site'), siteHost: 'www.example.com', hars: { gpc_visit: g } });
  assert.equal(w.findings.find((x) => x.check === 'gpc_signal_ignored').severity, 'error', 'claimed GPC support makes it an error');
  assert.equal(w.gpc.well_known_gpc_json, true); assert.equal(w.gpc.page_reads_signal, true);
  assert.ok(audit({ siteDir: join(d, 'site'), siteHost: 'www.example.com' }).findings.some((x) => x.check === 'gpc_not_tested'));
  const clean = { log: { entries: [{ request: { url: 'https://www.example.com/', headers: [{ name: 'Sec-GPC', value: '1' }] }, response: { headers: [{ name: 'Set-Cookie', value: 'sid=1; Secure' }] } }] } };
  assert.ok(!audit({ siteHost: 'www.example.com', hars: { gpc_visit: readHar(JSON.stringify(clean), 'c') } }).findings.some((x) => x.check === 'gpc_signal_ignored'));
  assert.match(JSON.stringify(r), /depends on where it operates; a person decides/);
});

test('inventory diff: new cookies, hosts and gaps since the last scan', () => {
  const before = snapshot(audit({ siteHost: 'www.example.com', hars: { first_visit: har('first-visit.har') }, declared }));
  const now = snapshot(audit({ siteHost: 'www.example.com', hars: { first_visit: har('first-visit.har'), gpc_visit: har('gpc-visit.har') }, declared }));
  const d = diffInventory(before, now);
  assert.deepEqual(d.new_cookies.map((c) => c.name), ['_fbp']);
  assert.deepEqual(d.new_hosts.map((h) => h.host).sort(), ['connect.facebook.net', 'www.facebook.com']);
  assert.ok(d.new_findings.some((x) => x.check === 'gpc_signal_ignored')); assert.equal(d.gone_cookies.length, 0);
  assert.deepEqual(diffInventory(now, before).gone_cookies.map((c) => c.name), ['_fbp']);
  assert.equal(diffInventory(before, before).changes, 0);
  assert.throws(() => diffInventory({}, now), /inventory.json written by britomartis_write_report/);
  assert.ok(!JSON.stringify(now).includes('GA1.1.000'), 'no cookie values in the snapshot');
});

test('report writes HTML and a value-free inventory.json with an output hash; diff tool reads it', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const w = await rt.call('britomartis_write_report', { ...f, har_gpc: 'har/gpc-visit.har' });
  assert.equal(w.status, 'executed'); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
  const html = readFileSync(w.result.files[3], 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/); assert.ok(!/<script/i.test(html)); assert.match(html, /gpc_signal_ignored/);
  assert.ok(!/compliant/i.test(html.replace(/never says a site is GDPR, CCPA\/CPRA or ePrivacy compliant/g, '')), 'no compliance wording');
  const inv = JSON.parse(readFileSync(w.result.files[4], 'utf8')); assert.equal(inv.format, 'britomartis-inventory/1');
  const audit1 = readFileSync(join(root, '.mythos/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(audit1.output_sha256, w.result.output_sha256);
  const d = await rt.call('britomartis_diff_inventory', { ...f, previous: 'mythos-out/britomartis/inventory.json' });
  assert.equal(d.status, 'executed'); assert.ok(d.result.resolved_findings.some((x) => x.check === 'gpc_signal_ignored'));
  assert.match(d.result.markdown, /not a compliance finding/);
});

test('config schemas: declared policy and vendor list fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = { unknown_key: { ...declared, sorce: 'typo' }, wrong_type: { ...declared, cookies: { name: 'sid' } }, missing_required: { cookies: declared.cookies } };
  const want = { unknown_key: /\/sorce is not an allowed property/, wrong_type: /\/cookies expected array/, missing_required: /\/source is required/ };
  for (const [k, v] of Object.entries(bad)) {
    writeFileSync(join(root, `${k}.json`), JSON.stringify(v));
    const r = await rt.call('britomartis_inventory', { ...f, declared: `${k}.json` });
    assert.equal(r.status, 'error', k); assert.match(r.reason, want[k]);
    const cli = spawnSync(process.execPath, [bin, 'validate-config', 'declared_policy', join(root, `${k}.json`)], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, `validate-config rejects ${k}`);
  }
  writeFileSync(join(root, 'v.json'), JSON.stringify({ name: 'x', version: 1, source: 's' }));
  assert.match((await rt.call('britomartis_inventory', { ...f, vendors: 'v.json' })).reason, /\/version expected string/);
  assert.ok(validate(manifest.configSchemas.vendor_list, VENDOR_LIST).ok, 'the built-in list matches its own schema');
  assert.ok(validate(manifest.configSchemas.declared_policy, declared).ok);
  assert.equal(spawnSync(process.execPath, [bin, 'validate-config', 'declared_policy', join(fixtures, 'declared.json')], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(root, 'broken.json'), '{'); assert.match((await rt.call('britomartis_inventory', { ...f, declared: 'broken.json' })).reason, /not valid JSON/);
});

test('MCP prompt walks the audit end to end and keeps the one-click publish', async () => {
  const p = manifest.prompts[0]; assert.equal(p.name, 'britomartis_consent_audit');
  for (const t of ['britomartis_inventory', 'britomartis_diff_inventory', 'britomartis_write_report', 'britomartis_draft_policy_table', 'britomartis_request_publish', 'gpc_signal_ignored']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /never say a site is GDPR, CCPA\/CPRA or ePrivacy compliant/);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: p.name, arguments: { base_url: 'https://www.example.com', har_first_visit: 'har/first-visit.har' } } });
  assert.match(got.result.messages[0].content.text, /base_url=https:\/\/www.example.com/);
  const miss = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: p.name, arguments: {} } }); assert.ok(miss.error);
});
