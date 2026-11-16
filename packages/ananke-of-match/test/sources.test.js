// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Ananke's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const match = async (pos, receipts, invoices) => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('ananke_match', { pos, receipts, invoices });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const NS = ['exports/netsuite-purchase-orders.csv', 'exports/netsuite-item-receipts.csv', 'exports/netsuite-vendor-bills.csv'];

test('native files are read untouched', async () => { assert.equal((await match('pos.csv', 'receipts.csv', 'invoices.csv')).sources, undefined); });

test('NetSuite transaction searches: header-only rows skipped, PO read from "Created From", lines joined by item', async () => {
  const r = await match(...NS);
  assert.deepEqual(r.sources.map((s) => [s.arg, s.profile]), [['pos', 'netsuite_transactions'], ['receipts', 'netsuite_transactions'], ['invoices', 'netsuite_transactions']]);
  assert.equal(r.sources[0].rows, 3, 'the PO summary row with no item is skipped');
  assert.match(r.sources[0].note, /matched by PO number and item code/);
  const by = Object.fromEntries(r.result.items.map((i) => [i.invoice, i]));
  assert.equal(by['INV-2001'].status, 'matched');
  assert.notEqual(by['INV-2002'].status, 'matched', '50 billed against 30 received');
  assert.notEqual(by['INV-2003'].status, 'matched', 'billed at 195 against a PO price of 180');
  assert.equal(by['INV-2001'].po, 'PO-4471');
});

test('the NetSuite files give the same result as the same lines in Ananke\'s own layout', async () => {
  const ns = await match(...NS);
  const own = await match('pos.csv', 'receipts.csv', 'invoices.csv');
  const pick = (r) => r.result.items.slice(0, 3).filter((i) => ['INV-2001', 'INV-2002', 'INV-2003'].includes(i.invoice)).map((i) => [i.invoice, i.status, i.exceptions.map((e) => e.code), i.est_impact]);
  assert.deepEqual(pick(ns), pick(own));
});

test('Xero bills export: starred headers, day-first dates, PO from Reference', async () => {
  const r = await match(NS[0], NS[1], 'exports/xero-bills.csv');
  assert.equal(r.sources[2].profile, 'xero_bills'); assert.equal(r.sources[2].dates_read_as, 'day/month/year');
  assert.equal(r.result.items.find((i) => i.invoice === 'INV-2001').status, 'matched');
  assert.equal(r.result.items.length, 3);
});
