// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Soteria's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const triage = async (requests, orders) => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('soteria_triage', { requests, orders });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, id) => r.result.items.find((i) => i.request_id === id);

test('native files are read untouched', async () => { assert.equal((await triage('requests.csv', 'orders.csv')).sources, undefined); });

test('Shopify orders export: one order per line-item group, timestamps with offsets, no delivery date', async () => {
  const r = await triage('requests.csv', 'exports/shopify-orders.csv');
  assert.equal(r.sources[0].profile, 'shopify_orders'); assert.equal(r.sources[0].rows, 3); assert.equal(r.sources[0].rows_before_grouping, 4);
  assert.match(r.sources[0].note, /no delivery date/);
  assert.equal(item(r, 'R-1001').suggestion, 'eligible_per_policy'); assert.equal(item(r, 'R-1001').refundable_remaining, 45);
  assert.ok(item(r, 'R-1002').flags.some((f) => /^outside_window_\d+_days$/.test(f)), 'the window runs from the order date');
  assert.ok(item(r, 'R-1002').flags.includes('over_review_threshold_200'));
});

test('one Stripe payments export serves as both the dispute list and the order list', async () => {
  const r = await triage('exports/stripe-payments.csv', 'exports/stripe-payments.csv');
  assert.deepEqual(r.sources.map((s) => [s.arg, s.kind, s.profile, s.rows]), [['orders', 'orders', 'stripe_payments', 4], ['requests', 'requests', 'stripe_payments', 2]]);
  assert.equal(r.sources[0].dates_read_as, undefined, 'ISO-style dates need no month/day guess');
  const d = item(r, 'dispute-ch_example506');
  assert.equal(d.type, 'chargeback'); assert.equal(d.order_id, 'O-506'); assert.equal(d.order_found, true); assert.equal(d.amount, 210);
  assert.equal(d.dispute_category, 'not_received'); assert.equal(d.requested_at, '2026-11-09'); assert.ok(d.respond_by);
  assert.equal(item(r, 'dispute-ch_example507').dispute_category, 'fraud');
  assert.equal(r.result.items.length, 2, 'payments with no dispute are not requests');
});
