import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, audit, recordsResolver, dohResolver, parseSpf, txtJoin, dkimKeyBits, draftChanges, validDomain } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const records = JSON.parse(readFileSync(join(fixtures, 'records.json'), 'utf8'));
const res = recordsResolver(records);
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'aeolus-')); cpSync(fixtures, r, { recursive: true }); return r; };
const checks = (r) => r.findings.map((f) => f.check);

test('parsers', () => {
  assert.equal(txtJoin('"v=spf1 include:a" " -all"'), 'v=spf1 include:a -all');
  const p = parseSpf('v=spf1 ip4:192.0.2.0/24 include:x.example -all redirect=y.example foo');
  assert.deepEqual(p.terms.map((t) => t.mech), ['ip4', 'include', 'all']); assert.equal(p.mods.redirect, 'y.example'); assert.match(p.errors[0], /unknown term "foo"/);
  assert.equal(dkimKeyBits(records['s1._domainkey.example.com'].TXT[0].split('p=')[1]), 2048);
  assert.equal(dkimKeyBits('bm90IGEga2V5'), undefined);
  assert.throws(() => validDomain('http://x'), /not a domain name/); assert.equal(validDomain('Send.Example.COM.'), 'send.example.com');
});
test('example.com: lookup count through includes, DKIM, DMARC, MX', async () => {
  const r = await audit('example.com', res, { selectors: ['s1', 'k1', 'old', 'mh'] });
  assert.equal(r.spf_lookups, 12);
  assert.deepEqual(checks(r).slice(0, 3), ['spf_lookup_limit', 'spf_include_missing', 'mx_unresolved']);
  assert.deepEqual(r.dkim.map((d) => [d.selector, d.bits, d.revoked, d.testing]), [['s1', 2048, false, false], ['k1', 1024, false, false], ['old', null, true, false], ['mh', 2048, false, true]], 'CNAME-delegated selector followed');
  assert.ok(checks(r).includes('dmarc_external_rua_unauthorized')); assert.ok(!checks(r).includes('tlsrpt_missing'));
  assert.equal(r.dmarc.policy, 'none'); assert.equal(r.dmarc.pct, 50);
});
test('clean domain, inherited DMARC, null MX, missing everything', async () => {
  assert.equal((await audit('good.example.org', res)).issues, 0);
  const s = await audit('shop.example.com', res);
  assert.ok(checks(s).includes('spf_multiple')); assert.equal(s.dmarc.inherited_from, 'example.com'); assert.ok(checks(s).includes('null_mx'));
  assert.ok(!checks(s).includes('mta_sts_missing'), 'transport checks skipped for a domain that receives no mail');
  const n = await audit('nomail.example.net', res);
  assert.deepEqual(checks(n), ['spf_missing', 'dmarc_missing', 'dkim_not_found', 'mx_missing']);
  const ig = await audit('nomail.example.net', res, { ignore: ['dkim_not_found'] }); assert.equal(ig.issues, 3);
});
test('SPF edge cases and loop protection', async () => {
  const r = recordsResolver({ 'loop.example': { TXT: ['v=spf1 include:b.example +all'] }, 'b.example': { TXT: ['v=spf1 include:loop.example -all'] } });
  const a = await audit('loop.example', r);
  assert.ok(checks(a).includes('spf_pass_all')); assert.ok(checks(a).includes('spf_loop'));
  const q = await audit('x.example', recordsResolver({ 'x.example': { TXT: ['v=spf1 mx'] } }));
  assert.ok(checks(q).includes('spf_no_all'));
});
test('DNS-over-HTTPS resolver: JSON API, TXT joining, failure handling', async () => {
  const calls = [];
  const fake = async (url, opts) => { calls.push([url, opts.headers.accept]); if (url.includes('fail')) throw new Error('offline'); return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 5, data: 'x.' }, { type: 16, data: '"v=spf1 " "-all"' }] }) }; };
  const r = dohResolver('cloudflare', { fetchImpl: fake });
  assert.deepEqual(await r('example.com', 'TXT'), { status: 'NOERROR', answers: ['v=spf1 -all'] });
  assert.equal(calls[0][0], 'https://cloudflare-dns.com/dns-query?name=example.com&type=TXT'); assert.equal(calls[0][1], 'application/dns-json');
  assert.equal((await r('fail.example', 'TXT')).status, 'SERVFAIL');
  assert.throws(() => dohResolver('evil'), /unknown resolver/);
});
test('draft: merge, never enforcing DMARC or keys, markers', async () => {
  const d = draftChanges(await audit('shop.example.com', res), {});
  assert.equal(d.changes[0].proposed, 'v=spf1 include:spf.crm.example.org a -all'); assert.match(d.changes[0].note, /CHECK MERGE/);
  const n = draftChanges(await audit('nomail.example.net', res), { senders: ['include:spf.crm.example.org'], rua: 'dmarc@example.net' });
  assert.deepEqual(n.changes.map((c) => c.proposed), ['v=spf1 include:spf.crm.example.org ~all', 'v=DMARC1; p=none; rua=mailto:dmarc@example.net']); assert.equal(n.open_markers, 0);
  const e = draftChanges(await audit('example.com', res, { selectors: ['s1'] }), {});
  assert.equal(e.changes.length, 0); assert.ok(e.needs_person.some((x) => /does not flatten/.test(x)));
});
test('stage on Auto; DNS change is one-click, hash-bound, marker-gated; editing DNS blocked', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['aeolus_draft_records'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['aeolus_request_dns_change'] }), /one-click/);
  const m = await rt.call('aeolus_draft_records', { domain: 'nomail.example.net', records: 'records.json', out_dir: 'mythos-out/m' });
  const ma = { change: m.result.change, change_sha256: m.result.change_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('aeolus_request_dns_change', ma)).approval_id, 'Lee');
  const refused = await rt.call('aeolus_request_dns_change', ma); assert.equal(refused.status, 'error'); assert.match(refused.reason, /TO CONFIRM/);
  const d = await rt.call('aeolus_draft_records', { domain: 'nomail.example.net', records: 'records.json', senders: ['include:spf.crm.example.org'], rua: 'dmarc@example.net' });
  assert.equal(d.status, 'executed');
  const args = { change: d.result.change, change_sha256: d.result.change_sha256 };
  const a = await rt.call('aeolus_request_dns_change', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Lee');
  const b = await rt.call('aeolus_request_dns_change', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Lee');
  const rows = parseCsv(readFileSync(join(root, 'mythos-out/aeolus/dns-change-requests.csv'), 'utf8'));
  assert.equal(rows[0].status, 'approved - a person edits DNS'); assert.equal(rows[0].records, 'add TXT nomail.example.net; add TXT _dmarc.nomail.example.net');
  const again = await rt.call('aeolus_draft_records', { domain: 'nomail.example.net', records: 'records.json', senders: ['include:x.example'], rua: 'r@example.net', out_dir: 'mythos-out/t' });
  const ta = { change: again.result.change, change_sha256: again.result.change_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('aeolus_request_dns_change', ta)).approval_id, 'Lee');
  writeFileSync(join(root, again.result.change), '{"changes":[]}');
  const t = await rt.call('aeolus_request_dns_change', ta); assert.equal(t.status, 'error'); assert.match(t.reason, /does not match/);
  assert.equal((await rt.call('dns_update', {})).status, 'blocked'); assert.equal((await rt.call('send_test_email', {})).status, 'blocked');
});
test('return_path: SPF is checked on the bounce domain', async () => {
  const r = await audit('nomail.example.net', res, { return_path: 'spf.crm.example.org' });
  assert.equal(r.spf_domain, 'spf.crm.example.org'); assert.ok(!r.findings.some((f) => f.check === 'spf_missing'));
  assert.equal(r.records.spf[0], 'v=spf1 ip4:203.0.113.0/24 -all');
});
