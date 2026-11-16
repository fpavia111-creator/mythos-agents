// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Auxo's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const check = async (vendors, payments) => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('auxo_check', { vendors, ...(payments ? { payments } : {}), as_of: '2026-11-14' });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, re) => r.result.items.find((i) => re.test(i.vendor_id));

test('native vendor and payment files are read untouched', async () => { assert.equal((await check('vendors.csv', 'payments.csv')).sources, undefined); });

test('NetSuite vendor search + transaction search: inactive vendors skipped, payments joined by name, bills not counted', async () => {
  const r = await check('exports/netsuite-vendors.csv', 'exports/netsuite-bill-payments.csv');
  assert.deepEqual(r.sources.map((s) => s.profile), ['netsuite_vendors', 'netsuite_transactions']);
  assert.equal(r.result.items.length, 3, 'the inactive vendor is skipped');
  assert.equal(item(r, /Northwind/).paid_reportable_methods, 2600);
  assert.equal(item(r, /Rivera/).paid_reportable_methods, 2400, 'the bill is not counted as a payment');
  assert.equal(item(r, /Rivera/).entity_type, 'individual');
  assert.equal(item(r, /Harbor/).paid_card_or_third_party, 980); assert.equal(item(r, /Harbor/).paid_reportable_methods, 0);
  assert.equal(r.sources[1].dates_read_as, 'month/day/year');
  assert.match(r.sources[0].note, /no W-9 or W-8 tracking columns/, 'the result says what the export cannot show');
  assert.ok(!JSON.stringify(r.result).includes('00-0000101'), 'TINs stay masked');
});

test('QuickBooks Vendor Contact List + Transaction List by Vendor: title block, group rows, totals', async () => {
  const r = await check('exports/quickbooks-vendor-contact-list.csv', 'exports/quickbooks-transaction-list-by-vendor.csv');
  assert.deepEqual(r.sources.map((s) => s.profile), ['qbo_vendor_contact_list', 'qbo_transaction_list_by_vendor']);
  assert.equal(r.sources[0].header_row, 3); assert.equal(r.sources[1].header_row, 4);
  assert.deepEqual(r.sources[1].missing, []);
  assert.equal(item(r, /Northwind/).paid_reportable_methods, 2600);
  assert.equal(item(r, /Rivera/).paid_reportable_methods, 2400);
  assert.equal(item(r, /Harbor/).paid_card_or_third_party, 980);
  assert.equal(r.result.items.filter((i) => i.over_threshold).length, 2);
});

test('Xero contacts export: starred header, address joined', async () => {
  const r = await check('exports/xero-contacts.csv');
  assert.equal(r.sources[0].profile, 'xero_contacts'); assert.equal(r.sources[0].mapped.vendor_id, '*ContactName');
  assert.equal(item(r, /Northwind/).address, '1 Example Way, Duluth, MN, 55802');
  assert.ok(item(r, /Rivera/).flags.includes('w9_missing'));
});
