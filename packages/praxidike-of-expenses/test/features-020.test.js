import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, sha256, validate, readAudit } from 'mythos-agent-core';
import { manifest, review, normalizeReceipt, parseAmount, findDuplicates, auditQueue, findRate, POLICY_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const policy = JSON.parse(readFileSync(join(fixtures, 'policy.json'), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const style = (f) => normalizeReceipt(readFileSync(join(fixtures, 'receipt-styles', f), 'utf8'));
const receiptsDir = join(fixtures, 'receipts');

test('receipt normalisation: five text styles give merchant, total, date and currency', () => {
  const want = {
    's1-us-diner.txt': ['Bluebird Diner', 30.52, '2026-11-03', 'USD'],
    's2-amount-due.txt': ['Northwind Supplies', 1234.5, '2026-10-28', 'USD'],
    's3-eu-comma.txt': ['Café Lindenhof', 45.84, '2026-10-14', 'EUR'],
    's4-month-name.txt': ['Harbour Taxi Co.', 20, '2026-11-03', 'GBP'],
    's5-grand-total.txt': ['Maple Lodge Hotel', 427.14, '2026-09-14', 'CAD'],
  };
  for (const [f, [merchant, total, date, currency]] of Object.entries(want)) {
    const r = style(f);
    assert.deepEqual([r.merchant, r.total, r.date, r.currency], [merchant, total, date, currency], f);
  }
  assert.equal(style('s1-us-diner.txt').tax, 2.02); assert.equal(style('s1-us-diner.txt').tip, 4); assert.equal(style('s1-us-diner.txt').subtotal, 24.5);
  assert.equal(style('s3-eu-comma.txt').tax, 7.32);
  assert.deepEqual([parseAmount('1.234,56'), parseAmount('1,234.56'), parseAmount('45,90'), parseAmount('12')], [1234.56, 1234.56, 45.9, 12]);
  assert.equal(normalizeReceipt('Subtotal 10.00\nTotal 12.00').total, 12, 'subtotal is not the total');
  assert.equal(normalizeReceipt('Shop\nTotal 5.00\nGrand total 7.00\nBalance due 7.00').total, 7, 'grand total wins');
  assert.equal(normalizeReceipt('Shop\n02/30/2026\nTotal 1.00').date, null, 'impossible dates are ignored');
});

test('read_receipts tool never returns receipt text and masks card-like numbers', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const r = await rt.call('praxidike_read_receipts', { receipts: 'receipts' });
  assert.equal(r.status, 'executed'); assert.equal(r.result.receipts.length, 8);
  const out = JSON.stringify(r);
  for (const s of ['Room 214', 'card ending 0000', 'Table 7', 'MSP-DEN', 'TABLE 7']) assert.ok(!out.includes(s), `${s} leaked`);
  const hotel = r.result.receipts.find((x) => x.file === 'r101-hotel.txt');
  assert.deepEqual([hotel.merchant, hotel.total, hotel.dates], ['HARBOR INN', 480, ['2026-10-04', '2026-10-06']]);
  assert.equal(normalizeReceipt('4111 1111 1111 1111 Shop\nTotal 1.00').merchant, '•••• 1111 Shop');
  const only = await rt.call('praxidike_read_receipts', { receipts: 'receipts', files: ['r102-app.txt'] });
  assert.equal(only.result.receipts.length, 1); assert.equal(only.result.receipts[0].total, 49);
  assert.equal((await rt.call('praxidike_read_receipts', { receipts: 'receipts', files: ['../policy.json'] })).status, 'error', 'path traversal refused by schema');
});

test('per diem applies by location and date; mileage rate by date', () => {
  const r = review(rd('expenses-travel.csv'), policy);
  const l = (rep, id) => r.items.find((x) => x.report_id === rep && x.line_id === id);
  assert.equal(l('R-201', '1').allowed, 128); assert.match(l('R-201', '1').findings[0].detail, /64\.00 per day limit \(per diem for Duluth, MN, 2026-01-01 to 2026-12-31\) × 2/);
  assert.equal(l('R-201', '1').findings[0].policy_section, '§3.7 Per diem (meals)');
  assert.equal(l('R-201', '2').decision, 'approve', 'Fargo falls back to the "*" rate of 59');
  assert.equal(l('R-202', '1').decision, 'approve', 'May mileage uses 0.67: 100 mi = 67.00');
  assert.equal(l('R-202', '2').allowed, 70); assert.match(l('R-202', '2').findings[0].detail, /0\.7 \(rate for 2026-07-01 to open\)/);
  assert.equal(r.recommended, 324);
  // A 2027 Duluth line falls outside the dated Duluth rate and gets the "*" rate.
  const late = review([{ report_id: 'X', line_id: '1', employee: 'Z', date: '2027-01-05', category: 'per_diem_meals', amount: '64', purpose: 'p', days: '1', location: 'Duluth, MN' }], policy);
  assert.equal(late.items[0].allowed, 59);
  const noRate = review([{ report_id: 'X', employee: 'Z', date: '2025-12-01', category: 'mileage', amount: '10', miles: '10', purpose: 'p' }], policy);
  assert.equal(noRate.items[0].findings[0].check, 'mileage_rate_missing');
  const noPd = review([{ report_id: 'X', employee: 'Z', date: '2026-10-01', category: 'per_diem_meals', amount: '10', purpose: 'p', location: 'Oslo' }], { ...policy, per_diem: { rates: [{ location: 'Duluth, MN', meals: 64 }] } });
  assert.equal(noPd.items[0].findings[0].check, 'per_diem_rate_missing');
  assert.equal(findRate([{ location: 'A', from: '2026-01-01', to: '2026-01-31', meals: 1 }, { location: 'a', from: '2026-02-01', meals: 2 }], 'A', Date.UTC(2026, 1, 3)).meals, 2);
});

test('duplicates across reports: receipt hash and fuzzy amount/date match', () => {
  const d = findDuplicates(rd('expenses.csv'), { history: rd('history.csv'), receiptsDir });
  assert.equal(d.pairs, 4); assert.equal(d.cross_period, 3);
  const pair = (a, b) => d.items.find((p) => p.a === a && p.b === b);
  const scan = pair('R-101/2', 'H-090/1'); assert.ok(scan.receipt_match); assert.equal(scan.score, 100);
  assert.match(scan.reasons[0].reason, /identical receipt text after normalising/);
  const fz = pair('R-104/2', 'H-091/1'); assert.equal(fz.kind, 'fuzzy'); assert.equal(fz.score, 53); assert.ok(fz.reasons.some((r) => /1 day\(s\) apart/.test(r.reason)));
  assert.ok(!d.items.some((p) => p.b === 'H-092/1'), 'a monthly subscription 30 days apart is not a duplicate');
  assert.equal(findDuplicates(rd('expenses.csv'), { history: rd('history.csv'), receiptsDir, date_window_days: 0 }).pairs, 2, 'window 0 drops the 1-day fuzzy pairs');
  assert.equal(findDuplicates(rd('expenses.csv'), { receiptsDir }).pairs, 1);
  // Two different receipt files with the same merchant, total and date (different wording) are caught too.
  const dir = mkdtempSync(join(tmpdir(), 'prax-dup-'));
  writeFileSync(join(dir, 'a.txt'), 'Corner Cafe (fictional)\n2026-11-01\nTotal $12.40\n'); writeFileSync(join(dir, 'b.txt'), 'Corner Cafe\nDate: 2026-11-01\nCard sale\nTOTAL 12.40\n');
  const two = findDuplicates([{ report_id: 'A', line_id: '1', employee: 'X', merchant: 'Cafe', amount: '12.40', date: '2026-11-01', receipt: 'a.txt' }, { report_id: 'B', line_id: '1', employee: 'Y', merchant: 'Other', amount: '12.40', date: '2026-11-01', receipt: 'b.txt' }], { receiptsDir: dir });
  assert.equal(two.pairs, 1); assert.match(two.items[0].reasons[0].reason, /same merchant, total 12\.40 and date 2026-11-01/);
  assert.match(d.note, /Not a finding of wrongdoing/);
});

test('audit queue ranks reports with a reason for every point; weights come from the policy', () => {
  const r = review(rd('expenses.csv'), policy, { receiptsDir });
  const q = auditQueue(r, findDuplicates(rd('expenses.csv'), { history: rd('history.csv'), receiptsDir }));
  assert.deepEqual(q.queue.map((x) => [x.report_id, x.score, x.tier]), [['R-103', 100, 'high'], ['R-104', 100, 'high'], ['R-101', 47, 'medium'], ['R-105', 30, 'medium'], ['R-102', 0, 'low']]);
  const r101 = q.queue.find((x) => x.report_id === 'R-101');
  assert.deepEqual(r101.reasons.map((x) => x.points), [30, 10, 7]); assert.match(r101.reasons[0].reason, /2: possible duplicate of earlier H-090\/1/);
  for (const x of q.queue) if (x.score < 100) assert.equal(x.score, x.reasons.reduce((t, y) => t + y.points, 0), `${x.report_id} score adds up`);
  const q2 = auditQueue(r, null, { disallowed_category: 70 });
  assert.equal(q2.queue.find((x) => x.report_id === 'R-105').tier, 'high');
});

test('policy config schema: typos, wrong types and missing source fail with JSON pointers', async () => {
  assert.ok(validate(POLICY_SCHEMA, policy).ok, 'bundled policy is valid');
  const root = tmpRoot('prax-cfg-'); const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = {
    'unknown-key.json': [{ ...policy, recipt_required_over: 25 }, /\/recipt_required_over is not an allowed property/],
    'wrong-type.json': [{ ...policy, categories: { ...policy.categories, meals: { ...policy.categories.meals, limit: '75' } } }, /\/categories\/meals\/limit expected number, got string/],
    'missing-source.json': [(({ source, ...rest }) => rest)(policy), /\/source is required/],
  };
  for (const [f, [cfg, re]] of Object.entries(bad)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const r = await rt.call('praxidike_review', { expenses: 'expenses.csv', policy: f });
    assert.equal(r.status, 'error', f); assert.match(r.reason, re, f); assert.match(r.reason, /is not a valid policy/);
  }
  // A near miss of a real argument is refused with the right name: running without the receipts folder would skip the receipt checks silently.
  const typo = await rt.call('praxidike_review', { expenses: 'expenses.csv', policy: 'policy.json', receipt: 'receipts' });
  assert.equal(typo.status, 'error'); assert.match(typo.reason, /\/receipt is not an argument of praxidike_review \(did you mean "receipts"\?\)/);
  // An unrelated extra argument from an older host still runs, and the result says it was ignored.
  const extra = await rt.call('praxidike_review', { expenses: 'expenses.csv', policy: 'policy.json', client_trace_id: 'abc' });
  assert.equal(extra.status, 'executed'); assert.match(extra.warnings[0], /"client_trace_id" is not an argument of praxidike_review and was ignored/);
});

test('evidence pack: hashed inputs, self-contained HTML, output_sha256 in the audit log', async () => {
  const root = tmpRoot('prax-ev-'); const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('praxidike_write_evidence_pack', { expenses: 'expenses.csv', policy: 'policy.json', receipts: 'receipts', history: 'history.csv' });
  assert.equal(r.status, 'executed', r.reason);
  const m = JSON.parse(readFileSync(join(root, r.result.manifest), 'utf8'));
  assert.equal(sha256(readFileSync(join(root, r.result.manifest), 'utf8')), r.result.output_sha256);
  assert.equal(m.inputs['expenses.csv'], sha256(readFileSync(join(root, 'expenses.csv'), 'utf8')));
  assert.ok(m.inputs['receipts/r101-hotel.txt'] && m.inputs['history.csv']); assert.equal(m.duplicate_pairs, 4);
  const html = readFileSync(r.result.files[0], 'utf8');
  assert.match(html, /default-src 'none'/); assert.ok(!/<script/i.test(html)); assert.ok(!html.includes('Room 214')); assert.ok(!html.includes('4111 1111'));
  assert.match(html, /§3\.1 Meals/); assert.match(html, /Not fraud detection/);
  assert.equal(m.outputs['evidence-pack.html'], sha256(html));
  const q = parseCsv(readFileSync(r.result.files[1], 'utf8')); assert.equal(q[0].report_id, 'R-103'); assert.equal(q[0].reviewer, '');
  const line = readAudit(join(root, '.mythos/audit.jsonl')).find((e) => e.tool === 'praxidike_write_evidence_pack');
  assert.equal(line.output_sha256, r.result.output_sha256);
  const again = await rt.call('praxidike_write_evidence_pack', { expenses: 'expenses.csv', policy: 'policy.json', receipts: 'receipts', history: 'history.csv', out_dir: 'mythos-out/ev2' });
  assert.equal(again.result.output_sha256, r.result.output_sha256, 'deterministic');
});

test('new tools are read/report only; reimbursing still one-click with per diem lines', async () => {
  const rt = new AgentRuntime(manifest, { root: tmpRoot('prax-pd-'), mode: 'auto', autoActions: ['praxidike_stage_reimbursement'] });
  const byName = Object.fromEntries(rt.listTools().map((t) => [t.name, t]));
  for (const t of ['praxidike_read_receipts', 'praxidike_find_duplicates', 'praxidike_audit_queue', 'praxidike_write_evidence_pack']) { assert.equal(byName[t].decision, 'allow'); assert.ok(['read', 'report'].includes(byName[t].kind)); }
  const s = await rt.call('praxidike_stage_reimbursement', { expenses: 'expenses-travel.csv', policy: 'policy.json', out_dir: 'mythos-out/pd' });
  assert.equal(s.result.total, 324);
  const args = { batch: s.result.batch, batch_sha256: s.result.batch_sha256, out_dir: 'mythos-out/pd' };
  const a = await rt.call('praxidike_request_reimbursement', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(rt.root, '.mythos')).approve(a.approval_id, 'Kim');
  assert.equal((await rt.call('praxidike_request_reimbursement', args)).status, 'executed');
});

test('MCP prompt walks the workflow and keeps money movement with a person', async () => {
  const p = manifest.prompts.find((x) => x.name === 'review_expense_reports');
  assert.ok(p); assert.deepEqual(p.arguments.filter((x) => x.required).map((x) => x.name), ['expenses', 'policy']);
  for (const t of ['praxidike_review', 'praxidike_find_duplicates', 'praxidike_audit_queue', 'praxidike_write_evidence_pack', 'praxidike_stage_reimbursement', 'praxidike_request_reimbursement']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /Never approve on their behalf/); assert.match(p.text, /\{\{expenses\}\}/);
  const { createMcpHandler } = await import('mythos-agent-core');
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'review_expense_reports', arguments: { expenses: 'e.csv', policy: 'p.json' } } });
  assert.match(got.result.messages[0].content.text, /expenses "e\.csv"/);
});

test('receipts from Japan, Korea, China, Brazil, France and Italy: yen and won without decimals, local labels and dates', () => {
  const want = {
    's6-ja-yen.txt': ['架空マート 新宿店', 1210, '2026-11-14', 'JPY', 1100, 110],
    's7-ja-halfwidth.txt': ['カフェ サンプル', 1500, '2026-11-03', 'JPY', null, 136],
    's8-ko-won.txt': ['가상식당 강남점', 22000, '2026-11-14', 'KRW', 20000, 2000],
    's9-zh-yuan.txt': ['虚构咖啡馆', 58, '2026-11-14', 'CNY', 52, null],
    's10-br-reais.txt': ['Padaria Exemplo', 19.8, '2026-11-03', 'BRL', 18, null],
    's11-fr-ttc.txt': ['Brasserie Fictive', 24, '2026-11-03', 'EUR', 20, 4],
    's12-it-month.txt': ['Bar Esempio', 7.5, '2026-11-14', 'EUR', null, 1.35],
  };
  for (const [f, w] of Object.entries(want)) {
    const r = style(f);
    assert.deepEqual([r.merchant, r.total, r.date, r.currency, r.subtotal, r.tax], w, f);
  }
  assert.deepEqual(style('s11-fr-ttc.txt').amounts, [24], 'Sous-total is not a total');
  assert.deepEqual(style('s6-ja-yen.txt').amounts, [1210], 'お預り (cash handed over) and 3点 (item count) are not totals');
  assert.equal(normalizeReceipt('Shop\nTotal 3 items\nTotal 12.00').total, 12, 'English receipts still need two decimals');
});
