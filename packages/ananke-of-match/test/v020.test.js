import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, sha256, validate } from 'mythos-agent-core';
import { manifest, normPOs, normReceipts, normInvoices, match, poStatus, normInvoiceNo, toleranceFor, TOLERANCE_SCHEMA, PO_STATUS_COLUMNS } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const csv = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const MAIN = { pos: 'pos.csv', receipts: 'receipts.csv', invoices: 'invoices.csv' };
const PART = { pos: 'partial-pos.csv', receipts: 'partial-receipts.csv', invoices: 'partial-invoices.csv' };
const rt = (root = fixtures, o = {}) => new AgentRuntime(manifest, { root, audit: false, ...o });

test('two receipts and three invoices on one PO line match, with FIFO receipt allocation', () => {
  const pos = normPOs(csv('partial-pos.csv')), rc = normReceipts(csv('partial-receipts.csv'));
  const r = match(pos, rc, normInvoices(csv('partial-invoices.csv')));
  const by = Object.fromEntries(r.items.map((i) => [i.invoice, i]));
  for (const id of ['INV-3001', 'INV-3002', 'INV-3003']) assert.equal(by[id].status, 'matched', id);
  assert.deepEqual(by['INV-3001'].receipts, ['GRN-951']);
  assert.deepEqual(by['INV-3002'].receipts, ['GRN-958']);
  assert.deepEqual(by['INV-3003'].receipts, ['GRN-958']);
  assert.equal(by['INV-3004'].status, 'matched_with_notes');
  // A fourth real invoice on the closed line is over-billing.
  const more = match(pos, rc, normInvoices([...csv('partial-invoices.csv'), { invoice: 'INV-3009', vendor: 'Wayne Paper Co (fictional)', po: 'PO-5001', line: '1', qty: '5', unit_price: '8', date: '2026-11-20' }]));
  const last = more.items.at(-1); assert.ok(last.exceptions.some((e) => e.code === 'qty_over_received')); assert.equal(last.est_impact, 40);
});

test('a receipt split across two invoices is listed on both', () => {
  const pos = normPOs([{ po: 'P', line: '1', vendor: 'V', qty: '10', unit_price: '1' }]);
  const rc = normReceipts([{ receipt: 'G1', po: 'P', line: '1', qty: '6', date: '2026-11-01' }, { receipt: 'G2', po: 'P', line: '1', qty: '4', date: '2026-11-02' }]);
  const r = match(pos, rc, normInvoices([{ invoice: 'A', vendor: 'V', po: 'P', line: '1', qty: '3', unit_price: '1' }, { invoice: 'B', vendor: 'V', po: 'P', line: '1', qty: '7', unit_price: '1' }]));
  assert.deepEqual(r.items[0].receipts, ['G1']); assert.deepEqual(r.items[1].receipts, ['G1', 'G2']);
});

test('near-duplicate invoice numbers are held and not counted as billing', () => {
  assert.equal(normInvoiceNo('inv-03003'), normInvoiceNo('INV3003'));
  const r = match(normPOs(csv('partial-pos.csv')), normReceipts(csv('partial-receipts.csv')), normInvoices(csv('partial-invoices.csv')));
  const nd = r.items.find((i) => i.invoice === 'INV3003');
  assert.deepEqual(nd.exceptions.map((e) => e.code), ['near_duplicate_invoice']); assert.equal(nd.est_impact, 200);
  // One-character difference only counts with the same date and amount.
  const pos = normPOs([{ po: 'P', line: '1', vendor: 'V', qty: '10', unit_price: '1' }]); const rc = normReceipts([{ po: 'P', line: '1', qty: '10', date: '2026-11-01' }]);
  const same = match(pos, rc, normInvoices([{ invoice: 'INV-100', vendor: 'V', po: 'P', qty: '2', unit_price: '1', date: '2026-11-03' }, { invoice: 'INV-108', vendor: 'V', po: 'P', qty: '2', unit_price: '1', date: '2026-11-03' }]));
  assert.ok(same.items[1].exceptions.some((e) => e.code === 'near_duplicate_invoice'));
  const monthly = match(pos, rc, normInvoices([{ invoice: 'INV-100', vendor: 'V', po: 'P', qty: '2', unit_price: '1', date: '2026-11-03' }, { invoice: 'INV-108', vendor: 'V', po: 'P', qty: '2', unit_price: '1', date: '2026-12-03' }]));
  assert.equal(monthly.items[1].status, 'matched');
});

test('a vendor-specific price tolerance changes the exception set', async () => {
  const base = await rt().call('ananke_match', MAIN);
  const prof = await rt().call('ananke_match', { ...MAIN, tolerance_profile: 'tolerances.json' });
  assert.equal(prof.status, 'executed', prof.reason);
  assert.ok(base.result.by_code.price_variance); assert.ok(!prof.result.by_code.price_variance);
  assert.equal(prof.result.exceptions, base.result.exceptions - 1);
  const inv = prof.result.items.find((i) => i.invoice === 'INV-2003'); assert.equal(inv.tolerance.price_pct, 10); assert.equal(inv.tolerance.source, 'vendor profile');
  // The vendor entry wins over a tighter run-level argument; other vendors use the argument.
  const t = toleranceFor('globex furniture (FICTIONAL)', { price_pct: 1 }, { vendors: { 'Globex Furniture (fictional)': { price_pct: 10 } } });
  assert.equal(t.price_pct, 10);
  assert.equal(toleranceFor('Other', { price_pct: 1 }, { default: { price_pct: 5 }, vendors: {} }).price_pct, 1);
  assert.equal(toleranceFor('Other', {}, { default: { price_pct: 5 }, vendors: {} }).price_pct, 5);
});

test('tolerance profile schema: three mutated configs fail with JSON-pointer errors', async () => {
  const good = JSON.parse(readFileSync(join(fixtures, 'tolerances.json'), 'utf8'));
  assert.ok(validate(TOLERANCE_SCHEMA, good).ok);
  const root = tmpRoot('ananke-cfg-');
  const cases = [
    ['unknown-key', { ...good, vendors: { 'Globex Furniture (fictional)': { price_pct: 10, price_pc: 3 } } }, /\/vendors\/Globex Furniture \(fictional\)\/price_pc/],
    ['wrong-type', { ...good, default: { price_pct: '2%' } }, /\/default\/price_pct/],
    ['missing-required', { default: good.default }, /\/vendors/],
  ];
  for (const [name, cfg, re] of cases) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(cfg));
    const r = await rt(root).call('ananke_match', { ...MAIN, tolerance_profile: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason + JSON.stringify(r.errors || []), re, name);
  }
});

test('PO status: GRNI, billed-not-received and a PO filter', async () => {
  const s = poStatus(normPOs(csv('partial-pos.csv')), normReceipts(csv('partial-receipts.csv')), match(normPOs(csv('partial-pos.csv')), normReceipts(csv('partial-receipts.csv')), normInvoices(csv('partial-invoices.csv'))));
  assert.deepEqual(s.lines.map((l) => l.status), ['closed', 'received_not_billed']);
  assert.equal(s.lines[0].billed, 100, 'near-duplicate excluded from billed'); assert.equal(s.grni_value_total, 90);
  const m = await rt().call('ananke_po_status', { ...MAIN, po: 'po-4473' });
  assert.equal(m.result.lines.length, 1); assert.equal(m.result.lines[0].status, 'billed_more_than_received'); assert.equal(m.result.lines[0].billed_not_received_value, 7000);
  assert.equal((await rt().call('ananke_po_status', { ...MAIN, po: 'PO-0000' })).status, 'error');
});

test('HTML report and PO status CSV are written; the hash matches the file', async () => {
  const root = tmpRoot('ananke-rep-');
  const r = await rt(root).call('ananke_write_report', { ...PART, out_dir: 'out' });
  assert.equal(r.status, 'executed', r.reason);
  const html = readFileSync(join(root, 'out', 'ap-report.html'), 'utf8');
  assert.equal(r.result.output_sha256, sha256(html));
  assert.match(html, /Content-Security-Policy/); assert.ok(!/<script/i.test(html));
  assert.match(html, /Vendor scorecard/); assert.match(html, /near_duplicate_invoice/); assert.match(html, /90\.00/);
  const rows = parseCsv(readFileSync(join(root, 'out', 'ap-po-status.csv'), 'utf8')); assert.deepEqual(Object.keys(rows[0]), PO_STATUS_COLUMNS);
  const w = await rt(root).call('ananke_write_worklist', { ...PART, out_dir: 'out' });
  assert.equal(w.result.output_sha256, sha256(readFileSync(join(root, 'out', 'ap-exceptions.csv'), 'utf8')));
});

test('output_sha256 lands in the audit line', async () => {
  const root = tmpRoot('ananke-aud-');
  const r = await new AgentRuntime(manifest, { root }).call('ananke_write_report', { ...MAIN });
  const lines = readFileSync(join(root, '.mythos', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).output_sha256, r.result.output_sha256);
});

test('invalid arguments are refused before any approval; posting stays one-click with new args', async () => {
  const bad = await rt(fixtures, { mode: 'auto' }).call('ananke_request_posting', { invoice: '', vendor: 'V', amount: 5, reason: 'x' });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments/);
  assert.equal((await rt().call('ananke_match', { ...MAIN, price_pct: -1 })).status, 'error');
  const root = tmpRoot('ananke-oc-'); const r2 = new AgentRuntime(manifest, { root, mode: 'auto' });
  const args = { invoice: 'INV-3001', vendor: 'Wayne Paper Co (fictional)', amount: 320, reason: 'matched, partial fixture' };
  const a = await r2.call('ananke_request_posting', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin');
  assert.equal((await r2.call('ananke_request_posting', args)).approved_by, 'Robin');
  assert.equal((await r2.call('ananke_request_posting', args)).status, 'needs_approval');
});

test('manifest ships an MCP prompt and the tolerances config schema', () => {
  const p = manifest.prompts.find((x) => x.name === 'ap_exception_review');
  assert.ok(p && /ananke_request_posting/.test(p.text) && /\{\{pos\}\}/.test(p.text));
  assert.ok(manifest.configSchemas.tolerances);
  for (const t of manifest.tools) if (t.kind === 'write' || t.kind === 'action') assert.notEqual(manifest.policy.rules.find((r) => r.tool === t.name).decision, 'allow');
});
