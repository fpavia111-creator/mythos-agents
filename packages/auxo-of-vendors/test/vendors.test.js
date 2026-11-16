import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, check, defaultThreshold, maskTin, tinFormatOk, paymentTotals } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';

test('threshold defaults by payment year', () => {
  assert.deepEqual(defaultThreshold(2025), { threshold: 600, confirmed: true });
  assert.deepEqual(defaultThreshold(2026), { threshold: 2000, confirmed: true });
  assert.equal(defaultThreshold(2027).confirmed, false);
  assert.equal(check([], [], { year: 2027, as_of }).threshold_confirmed, false);
  assert.equal(check([], [], { year: 2027, threshold: 2100, as_of }).threshold_confirmed, true);
});
test('TINs are masked and format-checked, never echoed', () => {
  assert.equal(maskTin('00-0000101'), '•••••0101'); assert.equal(maskTin('12345'), '(not 9 digits)'); assert.equal(maskTin(''), '');
  assert.ok(tinFormatOk('000-00-0104') && tinFormatOk('00-0000101') && tinFormatOk('000000101')); assert.ok(!tinFormatOk('0000-00101'));
  const out = JSON.stringify(check(rd('vendors.csv'), rd('payments.csv'), { as_of }));
  for (const t of ['00-0000101', '000-00-0104', '00-0000106']) assert.ok(!out.includes(t), `${t} leaked`);
});
test('payments split by method and year', () => {
  const t = paymentTotals(rd('payments.csv'), 2026);
  assert.deepEqual(t.get('V6'), { reportable_methods: 0, card_or_third_party: 5000 });
  assert.equal(t.get('V2').reportable_methods, 2500, '2025 payment excluded');
  assert.equal(paymentTotals(rd('payments.csv'), 2025).get('V2').reportable_methods, 800);
});
test('readiness statuses, priorities and request state', () => {
  const r = check(rd('vendors.csv'), rd('payments.csv'), { as_of });
  const by = Object.fromEntries(r.items.map((i) => [i.vendor_id, i]));
  // 0.2.0: fixture TINs are deliberately invalid placeholders, so the new pattern rules move V1 and V4 from ready to fix_details.
  assert.equal(by.V1.status, 'fix_details'); assert.deepEqual(by.V1.flags, ['tin_pattern_invalid']); assert.equal(by.V4.status, 'fix_details'); assert.match(by.V4.notes[0], /ask your preparer/);
  assert.equal(by.V2.status, 'request_w9'); assert.equal(by.V2.priority, 'high'); assert.equal(by.V2.request, 'first_request');
  assert.deepEqual(by.V3.flags, ['w9_unsigned', 'tin_format_invalid']); assert.equal(by.V3.status, 'fix_details');
  assert.equal(by.V5.status, 'ask_preparer'); assert.equal(by.V7.request, 'reminder'); assert.equal(by.V8.request, 'requested_recently');
  assert.ok(by.V6.flags.includes('w9_older_than_3y') && by.V6.flags.includes('llc_classification_missing'));
  assert.equal(by.V5.request, 'first_request', '0.2.0: foreign vendors without a W-8 get a W-8 request');
  assert.equal(r.over_threshold_not_ready, 5); assert.equal(r.items[0].priority, 'high');
  assert.equal(check(rd('vendors.csv'), rd('payments.csv'), { as_of, threshold: 600 }).over_threshold_not_ready, 6);
});
test('drafts on Auto (no TIN in text); send is one-click; IRS filing and email blocked', async () => {
  const root = tmpRoot('auxo-');
  const f = { vendors: 'vendors.csv', payments: 'payments.csv', as_of };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['auxo_draft_requests'] });
  const d = await rt.call('auxo_draft_requests', f); assert.equal(d.status, 'executed');
  const names = readdirSync(join(root, 'mythos-out/auxo/requests')).sort();
  // 0.2.0: V1/V4 (TIN pattern) and V5 (W-8) now also get drafts.
  assert.deepEqual(names, ['V1-northwind-design-llc.md', 'V2-pat-rivera.md', 'V3-blue-fern-cleaning.md', 'V4-oak-iron-inc.md', 'V5-maple-studio-gmbh.md', 'V6-quick-courier-llc.md', 'V7-sunny-catering.md']);
  const rem = readFileSync(join(root, 'mythos-out/auxo/requests/V7-sunny-catering.md'), 'utf8');
  assert.match(rem, /^DRAFT — not sent/); assert.match(rem, /Subject: Reminder:/); assert.match(rem, /do not email your taxpayer identification number/);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['auxo_request_send'] }), /one-click/);
  const args = { vendor_id: 'V2', draft: 'mythos-out/auxo/requests/V2-pat-rivera.md' };
  const a = await rt.call('auxo_request_send', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Jo');
  const b = await rt.call('auxo_request_send', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Jo');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].status, 'approved - a person sends it');
  assert.equal((await rt.call('auxo_request_send', args)).status, 'needs_approval');
  assert.equal((await rt.call('irs_efile', {})).status, 'blocked'); assert.equal((await rt.call('send_email', {})).status, 'blocked');
});
test('tracker CSV has blank follow-up columns and readiness disclaims tax advice', async () => {
  const root = tmpRoot('auxo-t-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('auxo_write_tracker', { vendors: 'vendors.csv', payments: 'payments.csv', as_of });
  const rows = parseCsv(readFileSync(r.result.files[0], 'utf8')); assert.equal(rows.length, 8); assert.equal(rows[0].owner, '');
  assert.match(readFileSync(r.result.files[1], 'utf8'), /Not tax advice and not a filing/);
});

test('duplicate check scales: 5,000 vendors with planted duplicates finish quickly and find them', async () => {
  const { findDuplicates } = await import('../src/vendors.js');
  const SYL = ['ka', 'ver', 'lo', 'mi', 'dra', 'sun', 'tel', 'ox', 'bri', 'na', 'qu', 'zen', 'har', 'pol', 'ris', 'vo', 'jux', 'em', 'fro', 'gru', 'hy', 'ic', 'jen', 'cle'];
  let s = 11; const g = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
  const word = () => { let w = ''; for (let i = 0; i < 3; i++) w += SYL[Math.floor(g() * SYL.length)]; return w; };
  const vendors = [];
  for (let i = 0; i < 5000; i++) vendors.push({ vendor_id: `V${i}`, name: `${word()} ${word()}`, country: 'US', entity_type: 'c-corp', tin: String(100000000 + i * 7), address: `${i} Example Way`, email: `ap${i}@vendor${i}.example` });
  vendors.push({ vendor_id: 'DUP1', name: vendors[10].name + ' Inc', country: 'US', entity_type: 'c-corp', tin: '', address: '', email: '' });
  vendors.push({ vendor_id: 'DUP2', name: 'Other Name', country: 'US', entity_type: 'c-corp', tin: vendors[20].tin, address: '', email: '' });
  const t = Date.now();
  const r = findDuplicates(vendors, [], { year: 2025 });
  assert.ok(Date.now() - t < 20000, `took ${Date.now() - t} ms`);
  assert.ok(r.pairs.some((p) => p.a === 'V10' && p.b === 'DUP1' && p.reasons.includes('similar_name')));
  assert.ok(r.pairs.some((p) => p.a === 'V20' && p.b === 'DUP2' && p.reasons.includes('same_tin')));
});
