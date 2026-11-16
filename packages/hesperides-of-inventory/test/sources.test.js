// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Hesperides's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const compare = async (counts, on_hand, root = fixtures) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('hesperides_compare', { counts, on_hand });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, sku) => r.result.items.find((i) => i.sku === sku);

test('native files are read untouched', async () => { assert.equal((await compare('counts.csv', 'on-hand.csv')).sources, undefined); });

test('NetSuite item search: location quantities and average cost with currency signs and thousands commas', async () => {
  const r = await compare('counts.csv', 'exports/netsuite-inventory.csv');
  assert.equal(r.sources[0].profile, 'netsuite_inventory'); assert.equal(r.sources[0].mapped.system_qty, 'Location On Hand');
  assert.equal(item(r, 'WID-100').system_qty, 120); assert.equal(item(r, 'WID-200').system_qty, 80);
  assert.equal(item(r, 'WID-200').variance_value, -4, '79 counted against 80 at 4.00');
  assert.equal(item(r, 'GAD-300').system_qty, 1040);
});

test('Shopify inventory export: no unit cost, so the value of a variance is unknown and says so', async () => {
  const r = await compare('counts.csv', 'exports/shopify-inventory.csv');
  assert.equal(r.sources[0].profile, 'shopify_inventory'); assert.equal(r.sources[0].rows, 2, 'the row with no SKU is skipped');
  assert.ok(item(r, 'WID-200').flags.includes('unit_cost_missing')); assert.equal(item(r, 'WID-200').variance_value, null);
  assert.match(r.sources[0].note, /no unit cost/);
});

test('a scanner count sheet with other column names maps by the "also called" list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hesp-src-'));
  copyFileSync(join(fixtures, 'on-hand.csv'), join(dir, 'on-hand.csv'));
  writeFileSync(join(dir, 'scan.csv'), 'Barcode;Bin;Physical Count;Counted By;Scanned At\nWID-100;A-01;120;Lee;12/11/2026 09:00\nWID-200;A-02;79;Lee;13/11/2026 09:10\n');
  const r = await compare('scan.csv', 'on-hand.csv', dir);
  assert.equal(r.sources[0].format, 'semicolon-delimited'); assert.equal(r.sources[0].dates_read_as, 'day/month/year');
  assert.equal(item(r, 'WID-200').counted_qty, 79); assert.equal(item(r, 'WID-100').variance_qty, 0);
});
