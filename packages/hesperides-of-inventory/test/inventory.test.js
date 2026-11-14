import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, compare, parseTime } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const run = (a = {}) => compare(rd('counts.csv'), rd('on-hand.csv'), rd('transactions.csv'), { snapshot_at: '2026-11-13', ...a });
const by = (r) => Object.fromEntries(r.items.map((i) => [i.sku, i]));

test('statuses and ranking by value', () => {
  const r = run(); const b = by(r);
  assert.deepEqual(r.items.map((i) => i.sku).slice(0, 3), ['SAW-7', 'GLUE-1', 'LAMP-3']);
  assert.equal(b['WID-100'].status, 'match'); assert.equal(b['WID-200'].status, 'within_tolerance'); assert.equal(b['BOLT-12'].status, 'recount_needed');
  assert.equal(b['SAW-7'].status, 'confirmed_by_recount'); assert.equal(b['SAW-7'].variance_value, -252);
  assert.equal(b['DOWEL-8'].status, 'not_counted'); assert.ok(b['TAPE-2'].flags.includes('not_in_system'));
  assert.equal(r.net_variance_value, -511.6); assert.equal(r.abs_variance_value, 799.6);
});
test('timing differences use only movements after the count and up to the snapshot', () => {
  const b = by(run());
  assert.equal(b['OIL-5'].status, 'explained_by_timing'); assert.equal(b['OIL-5'].moved_after_count, 6); assert.match(b['OIL-5'].notes[0], /PO-7781/);
  assert.equal(b['WID-100'].moved_after_count, 0, 'shipment before the count is ignored');
  assert.equal(by(run({ snapshot_at: '2026-11-12T12:00' }))['OIL-5'].status, 'recount_needed', 'receipt after the snapshot does not explain it');
  assert.equal(parseTime('2026-11-12T09:30'), Date.UTC(2026, 10, 12, 9, 30)); assert.throws(() => run({ snapshot_at: 'soon' }), /snapshot_at/);
});
test('investigation flags: pack-size factor, recount differs, negative stock, UOM mismatch', () => {
  const b = by(run());
  assert.ok(b['GLUE-1'].flags.includes('possible_uom_error')); assert.match(b['GLUE-1'].notes[0], /factor of 12/);
  assert.ok(b['LAMP-3'].flags.includes('recount_differs')); assert.equal(b['LAMP-3'].variance_qty, -6, 'recount is the final count');
  assert.ok(b['CLAMP-4'].flags.includes('negative_system_qty')); assert.equal(b['CLAMP-4'].status, 'investigate');
  const u = compare([{ sku: 'A', location: 'L', counted_qty: '2', uom: 'CS' }], [{ sku: 'A', location: 'L', system_qty: '24', unit_cost: '1', uom: 'EA' }]);
  assert.deepEqual(u.items[0].flags, ['uom_mismatch']);
});
test('tolerance and threshold settings', () => {
  assert.equal(by(run({ tolerance_pct: 0.1 }))['BOLT-12'].status, 'within_tolerance');
  assert.equal(by(run({ value_threshold: 5 }))['WID-200'].status, 'recount_needed');
  assert.equal(run({ locations: ['A-01'] }).not_counted, 0);
});
test('drafts on Auto; posting is one-click, needs reason codes, hash-bound; ERP blocked', async () => {
  const root = tmpRoot('hesp-'); const f = { counts: 'counts.csv', on_hand: 'on-hand.csv', transactions: 'transactions.csv', snapshot_at: '2026-11-13' };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['hesperides_draft_adjustments'] });
  const d = await rt.call('hesperides_draft_adjustments', f); assert.equal(d.status, 'executed');
  const rows = parseCsv(readFileSync(join(root, 'mythos-out/hesperides/adjustments-draft.csv'), 'utf8'));
  assert.deepEqual(rows.map((x) => [x.sku, x.adjust_qty, x.reason_code]), [['SAW-7', '-6', ''], ['WID-200', '-1', '']]);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['hesperides_request_post'] }), /one-click/);
  const args = { batch: d.result.batch, batch_sha256: d.result.batch_sha256 };
  const a = await rt.call('hesperides_request_post', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Ria');
  const no = await rt.call('hesperides_request_post', args); assert.equal(no.status, 'error'); assert.match(no.reason, /reason code missing for SAW-7@C-01, WID-200@A-02/);
  const d2 = await rt.call('hesperides_draft_adjustments', { ...f, out_dir: 'mythos-out/h2', reasons: { 'SAW-7@C-01': 'DAMAGED', 'WID-200@A-02': 'COUNT-CORR' } });
  const args2 = { batch: d2.result.batch, batch_sha256: d2.result.batch_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('hesperides_request_post', args2)).approval_id, 'Ria');
  const ok = await rt.call('hesperides_request_post', args2); assert.equal(ok.status, 'executed'); assert.equal(ok.approved_by, 'Ria');
  const posted = parseCsv(readFileSync(ok.result.file, 'utf8')); assert.equal(posted.length, 2); assert.equal(posted[0].status, 'approved - a person posts it');
  const d3 = await rt.call('hesperides_draft_adjustments', { ...f, out_dir: 'mythos-out/h3', reasons: { 'SAW-7@C-01': 'X', 'WID-200@A-02': 'Y' } });
  writeFileSync(join(root, 'mythos-out/h3/adjustments-draft.csv'), 'sku,adjust_qty\nSAW-7,-600\n');
  const args3 = { batch: d3.result.batch, batch_sha256: d3.result.batch_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('hesperides_request_post', args3)).approval_id, 'Ria');
  assert.match((await rt.call('hesperides_request_post', args3)).reason, /changed after it was drafted/);
  assert.equal((await rt.call('erp_post_adjustment', {})).status, 'blocked');
});
test('report files', async () => {
  const root = tmpRoot('hesp-r-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('hesperides_write_report', { counts: 'counts.csv', on_hand: 'on-hand.csv' });
  const rows = parseCsv(readFileSync(r.result.files[1], 'utf8')); assert.equal(rows.length, 10); assert.equal(rows[0].reviewer, '');
  assert.match(readFileSync(r.result.files[0], 'utf8'), /Nothing is posted/);
});
