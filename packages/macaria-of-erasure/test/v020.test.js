import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AgentRuntime, ApprovalStore, validateIcs, parseCsv, readAudit, createMcpHandler } from 'mythos-agent-core';
import { manifest, findSubject, applyRetention, trackDeadlines, deadlinesIcs, identifierHashes, RETENTION_RULES_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const h = (alg, s) => createHash(alg).update(s).digest('hex');
const rules = JSON.parse(readFileSync(join(fixtures, 'retention-rules.json'), 'utf8'));

test('hashed identifiers: SHA-256 and MD5 email, SHA-256 phone; raw values never in the output', () => {
  const files = [{ name: 'aud.csv', rows: [{ id: 'A1', em: h('sha256', 'pat@example.com'), ph: h('sha256', '+15125550199') }, { id: 'A2', em: h('md5', 'pat@example.com'), ph: '' }, { id: 'A3', em: h('sha256', 'other@example.com'), ph: '' }] }];
  const r = findSubject(files, { email: ' PAT@example.com ', phone: '(512) 555-0199' });
  assert.equal(r.rows_found, 2); assert.equal(r.rows_matched_by_hash, 2);
  assert.deepEqual(r.files[0].matches[0].matched_on, ['em=email_sha256', 'ph=phone_sha256']);
  assert.deepEqual(r.files[0].matches[1].matched_on, ['em=email_md5']);
  const out = JSON.stringify(r);
  assert.ok(!out.includes('pat@example.com') && !out.includes('5125550199') && !out.includes(h('sha256', 'pat@example.com')));
  assert.ok(identifierHashes('', '12').size === 0, 'short phones are not hashed');
  // phone matched under the last-10-digits form too
  assert.equal(findSubject([{ name: 'p.csv', rows: [{ ph: h('sha256', '5125550199') }] }], { phone: '+1 512 555 0199' }).rows_found, 1);
});

test('retention: holds win, rule ids cited, period from the date column, expired holds ignored', () => {
  const files = [
    { name: 'exports/invoices.csv', rows: [{ customer_id: 'K1', date: '2019-01-01' }, { customer_id: 'K1', date: '2026-01-01' }, { customer_id: 'K1', date: '' }] },
    { name: 'exports/support-tickets.json', rows: [{ customer_id: 'K1' }] },
    { name: 'exports/crm-contacts.csv', rows: [{ customer_id: 'K1' }] },
  ];
  const f = findSubject(files, { ids: ['K1'] });
  const r = applyRetention(files, f, rules, '2026-11-15');
  const by = (file, row) => r.rows.find((x) => x.file === file && x.row === row);
  assert.equal(by('exports/invoices.csv', 2).status, 'period_ended'); assert.equal(by('exports/invoices.csv', 2).rule_id, 'RET-INV-7Y');
  assert.equal(by('exports/invoices.csv', 3).status, 'retain_until'); assert.equal(by('exports/invoices.csv', 3).until, '2032-12-30');
  assert.equal(by('exports/invoices.csv', 4).status, 'date_missing');
  const held = by('exports/support-tickets.json', 2); assert.equal(held.status, 'on_hold'); assert.equal(held.rule_id, 'HOLD-2026-07');
  assert.equal(by('exports/crm-contacts.csv', 2).status, 'no_rule', 'expired hold HOLD-2025-01 no longer applies');
  assert.deepEqual(r.expired_holds_ignored, ['HOLD-2025-01']);
  // after the hold ends, the ticket is no longer held
  assert.equal(applyRetention(files, f, rules, '2027-07-01').rows.find((x) => x.file.includes('support')).status, 'no_rule');
});

test('checklist cites the rule and hold ids when rules are given', async () => {
  const root = tmpRoot('mac2-');
  const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('macaria_build_checklist', { dir: 'exports', email: 'jamie.doe@example.com', ids: ['C-101'], rules: 'retention-rules.json', as_of: '2026-11-15', received: '2026-11-10', regime: 'gdpr' });
  assert.equal(r.status, 'executed');
  const rows = parseCsv(readFileSync(r.result.files[0], 'utf8'));
  assert.match(rows.find((x) => x.system_or_file.includes('support')).retention_check, /HOLD-2026-07/);
  assert.match(rows.find((x) => x.system_or_file.includes('invoices')).retention_check, /RET-INV-7Y/);
  assert.ok(!readFileSync(r.result.files[0], 'utf8').includes('jamie.doe'));
});

test('deadline tracker: due date from the configured period, overdue and due-soon flagged, .ics valid', () => {
  const log = [
    { request_key: 'k1', received: '2026-09-20', regime: 'gdpr', target_date: '2026-10-20', status: 'open' },
    { request_key: 'k2', received: '2026-11-01', regime: 'gdpr', target_date: '2026-12-01', status: 'open' },
    { request_key: 'k3', received: '2026-10-01', regime: 'ccpa', target_date: '', status: 'closed' },
    { request_key: 'k4', received: '2026-11-01', regime: 'other', target_date: '', status: 'open' },
  ];
  const t = trackDeadlines(log, { periods: { gdpr: 20 }, dueSoonDays: 7, asOf: '2026-11-15' });
  const k = (id) => t.items.find((x) => x.request_key === id);
  assert.equal(k('k1').due, '2026-10-10'); assert.equal(k('k1').state, 'overdue'); assert.ok(k('k1').flags[0].startsWith('logged_target_2026-10-20'));
  assert.equal(k('k2').due, '2026-11-21'); assert.equal(k('k2').state, 'due_soon'); assert.equal(k('k2').days_left, 6);
  assert.equal(k('k3').state, 'closed'); assert.equal(k('k4').state, 'no_period_configured');
  assert.equal(t.items[0].request_key, 'k1', 'overdue first');
  assert.equal(trackDeadlines(log, { asOf: '2026-11-15' }).items.find((x) => x.request_key === 'k2').due, '2026-12-01', 'defaults when no rules');
  const ics = deadlinesIcs(t); const v = validateIcs(ics); assert.ok(v.ok, v.errors.join()); assert.equal(v.events, 2); assert.match(ics, /TRIGGER:-P7D/);
});

test('rules file is validated: unknown key, wrong type and missing required fail with JSON pointers', async () => {
  const root = tmpRoot('mac3-');
  const bad = {
    unknown: { ...rules, retention_rules: [{ ...rules.retention_rules[0], keep_dayz: 3 }] },
    wrongType: { ...rules, retention_rules: [{ ...rules.retention_rules[0], keep_days: '7 years' }] },
    missing: { response_periods: { gdpr: 30 } },
  };
  const rt = new AgentRuntime(manifest, { root, audit: false });
  for (const [name, body] of Object.entries(bad)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(body));
    const r = await rt.call('macaria_retention_check', { dir: 'exports', email: 'jamie.doe@example.com', rules: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid retention_rules/, name);
    assert.match(JSON.stringify(r.errors), name === 'missing' ? /retention_rules/ : /\/retention_rules\/0/, name);
  }
  assert.equal(RETENTION_RULES_SCHEMA.additionalProperties, false);
  const ok = await rt.call('macaria_retention_check', { dir: 'exports', email: 'jamie.doe@example.com', rules: 'retention-rules.json', as_of: '2026-11-15' });
  assert.equal(ok.status, 'executed');
});

test('evidence pack: hashes sources, cites rules, lists approved deletions, masks identifiers, hash in audit line', async () => {
  const root = tmpRoot('mac4-');
  const subject = { email: 'jamie.doe@example.com', ids: ['C-101'] };
  await oneClickOnce(root, { system: 'exports/crm-contacts.csv', rows: '3', reason: 'verified pack test', ...subject });
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['macaria_log_request'] });
  assert.equal((await rt.call('macaria_log_request', { ...subject, received: '2026-11-10', regime: 'gdpr' })).status, 'executed');
  const e = await rt.call('macaria_evidence_pack', { dir: 'exports', ...subject, rules: 'retention-rules.json', as_of: '2026-11-15' });
  assert.equal(e.status, 'executed');
  const json = readFileSync(e.result.files[0], 'utf8'); const pack = JSON.parse(json);
  assert.equal(createHash('sha256').update(json).digest('hex'), e.result.output_sha256);
  assert.equal(pack.searched.find((s) => s.file === 'exports/crm-contacts.csv').sha256, createHash('sha256').update(readFileSync(join(root, 'exports/crm-contacts.csv'))).digest('hex'));
  assert.equal(pack.deletion_requests.length, 1); assert.equal(pack.request.regime, 'gdpr');
  assert.ok(pack.kept.some((k) => /HOLD-2026-07/.test(k))); assert.ok(pack.kept.some((k) => /RET-INV-7Y/.test(k)));
  assert.ok(pack.open_items.some((o) => /newsletter/.test(o)));
  for (const f of e.result.files) assert.ok(!readFileSync(f, 'utf8').toLowerCase().includes('jamie.doe'));
  assert.match(readFileSync(e.result.files[1], 'utf8'), /default-src 'none'/);
  const line = readAudit(join(root, '.mythos', 'audit.jsonl')).filter((l) => l.tool === 'macaria_evidence_pack').pop();
  assert.equal(line.output_sha256, e.result.output_sha256);
});

async function oneClickOnce(root, args) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['macaria_request_deletion'] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call('macaria_request_deletion', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin (fictional)');
  const b = await rt.call('macaria_request_deletion', args); assert.equal(b.status, 'executed');
  assert.equal((await rt.call('macaria_request_deletion', args)).status, 'needs_approval');
}

test('new tools: read/report only, allowed in review; deletion still one-click; MCP prompt renders', async () => {
  const root = tmpRoot('mac5-');
  const rt = new AgentRuntime(manifest, { root, mode: 'review', audit: false });
  assert.equal((await rt.call('macaria_retention_check', { dir: 'exports', ids: ['C-101'], rules: 'retention-rules.json' })).status, 'executed');
  assert.equal((await rt.call('macaria_request_deletion', { system: 'x', reason: 'review test' })).status, 'blocked');
  const missing = await rt.call('macaria_deadlines', {}); assert.equal(missing.status, 'error'); assert.match(missing.reason, /no request log/);
  for (const t of ['macaria_retention_check', 'macaria_deadlines', 'macaria_evidence_pack']) assert.ok(['read', 'report'].includes(manifest.tools.find((x) => x.name === t).kind));
  const handle = createMcpHandler(new AgentRuntime(manifest, { root, audit: false }));
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.equal(list.result.prompts[0].name, 'erasure_request_workflow');
  const got = await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'erasure_request_workflow', arguments: { dir: 'exports', identifiers: '{"ids":["C-101"]}', received: '2026-11-10' } } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /exports/); assert.match(text, /macaria_request_deletion/); assert.match(text, /one click/); assert.ok(!/\{\{/.test(text));
  assert.ok(existsSync(join(root, 'retention-rules.json')));
});
