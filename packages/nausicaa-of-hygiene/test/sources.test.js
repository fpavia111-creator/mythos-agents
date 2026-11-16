// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Nausicaa's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const audit = async (contacts) => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('nausicaa_audit', { contacts, as_of: '2026-11-14' });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, re) => r.result.items.find((i) => re.test(i.email));

test('native contact file is read untouched', async () => { assert.equal((await audit('contacts.csv')).sources, undefined); });

test('HubSpot contacts export: names joined, hard bounce, opt-out conflict, consent from the legal basis', async () => {
  const r = await audit('exports/hubspot-contacts.csv');
  assert.equal(r.sources[0].profile, 'hubspot_contacts');
  assert.equal(item(r, /^ana\.lopez/).suggested_action, 'keep'); assert.equal(item(r, /^ana\.lopez/).name, 'Ana Lopez');
  assert.ok(item(r, /cy\.reyes/).flags.includes('hard_bounce'));
  assert.ok(item(r, /dee\.park/).flags.includes('consent_conflict_unsubscribed'));
  assert.ok(item(r, /gmial/).flags.includes('consent_unknown'), 'no legal basis recorded: consent is unknown, not assumed');
  assert.ok(item(r, /^Ana\.Lopez/).flags.some((f) => /^duplicate_of_/.test(f)));
  assert.match(r.sources[0].note, /billing setting/);
});

test('Salesforce report export and Data Loader export agree', async () => {
  const rep = await audit('exports/salesforce-contacts-report.csv');
  const dl = await audit('exports/salesforce-data-loader.csv');
  assert.equal(rep.sources[0].profile, 'salesforce_contacts_report'); assert.equal(dl.sources[0].profile, 'salesforce_data_loader');
  assert.equal(rep.result.items.length, 3, 'the "Grand Totals" footer row is skipped');
  assert.equal(rep.sources[0].dates_read_as, 'month/day/year');
  const shape = (r) => r.result.items.map((i) => [i.email, i.flags, i.suggested_action]);
  assert.deepEqual(shape(rep), shape(dl));
  assert.ok(item(rep, /cy\.reyes/).flags.includes('hard_bounce')); assert.equal(item(rep, /dee\.park/).suggested_action, 'suppress');
});

test('Mailchimp subscribed and cleaned exports: confirmed opt-in is consent, an import date alone is not', async () => {
  const sub = await audit('exports/mailchimp-subscribed.csv');
  assert.equal(sub.sources[0].profile, 'mailchimp_audience');
  assert.ok(!item(sub, /ana\.lopez/).flags.includes('consent_unknown'));
  assert.ok(item(sub, /globex/).flags.includes('consent_unknown'));
  assert.ok(sub.result.items.every((i) => i.flags.includes('no_activity_date')), 'no engagement date in the export, and the result says so');
  const cleaned = await audit('exports/mailchimp-cleaned.csv');
  assert.ok(item(cleaned, /cy\.reyes/).flags.includes('hard_bounce')); assert.equal(item(cleaned, /cy\.reyes/).suggested_action, 'suppress');
});
