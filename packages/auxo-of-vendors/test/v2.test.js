import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, readAudit, createMcpHandler } from 'mythos-agent-core';
import { manifest, check, tinCheck, expectedTin, einPatternOk, ssnPatternOk, itinPatternOk, suggestedW8, w8ValidUntil, readiness1099, findDuplicates } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
// Synthetic numbers built to hit each rule. All are structurally invalid except where a
// test needs a "passes" case; those are assembled at runtime and never written to fixtures.
const digits = (a, b, c) => `${a}${b}${c}`;

test('TIN pattern rules per entity type', () => {
  assert.equal(einPatternOk('000000101'), false, 'EIN prefix 00 is never issued');
  for (const p of ['07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']) assert.equal(einPatternOk(`${p}0000000`), false, p);
  assert.equal(einPatternOk(`${'1'}${'0'}0000000`), true);
  assert.equal(ssnPatternOk('000001234'), false, 'area 000'); assert.equal(ssnPatternOk(digits('666', '01', '1234')), false, 'area 666');
  assert.equal(ssnPatternOk(digits('900', '01', '1234')), false, 'area 9xx'); assert.equal(ssnPatternOk(digits('100', '00', '1234')), false, 'group 00');
  assert.equal(ssnPatternOk(digits('100', '01', '0000')), false, 'serial 0000');
  assert.equal(itinPatternOk(digits('900', '70', '0000')), true); assert.equal(itinPatternOk(digits('900', '69', '0000')), false); assert.equal(itinPatternOk(digits('900', '93', '0000')), false);
  assert.equal(expectedTin('corporation'), 'ein'); assert.equal(expectedTin('individual'), 'person'); assert.equal(expectedTin('llc-s'), 'any'); assert.equal(expectedTin('llc-c'), 'ein');
  assert.deepEqual(tinCheck('000-00-0104', 'corporation').flags, ['tin_pattern_invalid', 'tin_type_mismatch'], 'SSN shape for a corporation, area 000');
  assert.deepEqual(tinCheck('00-0000101', 'llc-s').flags, ['tin_pattern_invalid']);
  assert.deepEqual(tinCheck('111111111', 'llc-s').flags, ['tin_pattern_invalid'], 'repeated digits are a placeholder');
  assert.deepEqual(tinCheck('123456789', 'individual').flags, ['tin_pattern_invalid'], 'sequential placeholder');
  assert.deepEqual(tinCheck(`10-${'0'.repeat(7)}`, 'individual').flags, ['tin_type_mismatch'], 'EIN shape for an individual');
  assert.deepEqual(tinCheck(`10-${'0'.repeat(7)}`, 'sole_proprietor').flags, [], 'sole proprietors may use an EIN');
  assert.deepEqual(tinCheck('12345', 'individual').flags, ['tin_format_invalid']);
});

test('invalid TIN patterns are flagged and never printed in full', async () => {
  const r = check(rd('vendors.csv'), rd('payments.csv'), { as_of });
  const by = Object.fromEntries(r.items.map((i) => [i.vendor_id, i]));
  assert.ok(by.V1.flags.includes('tin_pattern_invalid')); assert.ok(by.V4.flags.includes('tin_type_mismatch')); assert.ok(by.V6.flags.includes('tin_pattern_invalid'));
  assert.equal(by.V1.tin_masked, '•••••0101'); assert.equal(by.V1.tin_kind, 'ein');
  const root = tmpRoot('auxo-tin-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['auxo_draft_requests'] });
  const outs = [await rt.call('auxo_check', { vendors: 'vendors.csv', payments: 'payments.csv', as_of }), await rt.call('auxo_1099_readiness', { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', as_of }), await rt.call('auxo_find_duplicates', { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', as_of }), await rt.call('auxo_write_tracker', { vendors: 'vendors.csv', as_of }), await rt.call('auxo_draft_requests', { vendors: 'vendors.csv', as_of })];
  const files = [...outs.flatMap((o) => o.result.files || []), ...readdirSync(join(root, 'mythos-out/auxo/requests')).map((f) => join(root, 'mythos-out/auxo/requests', f)), join(root, '.mythos/audit.jsonl')];
  const all = JSON.stringify(outs) + files.map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const t of ['00-0000101', '000000101', '000-00-0104', '000000104', '00-0000106', '000000106']) assert.ok(!all.includes(t), `${t} leaked`);
});

test('foreign vendors get the W-8 checklist, not the W-9', () => {
  const r = check(rd('vendors-merged.csv'), rd('payments-merged.csv'), { as_of });
  const by = Object.fromEntries(r.items.map((i) => [i.vendor_id, i]));
  for (const id of ['V5', 'V12']) {
    assert.equal(by[id].form_expected, 'W-8BEN-E'); assert.equal(by[id].status, 'ask_preparer');
    assert.ok(by[id].checklist.every((c) => !/W-9/.test(c.item)), 'no W-9 items'); assert.ok(by[id].checklist.some((c) => /W-8/.test(c.item)));
    assert.ok(!by[id].flags.includes('w9_missing'));
  }
  assert.deepEqual(by.V5.flags, ['foreign_vendor', 'w8_missing']); assert.deepEqual(by.V12.flags, ['foreign_vendor', 'w8_expired']);
  assert.equal(by.V1.form_expected, 'W-9'); assert.ok(by.V1.checklist.some((c) => /W-9/.test(c.item)));
  assert.equal(suggestedW8('individual'), 'W-8BEN'); assert.equal(suggestedW8('company'), 'W-8BEN-E');
  assert.equal(new Date(w8ValidUntil(Date.UTC(2022, 2, 1))).toISOString().slice(0, 10), '2025-12-31');
  const fresh = check([{ vendor_id: 'F', name: 'F', country: 'FR', entity_type: 'individual', w8_received: '2026-02-01', w8_type: 'W-8BEN', w8_signed: 'yes', address: 'x', email: 'f@example.test' }], [], { as_of });
  assert.deepEqual(fresh.items[0].flags, ['foreign_vendor']); assert.equal(fresh.items[0].request, 'none');
  const unsigned = check([{ vendor_id: 'G', name: 'G', country: 'FR', entity_type: 'company', w8_received: '2026-02-01', w8_type: 'W-8BEN', address: 'x', email: 'g@example.test' }], [], { as_of });
  assert.deepEqual(unsigned.items[0].flags, ['foreign_vendor', 'w8_unsigned']); assert.match(unsigned.items[0].notes.join(' '), /W-8BEN-E is the usual form/);
});

test('W-8 request draft asks for the W-8, and the tracker shows the open checklist', async () => {
  const root = tmpRoot('auxo-w8-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['auxo_draft_requests'] });
  await rt.call('auxo_draft_requests', { vendors: 'vendors-merged.csv', as_of });
  const t = readFileSync(join(root, 'mythos-out/auxo/requests/V12-fjord-consulting-as.md'), 'utf8');
  assert.match(t, /^DRAFT — not sent/); assert.match(t, /Subject: W-8 needed/); assert.match(t, /past its usual validity period/); assert.doesNotMatch(t, /Form W-9/);
  const w = await rt.call('auxo_write_tracker', { vendors: 'vendors-merged.csv', as_of });
  const rows = Object.fromEntries(parseCsv(readFileSync(w.result.files[0], 'utf8')).map((x) => [x.vendor_id, x]));
  assert.equal(rows.V12.form_expected, 'W-8BEN-E'); assert.match(rows.V12.checklist_open, /validity period/);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).at(-1).output_sha256, w.result.output_sha256);
});

test('1099 readiness: vendors over the threshold missing data are listed; still no e-file', async () => {
  const x = readiness1099(check(rd('vendors-merged.csv'), rd('payments-merged.csv'), { as_of }), null, rd('payments-merged.csv'));
  assert.deepEqual(x.rows.map((r) => r.vendor_id), ['V4', 'V1', 'V2', 'V7'], 'largest missing first');
  assert.deepEqual(x.rows.find((r) => r.vendor_id === 'V2').missing, ['W-9']);
  assert.equal(x.missing_data, 4); assert.equal(x.ready, 0);
  assert.deepEqual(x.foreign_over_threshold.map((f) => `${f.vendor_id}:${f.flags}`), ['V5:w8_missing', 'V12:w8_expired']);
  assert.deepEqual(x.card_or_app_only.map((c) => c.vendor_id), ['V6']);
  assert.deepEqual(x.payments_without_vendor_record, [{ vendor_id: 'V99', amount: 750 }]);
  const ok = readiness1099(check([{ vendor_id: 'R', name: 'R', entity_type: 'llc-s', tin: `10-${'0'.repeat(7)}`, w9_received: '2026-01-01', w9_signed: 'yes', address: 'x', email: 'r@example.test' }], [{ vendor_id: 'R', date: '2026-02-01', amount: 5000, method: 'ach' }], { as_of }));
  assert.equal(ok.ready, 1); assert.deepEqual(ok.rows[0].missing, []);
  const root = tmpRoot('auxo-1099-');
  const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('auxo_1099_readiness', { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', as_of });
  assert.equal(r.status, 'executed'); assert.match(r.result.summary, /Not a filing; nothing was sent to the IRS/);
  const md = readFileSync(r.result.files[0], 'utf8');
  assert.match(md, /Not tax advice and not a filing: Auxo never e-files/); assert.match(md, /not matched with the IRS/); assert.match(md, /V99: 750.00/);
  assert.equal(parseCsv(readFileSync(r.result.files[1], 'utf8')).length, 4);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).at(-1).output_sha256, r.result.output_sha256);
  assert.equal((await rt.call('irs_efile', { year: 2026 })).status, 'blocked');
  assert.equal((await new AgentRuntime(manifest, { root, audit: false, mode: 'review' }).call('auxo_1099_readiness', { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', as_of })).status, 'executed', 'a report runs in review mode');
});

test('duplicate vendor records, including payments split under the threshold', async () => {
  const d = findDuplicates(rd('vendors-merged.csv'), rd('payments-merged.csv'), { as_of });
  assert.equal(d.pairs.length, 2);
  assert.deepEqual([d.pairs[0].a, d.pairs[0].b, d.pairs[0].split_under_threshold, d.pairs[0].combined_reportable], ['V3', 'V11', true, 2400]);
  assert.deepEqual(d.pairs[1].reasons, ['same_tin', 'similar_name', 'same_address', 'same_email']); assert.equal(d.pairs[1].confidence, 'high');
  assert.equal(findDuplicates(rd('vendors.csv'), [], { as_of }).pairs.length, 0, 'no false pairs on the base fixture');
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('auxo_find_duplicates', { vendors: 'vendors-merged.csv', payments: 'payments-merged.csv', as_of, name_threshold: 0.99 });
  assert.equal(r.result.pairs.length, 1, 'stricter name threshold keeps only the same-TIN pair');
  const bad = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('auxo_find_duplicates', { vendors: 'vendors.csv', name_threshold: 2 });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /\/name_threshold must be <= 1/);
});

test('send stays one-click for W-8 requests too (different args per approval)', async () => {
  const root = tmpRoot('auxo-send-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['auxo_draft_requests'] });
  await rt.call('auxo_draft_requests', { vendors: 'vendors-merged.csv', as_of });
  const args = { vendor_id: 'V12', draft: 'mythos-out/auxo/requests/V12-fjord-consulting-as.md' };
  const a = await rt.call('auxo_request_send', args); assert.equal(a.status, 'needs_approval'); assert.match(a.reason, /binding_send stays one-click/);
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin');
  const b = await rt.call('auxo_request_send', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Robin');
});

test('MCP prompt walks the workflow, keeps TINs masked and names the human step', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  const g = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'auxo_year_end_readiness', arguments: { vendors: 'v.csv', payments: 'p.csv' } } });
  const text = g.result.messages[0].content.text;
  for (const s of ['v.csv', 'p.csv', 'auxo_check', 'auxo_find_duplicates', 'auxo_1099_readiness', 'auxo_request_send', 'never print a full TIN', 'not tax advice', 'never files']) assert.ok(text.includes(s), s);
  assert.equal((await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'auxo_year_end_readiness', arguments: { vendors: 'v.csv' } } })).error.code, -32602);
});
