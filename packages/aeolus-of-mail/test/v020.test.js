import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { AgentRuntime, ApprovalStore, readAudit, validateIcs, createMcpHandler, writeZip } from 'mythos-agent-core';
import { manifest, audit, recordsResolver, reportXmls, parseAggregate, summarise, checkHeaders, planRollout, setDmarcPolicy, checkRolloutOrder, DEFAULT_ROLLOUT } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const res = recordsResolver(JSON.parse(readFileSync(join(fixtures, 'records.json'), 'utf8')));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'aeolus-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const checks = (r) => r.findings.map((f) => f.check);
const msg = (n) => readFileSync(join(fixtures, 'messages', n), 'utf8');
// Every test here must run offline: fetch is replaced by a counter, and the last test asserts it never ran.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network used in a test'); };

test('BIMI: syntax, https SVG logo, certificate, needs DMARC enforcement', async () => {
  const b = await audit('brand.example.net', res);
  assert.deepEqual(checks(b).filter((c) => c.startsWith('bimi')).sort(), ['bimi_dmarc_not_enforced', 'bimi_logo_url', 'bimi_no_vmc']);
  assert.equal(b.bimi.logo, 'http://brand.example.net/logo.png');
  const g = await audit('good.example.org', res); assert.equal(g.issues, 0); assert.equal(g.bimi.authority, 'https://brand.good.example.org/vmc.pem');
  const custom = recordsResolver({ 'x.example': { TXT: ['v=spf1 -all'] }, '_dmarc.x.example': { TXT: ['v=DMARC1; p=reject; rua=mailto:d@x.example'] }, 'brand._bimi.x.example': { TXT: ['v=BIMI1; l=https://x.example/l.svg; a=http://x.example/c.txt', 'v=BIMI1; l=https://x.example/old.svg'] }, 'default._bimi.x.example': { TXT: ['v=BIMI1; l=; a=;'] } });
  const c = await audit('x.example', custom, { bimi_selector: 'brand' });
  assert.ok(checks(c).includes('bimi_syntax')); assert.ok(checks(c).includes('bimi_vmc_url')); assert.ok(!checks(c).includes('bimi_dmarc_not_enforced'));
  const d = await audit('x.example', custom); assert.equal(d.bimi.declined, true); assert.ok(!checks(d).some((x) => x.startsWith('bimi')));
  assert.equal((await audit('nomail.example.net', res)).bimi, null, 'no BIMI record is not a finding');
});

test('DMARC aggregate reports: xml, gz and zip, duplicates once, pass/fail by source with reasons', () => {
  const parsed = [];
  for (const n of ['mailbox.example_example.com_20261001.xml', 'inbox.example.org_example.com_20261002.xml.gz', 'resent-duplicate.zip']) for (const x of reportXmls(n, readFileSync(join(fixtures, 'dmarc', n)))) parsed.push(parseAggregate(x, n));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].records[1].dkim_auth[0].domain, 'crm.example.org');
  const s = summarise(parsed, { domain: 'example.com' });
  assert.equal(s.reports, 2); assert.equal(s.duplicate_reports_skipped, 1); assert.equal(s.messages, 995); assert.equal(s.pass_rate, 86.4);
  assert.deepEqual(s.sources.map((x) => [x.source_ip, x.status, x.messages]), [['198.51.100.7', 'partly_failing', 200], ['203.0.113.99', 'failing', 15], ['192.0.2.10', 'passing', 780]]);
  assert.match(s.sources[0].why.join(' '), /custom Return-Path/); assert.match(s.sources[0].why.join(' '), /custom DKIM/);
  assert.match(s.sources[1].why[0], /may be spoofing/);
  assert.equal(s.readiness.ready, false); assert.deepEqual(s.period, { from: '2026-10-01', to: '2026-10-03', days: 2 });
  assert.throws(() => reportXmls('x.xml', Buffer.from('<!DOCTYPE x [<!ENTITY a "b">]><feedback/>')), /refused/);
  assert.throws(() => parseAggregate('<html></html>'), /not a DMARC aggregate report/);
  assert.throws(() => reportXmls('x.pdf', Buffer.from('')), /must be \.xml/);
  assert.equal(reportXmls('a.zip', writeZip({ 'a.xml': '<feedback/>', 'readme.txt': 'x' })).length, 1);
  assert.equal(reportXmls('a.gz', gzipSync('<feedback/>'))[0], '<feedback/>');
});

test('message headers: receiver results, alignment, selectors in use, ARC chain structure', () => {
  const f = checkHeaders(msg('forwarded.eml'));
  assert.deepEqual([f.from_domain, f.dkim_aligned, f.spf_aligned, f.receiver_results.dmarc], ['example.com', true, false, 'pass']);
  assert.deepEqual(f.selectors_in_use, ['s1']); assert.deepEqual(checks(f), ['hdr_spf_not_aligned']);
  assert.deepEqual(f.arc.chain.map((c) => [c.i, c.cv, c.complete]), [[1, 'none', true], [2, 'pass', true]]);
  const b = checkHeaders(msg('broken-arc.eml'));
  assert.deepEqual(checks(b), ['hdr_dmarc_fail', 'arc_instance_gap', 'arc_incomplete_set', 'arc_chain_failed', 'hdr_dkim_not_aligned', 'hdr_dkim_sha1', 'hdr_spf_not_aligned']);
  const t = checkHeaders(msg('forwarded.eml'), { trusted_authserv: 'mx.other.example' }); assert.ok(checks(t).includes('hdr_no_auth_results'));
  assert.throws(() => checkHeaders('\n\nbody only'), /no headers found/);
  const bad = checkHeaders('From: a@x.example\nARC-Seal: i=1; cv=pass; d=x.example\nARC-Message-Signature: i=1\nARC-Authentication-Results: i=1; x\n');
  assert.ok(checks(bad).includes('arc_cv_invalid'));
});

test('rollout: one stage at a time, never straight to reject, dates, inherited policy respected', async () => {
  assert.equal(setDmarcPolicy('v=DMARC1; p=none; pct=50; rua=mailto:a@x.example; sp=none', 'quarantine', 25), 'v=DMARC1; p=quarantine; pct=25; rua=mailto:a@x.example; sp=none');
  const n = planRollout(await audit('nomail.example.net', res), { start_date: '2026-11-16', rua: 'dmarc@example.net' });
  assert.deepEqual(n.stages.map((s) => `${s.policy}:${s.pct}:${s.earliest_date}`), ['none:100:2026-11-16', 'quarantine:25:2026-12-07', 'quarantine:100:2026-12-21', 'reject:25:2027-01-04', 'reject:100:2027-01-18']);
  assert.equal(n.next_change.action, 'add'); assert.equal(n.next_change.proposed, 'v=DMARC1; p=none; rua=mailto:dmarc@example.net');
  for (const p of [n, planRollout(await audit('brand.example.net', res), { start_date: '2026-11-16' })]) {
    const firstReject = p.stages.findIndex((s) => s.policy === 'reject');
    assert.ok(firstReject > 0, 'there is always a stage before reject');
  }
  const b = planRollout(await audit('brand.example.net', res), { start_date: '2026-11-16' });
  assert.deepEqual(b.stages.map((s) => `${s.policy}:${s.pct}`), ['quarantine:100', 'reject:25', 'reject:100']);
  assert.match(b.next_change.note, /\[TO CONFIRM DMARC reports/);
  assert.equal(planRollout(await audit('good.example.org', res), { start_date: '2026-11-16' }).done, true);
  const inh = planRollout({ domain: 'sub.example.com', records: {}, dmarc: { policy: 'quarantine', pct: 100, inherited_from: 'example.com' } }, { start_date: '2026-11-16', rua: 'd@example.com' });
  assert.equal(inh.stages[0].policy, 'reject', 'a subdomain plan never starts weaker than the inherited policy'); assert.equal(inh.next_change.action, 'add');
  assert.throws(() => checkRolloutOrder({ stages: [{ policy: 'none', pct: 100, min_days: 1 }, { policy: 'reject', pct: 100, min_days: 0 }] }), /never skips straight to reject/);
  assert.throws(() => checkRolloutOrder({ stages: [{ policy: 'quarantine', pct: 50, min_days: 1 }, { policy: 'quarantine', pct: 25, min_days: 1 }, { policy: 'reject', pct: 100, min_days: 0 }] }), /not a step up/);
  assert.throws(() => checkRolloutOrder({ stages: [{ policy: 'none', pct: 100, min_days: 1 }, { policy: 'quarantine', pct: 100, min_days: 1 }] }), /last stage must be reject/);
  const ba = await audit('brand.example.net', res); assert.throws(() => planRollout(ba, { start_date: '16/11/2026' }), /YYYY-MM-DD/);
  assert.ok(checkRolloutOrder({ ...DEFAULT_ROLLOUT }));
});

test('rollout tool: .ics, marker-gated next stage, DNS change stays one-click; signed output hash in the audit log', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['aeolus_plan_dmarc_rollout'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['aeolus_request_dns_change'] }), /one-click/);
  const noReports = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'brand.example.net', records: 'records.json', start_date: '2026-11-16', out_dir: 'mythos-out/r1' });
  assert.equal(noReports.status, 'executed');
  const ics = readFileSync(join(root, 'mythos-out/r1/dmarc-rollout.ics'), 'utf8'); const v = validateIcs(ics);
  assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 3); assert.match(ics, /TRIGGER:-P3D/);
  const r1 = { change: noReports.result.change, change_sha256: noReports.result.change_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('aeolus_request_dns_change', r1)).approval_id, 'Lee');
  assert.match((await rt.call('aeolus_request_dns_change', r1)).reason, /TO CONFIRM/, 'enforcement without reports is refused even after the click');
  const ready = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'brand.example.net', records: 'records.json', start_date: '2026-11-16', reports: ['dmarc-brand'], out_dir: 'mythos-out/r2' });
  assert.match(ready.result.summary, /99\.5% of 1005/);
  const r2 = { change: ready.result.change, change_sha256: ready.result.change_sha256 };
  const ask = await rt.call('aeolus_request_dns_change', r2); assert.equal(ask.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(ask.approval_id, 'Lee');
  const ok = await rt.call('aeolus_request_dns_change', r2); assert.equal(ok.status, 'executed'); assert.equal(ok.approved_by, 'Lee');
  const notReady = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'example.com', records: 'records.json', start_date: '2026-11-16', reports: ['dmarc'], config: 'dmarc-rollout.json', out_dir: 'mythos-out/r3' });
  assert.deepEqual(notReady.result.plan.stages.map((s) => `${s.policy}:${s.pct}:${s.earliest_date}`), ['none:100:2026-11-16', 'quarantine:10:2026-12-14', 'quarantine:100:2026-12-28', 'reject:100:2027-01-18']);
  assert.equal(notReady.result.plan.pass_threshold, 99);
  const line = readAudit(join(root, '.mythos/audit.jsonl')).filter((e) => e.tool === 'aeolus_plan_dmarc_rollout' && e.status === 'executed').pop();
  assert.equal(line.output_sha256, notReady.result.output_sha256);
});

test('rollout config schema: unknown key, wrong type and missing field fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['aeolus_plan_dmarc_rollout'] });
  const good = JSON.parse(readFileSync(join(root, 'dmarc-rollout.json'), 'utf8'));
  const cases = [
    ['unknown', { ...good, pass_treshold: 99 }, /pass_treshold/],
    ['wrongtype', { ...good, stages: good.stages.map((s, i) => (i === 1 ? { ...s, pct: '10' } : s)) }, /\/stages\/1\/pct/],
    ['missing', { reminder_days: [1] }, /stages/],
  ];
  for (const [name, cfg, re] of cases) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(cfg));
    const r = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'brand.example.net', records: 'records.json', start_date: '2026-11-16', config: `${name}.json`, out_dir: `mythos-out/${name}` });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid dmarc_rollout/); assert.match(r.reason, re);
  }
  writeFileSync(join(root, 'skip.json'), JSON.stringify({ stages: [{ policy: 'none', pct: 100, min_days: 7 }, { policy: 'reject', pct: 100, min_days: 0 }] }));
  const skip = await rt.call('aeolus_plan_dmarc_rollout', { domain: 'brand.example.net', records: 'records.json', start_date: '2026-11-16', config: 'skip.json' });
  assert.match(skip.reason, /never skips straight to reject/);
});

test('report tools: HTML report and sources CSV; read tools via the runtime; bad args refused', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const w = await rt.call('aeolus_write_report', { domain: 'example.com', records: 'records.json', reports: ['dmarc'], out_dir: 'mythos-out/w' });
  assert.equal(w.status, 'executed'); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
  const html = readFileSync(join(root, 'mythos-out/w/mail-dns-audit.html'), 'utf8');
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /<script/i); assert.match(html, /198\.51\.100\.7/);
  assert.match(readFileSync(join(root, 'mythos-out/w/dmarc-sources.csv'), 'utf8'), /^source_ip,status,messages/);
  const d = await rt.call('aeolus_dmarc_reports', { reports: ['dmarc'], domain: 'example.com', pass_threshold: 80 });
  assert.equal(d.result.readiness.ready, true); assert.equal(d.decision, 'allow');
  const h = await rt.call('aeolus_check_headers', { message: 'messages/broken-arc.eml' }); assert.equal(h.result.by_severity.error, 4);
  assert.match((await rt.call('aeolus_check_headers', { message: 'records.json' })).reason, /\.eml or \.txt/);
  assert.match((await rt.call('aeolus_dmarc_reports', { reports: [] })).reason, /invalid arguments/);
  assert.match((await rt.call('aeolus_dmarc_reports', { reports: ['../x'] })).reason, /outside|root/i);
});

test('MCP prompt walks the workflow and marks the human click', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.deepEqual(list.result.prompts.map((p) => p.name), ['mail_dns_review']);
  const g = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'mail_dns_review', arguments: { domain: 'example.com', reports: 'dmarc' } } });
  const text = g.result.messages[0].content.text;
  for (const t of ['aeolus_check_headers', 'aeolus_audit', 'aeolus_dmarc_reports', 'aeolus_plan_dmarc_rollout', 'aeolus_request_dns_change', 'one click']) assert.ok(text.includes(t), t);
  assert.match(text, /example\.com/); assert.match(text, /\[start_date\]/);
});

test('no test in this file made a network call; tools that can do live lookups are marked open-world', () => {
  assert.equal(fetchCalls, 0);
  assert.deepEqual(manifest.tools.filter((t) => t.openWorld).map((t) => t.name).sort(), ['aeolus_audit', 'aeolus_draft_records', 'aeolus_plan_dmarc_rollout', 'aeolus_write_report']);
});
