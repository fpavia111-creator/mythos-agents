// Real-export adapters: a BambooHR employee report is mapped onto Eos's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const status = async (people, template = 'template-roles.json') => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('eos_status', { people, template, as_of: '2026-11-14' });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};

test('native people file is read untouched', async () => { assert.equal((await status('people.csv')).sources, undefined); });

test('BambooHR employee report: split names, US dates, contractor or employee from Employment Status', async () => {
  const r = await status('exports/bamboohr-new-hires.csv');
  const s = r.sources[0];
  assert.equal(s.profile, 'bamboohr_employees'); assert.equal(s.dates_read_as, 'month/day/year'); assert.deepEqual(s.missing, []);
  assert.equal(s.mapped.start_date, 'Hire Date'); assert.match(s.note, /checklist template needs those two types/);
  assert.match(r.result.summary, /^3 people/);
  assert.match(r.result.summary, /C2: contractor_no_end_date/, 'the contractor with no termination date is flagged as in the native file');
  assert.ok(!/unknown_type/.test(r.result.summary), 'employee and contractor are both types in the template');
  const text = JSON.stringify(r.result);
  assert.ok(text.includes('Jordan Lee') && text.includes('2026-11-16') && text.includes('2027-02-28'), 'names joined and dates in ISO form');
});

test('the same people in Eos\'s own layout give the same contractor findings', async () => {
  const own = await status('people.csv'); const bamboo = await status('exports/bamboohr-new-hires.csv');
  const flagsFor = (r, id) => (new RegExp(`${id}: ([a-z_, ]+)`).exec(r.result.summary) || [])[1];
  assert.equal(flagsFor(bamboo, 'C1'), flagsFor(own, 'C1')); assert.equal(flagsFor(bamboo, 'C2'), flagsFor(own, 'C2'));
});
