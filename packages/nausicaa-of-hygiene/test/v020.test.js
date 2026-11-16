import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, createMcpHandler, annotationsFor } from 'mythos-agent-core';
import { manifest, normContacts, audit, mergePlan, mergeCsv, MERGE_COLUMNS, consentProvenance, compareAudits, setTransport, dohResolver, RESOLVERS, checkDomains } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const c = (o) => ({ id: 'X', email: 'pat@example.com', name: 'Pat', company: '', last_activity: '2026-11-01', consent: 'yes', consent_date: '2026-01-01', consent_source: 'web form', unsubscribed: 'no', status: 'subscribed', ...o });

// No test in this file may reach the network: any real fetch fails the test.
const realFetch = globalThis.fetch; let realCalls = 0;
globalThis.fetch = async () => { realCalls++; throw new Error('network is not allowed in tests'); };
after(() => { globalThis.fetch = realFetch; setTransport(null); assert.equal(realCalls, 0, 'no real network calls'); });

test('merge plan: survivor and field winners each explained; opt-outs and hard bounces carry over', () => {
  const contacts = normContacts([
    c({ id: 'A', email: 'pat@example.com', name: 'P', company: 'Old Co', last_activity: '2026-01-01', consent_date: '', consent_source: '' }),
    c({ id: 'B', email: 'PAT+news@example.com', name: 'Pat Quinn', company: '', last_activity: '2026-10-01', bounce: 'hard', consent_date: '' }),
    c({ id: 'C', email: 'pat@example.com', name: '', company: 'New Co', last_activity: '2026-06-01', consent_date: '2025-05-05', consent_source: 'event' }),
  ]);
  const p = mergePlan(contacts, audit(contacts, { as_of: '2026-11-14' }).items);
  assert.equal(p.groups, 1); const g = p.plan[0];
  assert.equal(g.survivor_id, 'C', 'B hard-bounced (S1), C is more recent than A (S2)');
  assert.match(g.survivor_rule, /^S1/);
  const f = (name) => g.fields.find((x) => x.field === name);
  assert.equal(f('name').value, 'Pat Quinn'); assert.equal(f('name').from_id, 'B'); assert.match(f('name').rule, /^F2/);
  assert.equal(f('company').value, 'New Co'); assert.equal(f('last_activity').from_id, 'B');
  assert.equal(f('consent_date').from_id, 'C'); assert.match(f('consent_source').rule, /^F5/);
  assert.equal(f('bounce').from_id, 'B'); assert.match(f('bounce').rule, /^F6/);
  for (const x of g.fields) assert.ok(x.rule.length > 10, `rule explained for ${x.field}`);
  const optOut = normContacts([c({ id: 'A' }), c({ id: 'B', email: 'Pat@example.com', unsubscribed: 'yes', last_activity: '2025-01-01' })]);
  const g2 = mergePlan(optOut, audit(optOut, { as_of: '2026-11-14' }).items).plan[0];
  assert.equal(g2.fields.find((x) => x.field === 'consent').value, 'no'); assert.equal(g2.fields.find((x) => x.field === 'unsubscribed').from_id, 'B');
  const rows = parseCsv(mergeCsv(p)); assert.deepEqual(Object.keys(rows[0]), MERGE_COLUMNS); assert.equal(rows[0].reviewer_decision, '');
});

test('consent provenance: missing source or date flagged; future and invalid dates; allowed sources', () => {
  const r = consentProvenance(normContacts([
    c({ id: 'ok' }), c({ id: 'nosrc', consent_source: '' }), c({ id: 'nodate', consent_date: '' }), c({ id: 'future', consent_date: '2027-01-01' }),
    c({ id: 'bad', consent_date: 'last spring' }), c({ id: 'other', consent_source: 'purchased list' }), c({ id: 'out', unsubscribed: 'yes', consent_source: '' }), c({ id: 'nocons', consent: '', consent_source: '', consent_date: '' }),
  ]), { as_of: '2026-11-14', allowed_sources: ['web form'] });
  const flags = Object.fromEntries(r.items.map((i) => [i.id, i.flags]));
  assert.deepEqual(flags.nosrc, ['consent_source_missing']); assert.deepEqual(flags.nodate, ['consent_date_missing']);
  assert.deepEqual(flags.future, ['consent_date_in_future']); assert.deepEqual(flags.bad, ['consent_date_invalid']);
  assert.deepEqual(flags.other, ['consent_source_not_allowed']);
  assert.deepEqual(flags.nocons, ['consent_status_missing', 'consent_source_missing', 'consent_date_missing']);
  assert.ok(!flags.ok && !flags.out, 'complete and opted-out contacts are not flagged');
  assert.equal(r.in_scope, 7); assert.equal(r.complete, 1);
});

test('health score is explained and drops as issues rise; period-over-period comparison', () => {
  const clean = audit(normContacts([c({ id: 'A' }), c({ id: 'B', email: 'b@example.com' })]), { as_of: '2026-11-14' });
  assert.equal(clean.health.score, 100); assert.deepEqual(clean.health.deductions, []);
  const worse = audit(normContacts([c({ id: 'A', bounce: 'hard' }), c({ id: 'B', email: 'b@example.com' })]), { as_of: '2026-11-14' });
  assert.equal(worse.health.score, 50); assert.match(worse.health.deductions[0].explain, /1 of 2 contact\(s\)/);
  const cmp = compareAudits(clean, worse);
  assert.equal(cmp.health_change, -50); assert.deepEqual(cmp.newly_flagged_contacts.map((x) => x.id), ['A']); assert.equal(cmp.newly_flagged_contacts[0].new_flags[0], 'hard_bounce');
  const back = compareAudits(worse, clean); assert.equal(back.improved, 1);
  const added = compareAudits(clean, audit(normContacts([c({ id: 'A' }), c({ id: 'C', email: 'c@example.com' })]), { as_of: '2026-11-14' }));
  assert.equal(added.added, 1); assert.equal(added.removed, 1);
});

test('hygiene rules file extends the lists and is validated (unknown key, wrong type, missing required)', async () => {
  const root = tmpRoot('nau2-'); const rt = new AgentRuntime(manifest, { root, audit: false });
  writeFileSync(join(root, 'x.csv'), 'id,email,name,consent,consent_date,last_activity\nE1,events@example.com,Ev,yes,2026-01-01,2026-11-01\nE2,a@throwaway.example,A,yes,2026-01-01,2026-11-01\nE3,b@exmaple.com,B,yes,2026-01-01,2026-11-01\n');
  const r = await rt.call('nausicaa_audit', { contacts: 'x.csv', as_of: '2026-11-14', rules: 'hygiene-rules.json' });
  assert.equal(r.status, 'executed');
  assert.deepEqual(r.result.items.map((i) => i.flags[0]), ['role_address', 'disposable_domain', 'domain_typo_example.com']);
  const base = JSON.parse(readFileSync(join(fixtures, 'hygiene-rules.json'), 'utf8'));
  const bad = { unknown: { ...base, stale_dayz: 10 }, wrongType: { ...base, extra_role_locals: 'events' }, missing: { stale_days: 200 } };
  const ptr = { unknown: /stale_dayz/, wrongType: /\/extra_role_locals/, missing: /version/ };
  for (const [name, body] of Object.entries(bad)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(body));
    const x = await rt.call('nausicaa_consent_provenance', { contacts: 'contacts.csv', rules: `${name}.json` });
    assert.equal(x.status, 'error', name); assert.match(x.reason, /not a valid hygiene_rules/, name); assert.match(JSON.stringify(x.errors), ptr[name], name);
  }
});

test('MX check is off by default: needs a yes, blocked in review, refuses without records or allow_network, audit tools never fetch', async () => {
  const root = tmpRoot('nau3-');
  const t = manifest.tools.find((x) => x.name === 'nausicaa_check_mx');
  assert.equal(t.kind, 'write'); assert.equal(annotationsFor(t).openWorldHint, true);
  for (const x of manifest.tools.filter((y) => y.name !== 'nausicaa_check_mx')) assert.ok(!x.openWorld, `${x.name} is offline`);
  const assist = new AgentRuntime(manifest, { root, audit: false });
  assert.equal((await assist.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true })).status, 'needs_approval');
  const review = new AgentRuntime(manifest, { root, audit: false, mode: 'review' });
  const rv = await review.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true }); assert.equal(rv.status, 'blocked'); assert.match(rv.reason, /Review mode/);
  const auto = new AgentRuntime(manifest, { root, audit: false, mode: 'auto', autoActions: ['nausicaa_check_mx'] });
  const none = await auto.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv' }); assert.equal(none.status, 'error'); assert.match(none.reason, /Off by default/);
  const badResolver = await auto.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true, resolver: 'evil.example' }); assert.equal(badResolver.status, 'error'); assert.match(badResolver.reason, /invalid arguments/);
  for (const tool of ['nausicaa_audit', 'nausicaa_merge_plan', 'nausicaa_consent_provenance', 'nausicaa_write_cleanup']) assert.equal((await auto.call(tool, { contacts: 'contacts.csv', as_of: '2026-11-14' })).status, 'executed');
  const off = await auto.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', records: 'mx-records.json' });
  assert.equal(off.status, 'executed');
  const st = Object.fromEntries(off.result.results.map((x) => [x.domain, x.status]));
  assert.deepEqual(st, { 'example.com': 'has_mx', 'example.org': 'has_mx', 'missing.example': 'domain_not_found', 'nomail.example': 'no_mail_host', 'web-only.example': 'no_mx_implicit_a' });
  assert.equal(off.result.results.find((x) => x.domain === 'example.com').contacts, 2);
  assert.equal(parseCsv(readFileSync(off.result.file, 'utf8')).length, 5);
  assert.equal(realCalls, 0);
});

test('opt-in live MX check sends domain names only, to the allowlisted resolver only (fake transport)', async () => {
  const urls = [];
  setTransport(async (url) => {
    urls.push(url); const u = new URL(url); const name = u.searchParams.get('name'); const type = u.searchParams.get('type');
    const zone = { 'example.com': { MX: [{ type: 15, data: '10 mx.example.com.' }] }, 'example.org': { MX: [{ type: 15, data: '10 mx.example.org.' }] }, 'web-only.example': { A: [{ type: 1, data: '192.0.2.10' }] }, 'nomail.example': { MX: [{ type: 15, data: '0 .' }] } };
    const z = zone[name];
    return { ok: true, status: 200, json: async () => (z ? { Status: 0, Answer: z[type] || [] } : { Status: 3 }) };
  });
  try {
    const root = tmpRoot('nau4-');
    const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['nausicaa_check_mx'], audit: false });
    const r = await rt.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true, resolver: 'google' });
    assert.equal(r.status, 'executed', r.reason);
    assert.ok(urls.length >= 5);
    for (const u of urls) { assert.ok(u.startsWith(RESOLVERS.google + '?'), u); assert.ok(!u.includes('%40') && !u.includes('@'), 'no full addresses sent'); }
    assert.ok(!urls.some((u) => /pat|sam|lee|kim|jo|ann/.test(new URL(u).searchParams.get('name').split('.')[0]) && !/example/.test(u)));
    assert.equal(r.result.results.find((x) => x.domain === 'missing.example').status, 'domain_not_found');
    assert.equal(r.result.results.find((x) => x.domain === 'nomail.example').status, 'no_mail_host');
    urls.length = 0;
    await rt.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true, max_domains: 2 });
    assert.ok(urls.every((u) => u.startsWith(RESOLVERS.cloudflare + '?')), 'default resolver is cloudflare');
    assert.throws(() => dohResolver('evil'), /unknown resolver/);
    const inv = await checkDomains(['bad_domain!'], dohResolver('cloudflare')); assert.equal(inv.results[0].status, 'invalid_domain');
    setTransport(async () => { throw new Error('offline'); });
    const fail = await rt.call('nausicaa_check_mx', { contacts: 'mx-contacts.csv', allow_network: true, max_domains: 1 });
    assert.equal(fail.result.results[0].status, 'lookup_failed');
  } finally { setTransport(null); }
  assert.equal(realCalls, 0);
});

test('bulk delete still one-click; MCP prompt renders', async () => {
  const root = tmpRoot('nau5-');
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['nausicaa_request_bulk_delete'] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const args = { ids: ['C8', 'C9'], reason: 'v020 one-click test' };
  const a = await rt.call('nausicaa_request_bulk_delete', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin (fictional)');
  assert.equal((await rt.call('nausicaa_request_bulk_delete', args)).status, 'executed');
  assert.equal((await rt.call('nausicaa_request_bulk_delete', args)).status, 'needs_approval');
  const handle = createMcpHandler(new AgentRuntime(manifest, { root, audit: false }));
  const got = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'list_hygiene_workflow', arguments: { contacts: 'contacts.csv' } } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /contacts\.csv/); assert.match(text, /nausicaa_merge_plan/); assert.match(text, /one click/); assert.match(text, /allow_network:true/);
});
