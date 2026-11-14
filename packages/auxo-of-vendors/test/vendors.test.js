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
  assert.equal(by.V1.status, 'ready'); assert.equal(by.V4.status, 'ready'); assert.match(by.V4.notes[0], /ask your preparer/);
  assert.equal(by.V2.status, 'request_w9'); assert.equal(by.V2.priority, 'high'); assert.equal(by.V2.request, 'first_request');
  assert.deepEqual(by.V3.flags, ['w9_unsigned', 'tin_format_invalid']); assert.equal(by.V3.status, 'fix_details');
  assert.equal(by.V5.status, 'ask_preparer'); assert.equal(by.V7.request, 'reminder'); assert.equal(by.V8.request, 'requested_recently');
  assert.ok(by.V6.flags.includes('w9_older_than_3y') && by.V6.flags.includes('llc_classification_missing'));
  assert.equal(r.over_threshold_not_ready, 3); assert.equal(r.items[0].priority, 'high');
  assert.equal(check(rd('vendors.csv'), rd('payments.csv'), { as_of, threshold: 600 }).over_threshold_not_ready, 4);
});
test('drafts on Auto (no TIN in text); send is one-click; IRS filing and email blocked', async () => {
  const root = tmpRoot('auxo-');
  const f = { vendors: 'vendors.csv', payments: 'payments.csv', as_of };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['auxo_draft_requests'] });
  const d = await rt.call('auxo_draft_requests', f); assert.equal(d.status, 'executed');
  const names = readdirSync(join(root, 'mythos-out/auxo/requests')).sort();
  assert.deepEqual(names, ['V2-pat-rivera.md', 'V3-blue-fern-cleaning.md', 'V6-quick-courier-llc.md', 'V7-sunny-catering.md']);
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
