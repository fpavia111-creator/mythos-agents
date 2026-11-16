import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validate, validateIcs, createMcpHandler } from 'mythos-agent-core';
import { manifest, compare, findConversion, countPlan, abcClasses, accuracy, UOM_TABLE_SCHEMA, COUNT_POLICY_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const js = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const uom = js('uom-table.json'); const policy = js('count-policy.json');
const lots = () => compare(rd('counts-lots.csv'), rd('on-hand-lots.csv'), [], { uom_table: uom });
const find = (r, sku, lot = '') => r.items.find((i) => i.sku === sku && (i.lot || '') === lot);

test('lot and serial tracking: variance per lot, lot mix-ups that net to zero, serial checks', () => {
  const r = lots();
  assert.equal(find(r, 'MILK-1', 'L2601').variance_qty, 12); assert.equal(find(r, 'MILK-1', 'L2602').variance_qty, -12);
  for (const l of ['L2601', 'L2602']) { assert.ok(find(r, 'MILK-1', l).flags.includes('lot_mixup')); assert.equal(find(r, 'MILK-1', l).status, 'investigate'); }
  assert.match(find(r, 'MILK-1', 'L2601').notes.join(' '), /net to 0: likely counted or picked under the wrong lot/);
  assert.equal(find(r, 'SEED-9', 'S-1001').status, 'match');
  assert.deepEqual(find(r, 'SEED-9', 'S-1003').flags, ['not_in_system', 'lot_mixup']); assert.equal(find(r, 'SEED-9', 'S-1002').status, 'not_counted');
  assert.deepEqual(find(r, 'TORCH-2', 'T-55').flags, ['serial_qty_over_one'], 'no pack-size guess on a serial item');
  assert.equal(r.lots, 6);
  // Lot variances that do not net to zero are not a mix-up.
  const r2 = compare([{ sku: 'M', location: 'X', lot: 'A', counted_qty: '5' }, { sku: 'M', location: 'X', lot: 'B', counted_qty: '5' }], [{ sku: 'M', location: 'X', lot: 'A', system_qty: '6', unit_cost: '1' }, { sku: 'M', location: 'X', lot: 'B', system_qty: '6', unit_cost: '1' }]);
  assert.ok(r2.items.every((i) => !i.flags.includes('lot_mixup')));
  // Movements are matched per lot.
  const r3 = compare([{ sku: 'M', location: 'X', lot: 'A', counted_qty: '5', counted_at: '2026-11-01T09:00' }], [{ sku: 'M', location: 'X', lot: 'A', system_qty: '8', unit_cost: '1' }], [{ sku: 'M', location: 'X', lot: 'A', qty: '3', posted_at: '2026-11-01T12:00' }, { sku: 'M', location: 'X', lot: 'B', qty: '9', posted_at: '2026-11-01T12:00' }]);
  assert.equal(r3.items[0].status, 'explained_by_timing'); assert.equal(r3.items[0].moved_after_count, 3);
});

test('unit-of-measure table: counts converted, case-vs-each errors explained with the factor', () => {
  const r = lots();
  const g = find(r, 'GLUE-1'); assert.equal(g.status, 'match'); assert.equal(g.counted_qty, 24); assert.equal(g.counted_in_count_uom, 2);
  assert.match(g.notes[0], /Counted 2 CS × 12 = 24 EA \(conversion table for GLUE-1: 1 CS = 12 EA\)/);
  const c = find(r, 'CORD-3'); assert.ok(c.flags.includes('possible_uom_error')); assert.equal(c.uom_factor, 10);
  assert.match(c.notes[0], /factor of 10, the CS→EA factor for CORD-3 in your conversion table: likely counted in CS but entered as EA \(5 × 10 = 50/);
  assert.equal(findConversion(uom, 'X', 'EA', 'PK').factor, 1 / 6, 'generic row used in reverse');
  assert.equal(findConversion(uom, 'GLUE-1', 'PK', 'EA').factor, 6);
  assert.equal(findConversion(uom, 'GLUE-1', 'BX', 'EA'), null);
  const none = compare([{ sku: 'A', location: 'L', counted_qty: '2', uom: 'BX' }], [{ sku: 'A', location: 'L', system_qty: '24', unit_cost: '1', uom: 'EA' }], [], { uom_table: uom });
  assert.deepEqual(none.items[0].flags, ['uom_mismatch']); assert.match(none.items[0].notes[0], /conversion table has no factor/);
  const rc = compare([{ sku: 'A', location: 'L', counted_qty: '1', recount_qty: '2', uom: 'PK' }], [{ sku: 'A', location: 'L', system_qty: '12', unit_cost: '1', uom: 'EA' }], [], { uom_table: uom });
  assert.equal(rc.items[0].recount_qty, 12); assert.equal(rc.items[0].status, 'match', 'recount converted too');
});

test('ABC count plan: A items counted more often, deterministic, blind sheets and a valid .ics', async () => {
  const abc = abcClasses(rd('on-hand.csv'), policy);
  assert.deepEqual(abc.map((x) => `${x.sku}:${x.class}`), ['LAMP-3:A', 'SAW-7:A', 'OIL-5:A', 'WID-100:A', 'WID-200:A', 'GLUE-1:B', 'BOLT-12:B', 'DOWEL-8:C', 'CLAMP-4:C']);
  const p = countPlan(rd('on-hand.csv'), policy);
  const n = (sku) => p.lines.filter((l) => l.sku === sku).length;
  assert.deepEqual([n('LAMP-3'), n('GLUE-1'), n('DOWEL-8')], [6, 2, 1]); assert.ok(n('WID-200') > n('BOLT-12') && n('BOLT-12') >= n('CLAMP-4'));
  assert.equal(p.count_lines, 36); assert.equal(p.max_lines_per_day, 3); assert.equal(p.start_date, '2027-01-04');
  assert.ok(p.lines.every((l) => ![0, 6].includes(new Date(l.date + 'T00:00:00Z').getUTCDay())), 'weekdays only');
  const lamp = p.lines.filter((l) => l.sku === 'LAMP-3').map((l) => l.date); assert.equal(new Set(lamp).size, 6, 'spread over different days');
  assert.deepEqual(countPlan(rd('on-hand.csv'), policy), p, 'deterministic');
  const quarterly = countPlan(rd('on-hand.csv'), { ...policy, classes: [{ class: 'A', cumulative_share: 0.8, counts_per_year: 52 }, { class: 'B', cumulative_share: 1, counts_per_year: 4 }] });
  assert.equal(quarterly.lines.filter((l) => l.sku === 'LAMP-3').length, 26);
  const root = tmpRoot('hesp-plan-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: 'count-policy.json' });
  assert.equal(r.status, 'executed', r.reason);
  const sheet = readFileSync(r.result.files[1], 'utf8'); assert.ok(!sheet.split('\n')[0].includes('system_qty'), 'blind count sheet'); assert.equal(parseCsv(sheet).length, 36);
  const ics = readFileSync(r.result.files[2], 'utf8'); const v = validateIcs(ics); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, p.per_day.length);
  writeFileSync(join(root, 'open.json'), JSON.stringify({ ...policy, blind: false }));
  const open = await new AgentRuntime(manifest, { root, audit: false }).call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: 'open.json', out_dir: 'mythos-out/open' });
  assert.equal(parseCsv(readFileSync(open.result.files[1], 'utf8')).find((x) => x.sku === 'LAMP-3').system_qty, '40');
});

test('accuracy by class, counter and location, with change since the last count', async () => {
  const r = compare(rd('counts.csv'), rd('on-hand.csv'), rd('transactions.csv'), { snapshot_at: '2026-11-13' });
  const a = accuracy(r);
  assert.deepEqual([a.overall.lines, a.overall.hits, a.overall.ira_pct], [8, 3, 37.5]); assert.equal(a.not_scored, 2);
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const out = await rt.call('hesperides_accuracy', { counts: 'counts.csv', on_hand: 'on-hand.csv', transactions: 'transactions.csv', snapshot_at: '2026-11-13', count_policy: 'count-policy.json', previous_counts: 'counts-prev.csv', previous_on_hand: 'on-hand.csv' });
  assert.equal(out.status, 'executed', out.reason);
  const A = out.result.by_class.find((x) => x.key === 'A');
  assert.ok(A.misses.includes('WID-200@A-02'), 'class A tolerance (1%) is tighter than the default 2%');
  assert.equal(out.result.overall.ira_pct, 25); assert.equal(out.result.previous.ira_pct, 62.5); assert.equal(out.result.change.ira_pct, -37.5);
  assert.deepEqual(out.result.by_counter.map((x) => x.key), ['Lee', 'Mo']);
  const half = await rt.call('hesperides_accuracy', { counts: 'counts.csv', on_hand: 'on-hand.csv', previous_counts: 'counts-prev.csv' });
  assert.match(half.reason, /go together/);
});

test('config schemas: unknown key, wrong type and missing field fail with JSON pointers', async () => {
  assert.ok(validate(UOM_TABLE_SCHEMA, uom).ok); assert.ok(validate(COUNT_POLICY_SCHEMA, policy).ok);
  const root = tmpRoot('hesp-cfg-'); const rt = new AgentRuntime(manifest, { root, audit: false });
  const uomBad = {
    'u1.json': [{ ...uom, conversions: [{ ...uom.conversions[0], facter: 12 }] }, /\/conversions\/0\/facter is not an allowed property/],
    'u2.json': [{ conversions: [{ from: 'CS', to: 'EA', factor: '12' }] }, /\/conversions\/0\/factor expected number, got string/],
    'u3.json': [{ source: 'x' }, /\/conversions is required/],
  };
  for (const [f, [cfg, re]] of Object.entries(uomBad)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const r = await rt.call('hesperides_compare', { counts: 'counts-lots.csv', on_hand: 'on-hand-lots.csv', uom_table: f });
    assert.equal(r.status, 'error', f); assert.match(r.reason, re); assert.match(r.reason, /is not a valid uom_table/);
  }
  const polBad = {
    'p1.json': [{ ...policy, week: 26 }, /\/week is not an allowed property/],
    'p2.json': [{ ...policy, weeks: '26' }, /\/weeks expected integer, got string/],
    'p3.json': [(({ start_date, ...rest }) => rest)(policy), /\/start_date is required/],
  };
  for (const [f, [cfg, re]] of Object.entries(polBad)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const r = await rt.call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: f });
    assert.equal(r.status, 'error', f); assert.match(r.reason, re); assert.match(r.reason, /is not a valid count_policy/);
  }
  writeFileSync(join(root, 'broken.json'), '{ nope');
  assert.match((await rt.call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: 'broken.json' })).reason, /count_policy broken\.json is not valid JSON/);
  assert.match((await rt.call('hesperides_count_plan', { on_hand: 'on-hand.csv', count_policy: 'missing.json' })).reason, /count_policy not found/);
});

test('blind recount sheet; lot adjustments need lot reason codes; posting stays one-click', async () => {
  const root = tmpRoot('hesp-lot-');
  const w = await new AgentRuntime(manifest, { root, audit: false }).call('hesperides_write_report', { counts: 'counts.csv', on_hand: 'on-hand.csv', transactions: 'transactions.csv', snapshot_at: '2026-11-13' });
  const rec = parseCsv(readFileSync(w.result.files[2], 'utf8'));
  assert.deepEqual(rec.map((x) => x.sku).sort(), ['BOLT-12', 'CLAMP-4', 'GLUE-1', 'LAMP-3']); assert.ok(!('system_qty' in rec[0]) && !('counted_qty' in rec[0]), 'blind');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['hesperides_draft_adjustments'] });
  const f = { counts: 'counts-lots.csv', on_hand: 'on-hand-lots.csv', uom_table: 'uom-table.json', tolerance_units: 1, out_dir: 'mythos-out/lots' };
  const counts = rd('counts-lots.csv'); counts[0].counted_qty = '41'; counts[1].counted_qty = '60';
  writeFileSync(join(root, 'counts-lots.csv'), ['sku,location,lot,serial,counted_qty,recount_qty,uom,counter,counted_at', ...counts.map((c) => Object.values(c).join(','))].join('\n') + '\n');
  const d = await rt.call('hesperides_draft_adjustments', { ...f, reasons: { 'MILK-1@F-01#L2601': 'COUNT-CORR' } });
  assert.equal(d.status, 'executed', d.reason);
  const rows = parseCsv(readFileSync(join(root, 'mythos-out/lots/adjustments-draft.csv'), 'utf8'));
  assert.deepEqual(rows.map((x) => [x.sku, x.lot, x.adjust_qty, x.reason_code]), [['MILK-1', 'L2601', '1', 'COUNT-CORR']]);
  const args = { batch: d.result.batch, batch_sha256: d.result.batch_sha256, out_dir: 'mythos-out/lots' };
  const a = await rt.call('hesperides_request_post', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Ria');
  const ok = await rt.call('hesperides_request_post', args); assert.equal(ok.status, 'executed');
  assert.equal(parseCsv(readFileSync(ok.result.file, 'utf8'))[0].lot, 'L2601');
  const tools = Object.fromEntries(rt.listTools().map((t) => [t.name, t]));
  for (const t of ['hesperides_count_plan', 'hesperides_accuracy']) { assert.equal(tools[t].decision, 'allow'); assert.ok(['read', 'report'].includes(tools[t].kind)); }
  assert.equal(tools.hesperides_request_post.decision, 'ask'); assert.equal(tools.erp_post_adjustment.decision, 'block');
});

test('MCP prompt walks the cycle count and leaves posting to a person', async () => {
  const p = manifest.prompts.find((x) => x.name === 'cycle_count_review'); assert.ok(p);
  for (const t of ['hesperides_compare', 'hesperides_write_report', 'hesperides_accuracy', 'hesperides_draft_adjustments', 'hesperides_request_post', 'hesperides_count_plan']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /Never approve on their behalf/); assert.match(p.text, /Never invent reason codes/);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'cycle_count_review', arguments: { counts: 'c.csv', on_hand: 'o.csv' } } });
  assert.match(got.result.messages[0].content.text, /counts "c\.csv", on_hand "o\.csv"/);
});
