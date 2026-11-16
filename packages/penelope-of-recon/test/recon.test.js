import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
async function oneClick(manifest, tool, args, root) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [tool] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call(tool, args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  const again = await rt.call(tool, args); assert.equal(again.status, 'needs_approval', 'approval is single-use');
  return b;
}

import { manifest, normBank, normGL, reconcile, workpaperCsv, WORKPAPER_COLUMNS } from '../src/index.js';

test('debit/credit columns and sign conventions', () => {
  const b = normBank([{ Date: '2026-10-01', Description: 'x', Withdrawal: '100', Deposit: '' }]);
  const g = normGL([{ date: '2026-10-01', memo: 'x', debit: '', credit: '100' }]);
  assert.equal(b[0].amount, -100); assert.equal(g[0].amount, -100);
  assert.equal(reconcile(b, g).matched_groups, 1);
});
test('ambiguous amount picks nearest date with low confidence', () => {
  const b = normBank([{ date: '2026-10-10', description: 'ach', amount: '50' }]);
  const g = normGL([{ date: '2026-10-08', memo: 'a', amount: '50' }, { date: '2026-10-11', memo: 'b', amount: '50' }]);
  const r = reconcile(b, g); assert.equal(r.matches[0].confidence, 'low'); assert.deepEqual(r.matches[0].gl, ['G3']);
});
test('group match up to max_group and tolerance', () => {
  const b = normBank([{ date: '2026-10-10', description: 'batch', amount: '60.01' }]);
  const g = normGL([{ date: '2026-10-10', memo: 'a', amount: '10' }, { date: '2026-10-10', memo: 'b', amount: '20' }, { date: '2026-10-10', memo: 'c', amount: '30' }]);
  assert.equal(reconcile(b, g).matched_groups, 0);
  assert.equal(reconcile(b, g, { amount_tolerance: 0.01 }).matches[0].gl.length, 3);
  assert.equal(reconcile(b, g, { amount_tolerance: 0.01, max_group: 2 }).matched_groups, 0);
});
test('fees and interest get proposed entries; unknown bank items do not', () => {
  const r = reconcile(normBank([{ date: '2026-10-31', description: 'Wire fee', amount: '-15' }, { date: '2026-10-31', description: 'Mystery', amount: '-9' }]), []);
  assert.equal(r.bank_only[0].adjusting_entry.account, 'Bank fees expense'); assert.equal(r.bank_only[1].adjusting_entry, null);
});
test('workpaper has blank reviewer columns', () => {
  const b = normBank(parseCsv(readFileSync(join(fixtures, 'bank-statement.csv'), 'utf8'))); const g = normGL(parseCsv(readFileSync(join(fixtures, 'gl-cash.csv'), 'utf8')));
  const rows = parseCsv(workpaperCsv(reconcile(b, g), b, g));
  assert.deepEqual(Object.keys(rows[0]), WORKPAPER_COLUMNS); assert.equal(rows.length, 9); assert.ok(rows.every((x) => x.reviewer_decision === ''));
});
test('adjusting entry is one-click even in Auto; ledger posting blocked', async () => {
  const root = tmpRoot('pen-');
  const b = await oneClick(manifest, 'penelope_request_adjusting_entry', { date: '2026-10-31', amount: -25, account: 'Bank fees expense', memo: 'fee' }, root);
  assert.match(readFileSync(b.result.file, 'utf8'), /Bank fees expense/);
  assert.equal((await new AgentRuntime(manifest, { root, mode: 'auto' }).call('ledger_post_journal', {})).status, 'blocked');
});

test('scale: 5,000 bank and 5,000 GL lines over one month reconcile in seconds, not minutes', async () => {
  const { reconcile } = await import('../src/recon.js');
  const line = (side, i) => ({ side, id: `${side[0].toUpperCase()}${i + 2}`, row: i + 2, date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, description: 'fictional', reference: i % 3 ? `R${i}` : '', amount: ((i % 97) + 1) * 10 });
  const bank = Array.from({ length: 5000 }, (_, i) => line('bank', i)), gl = Array.from({ length: 5000 }, (_, i) => line('gl', i));
  const t0 = Date.now(); const r = reconcile(bank, gl, {});
  assert.equal(r.matched_groups, 5000); assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
});

test('a huge or odd date window does not hang', async () => {
  const { reconcile } = await import('../src/recon.js');
  const bank = [{ id: 'B1', date: '2026-10-01', amount: -50, reference: '' }, { id: 'B2', date: '2026-10-09', amount: -20, reference: '' }];
  const gl = [{ id: 'G1', date: '2026-10-08', amount: -50, reference: '' }, { id: 'G2', date: '2026-09-01', amount: -20, reference: '' }];
  for (const date_window of [1e15, Infinity, -3, NaN]) {
    const t = Date.now(); const r = reconcile(bank, gl, { date_window });
    assert.ok(Date.now() - t < 2000);
    assert.equal(r.matches.length, date_window > 0 ? 2 : 0);
  }
});
