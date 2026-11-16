import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };

import { manifest, normPOs, normReceipts, normInvoices, match, explain, worklistCsv, WORKLIST_COLUMNS, CODES } from '../src/index.js';

const po = [{ po: 'PO-1', line: '1', vendor: 'V', qty: '10', unit_price: '5' }];
const rc = [{ po: 'PO-1', line: '1', qty: '10', date: '2026-11-02' }];
const run = (inv, r = rc, t) => match(normPOs(po), normReceipts(r), normInvoices(inv), t);
const codes = (x) => x.items[0].exceptions.map((e) => e.code);
test('clean match', () => { const r = run([{ invoice: 'I1', vendor: 'V', po: 'PO-1', line: '1', qty: '10', unit_price: '5', date: '2026-11-03' }]); assert.equal(r.matched, 1); });
test('price tolerance: 2% passes at default, 5% fails; abs tolerance', () => {
  assert.equal(run([{ invoice: 'I', vendor: 'V', po: 'PO-1', qty: '10', unit_price: '5.10' }]).matched, 1);
  const r = run([{ invoice: 'I', vendor: 'V', po: 'PO-1', qty: '10', unit_price: '5.25' }]);
  assert.deepEqual(codes(r), ['price_variance']); assert.equal(r.items[0].est_impact, 2.5);
  assert.equal(run([{ invoice: 'I', vendor: 'V', po: 'PO-1', qty: '10', unit_price: '5.25' }], rc, { price_abs: 0.5 }).matched, 1);
});
test('cumulative over-billing across invoices', () => {
  const r = run([{ invoice: 'A', vendor: 'V', po: 'PO-1', qty: '6', unit_price: '5' }, { invoice: 'B', vendor: 'V', po: 'PO-1', qty: '6', unit_price: '5' }]);
  assert.equal(r.items[0].status, 'matched'); assert.ok(r.items[1].exceptions.some((e) => e.code === 'qty_over_received')); assert.equal(r.items[1].est_impact, 10);
});
test('vendor mismatch, before-receipt note, missing data', () => {
  assert.ok(codes(run([{ invoice: 'I', vendor: 'Other', po: 'PO-1', qty: '10', unit_price: '5' }])).includes('vendor_mismatch'));
  const n = run([{ invoice: 'I', vendor: 'V', po: 'PO-1', qty: '10', unit_price: '5', date: '2026-11-01' }]);
  assert.equal(n.items[0].status, 'matched_with_notes');
  assert.ok(codes(run([{ invoice: 'I', vendor: 'V', po: 'PO-1', qty: '', unit_price: '5' }])).includes('missing_data'));
});
test('every code has an explanation; worklist has blank owner columns', () => {
  for (const c of CODES) assert.equal(explain({ exceptions: [{ code: c, detail: '' }] })[0].code, c);
  const r = match(normPOs(parseCsv(readFileSync(join(fixtures, 'pos.csv'), 'utf8'))), normReceipts(parseCsv(readFileSync(join(fixtures, 'receipts.csv'), 'utf8'))), normInvoices(parseCsv(readFileSync(join(fixtures, 'invoices.csv'), 'utf8'))));
  const w = parseCsv(worklistCsv(r)); assert.deepEqual(Object.keys(w[0]), WORKLIST_COLUMNS); assert.equal(w[0].invoice, 'INV-2004'); assert.ok(w.every((x) => x.owner === ''));
});
test('posting is one-click even in Auto and never touches an ERP', async () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['ananke_request_posting'] }), /one-click/);
  const root = tmpRoot('ananke-'); const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  assert.equal((await rt.call('erp_post_invoice', {})).status, 'blocked');
  const args = { invoice: 'INV-2001', vendor: 'Acme', amount: 1200, reason: 'matched' };
  const a = await rt.call('ananke_request_posting', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call('ananke_request_posting', args); assert.equal(b.status, 'executed'); assert.match(b.result.summary, /Nothing was posted or paid/);
});

test('the same vendor written two ways (Acme Inc / ACME, Inc.; 株式会社架空商事 / 架空商事(株)) is not a vendor mismatch', () => {
  const p = [{ po: 'PO-J', vendor: '株式会社架空商事', line: '1', item: 'A', qty: '10', unit_price: '5' }, { po: 'PO-E', vendor: 'Acme Inc', line: '1', item: 'A', qty: '10', unit_price: '5' }];
  const rcv = [{ po: 'PO-J', line: '1', qty: '10' }, { po: 'PO-E', line: '1', qty: '10' }];
  const codesOf = (inv) => match(normPOs(p), normReceipts(rcv), normInvoices(inv)).items.flatMap((i) => i.exceptions.map((e) => e.code));
  assert.ok(!codesOf([{ invoice: 'J1', vendor: '架空商事(株)', po: 'PO-J', line: '1', qty: '10', unit_price: '5' }]).includes('vendor_mismatch'));
  assert.ok(!codesOf([{ invoice: 'E1', vendor: 'ACME, Inc.', po: 'PO-E', line: '1', qty: '10', unit_price: '5' }]).includes('vendor_mismatch'));
  assert.ok(codesOf([{ invoice: 'J2', vendor: 'サンプル運輸(株)', po: 'PO-J', line: '1', qty: '10', unit_price: '5' }]).includes('vendor_mismatch'), 'a different vendor still is');
});
