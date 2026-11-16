// Real-export adapters: a Procore RFI CSV is mapped onto Epeius's own columns.
// The Procore column names were checked against Procore's "Export RFIs to CSV or
// PDF" support page on 2026-11-15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const review = async (args, root = fixtures) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('epeius_review_log', { documents: 'documents.csv', as_of: '2026-11-14', ...args });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};

test('native logs are read untouched', async () => { assert.equal((await review({ rfis: 'rfis.csv', submittals: 'submittals.csv' })).sources, undefined); });

test('Procore RFI CSV: "#" column, closed flag, impact values, references from drawing number and reference', async () => {
  const r = await review({ rfis: 'exports/procore-rfis.csv' });
  const s = r.sources[0];
  assert.equal(s.profile, 'procore_rfis'); assert.equal(s.mapped.rfi_no, '#'); assert.equal(s.dates_read_as, 'month/day/year');
  assert.match(s.note, /no question text/);
  const by = Object.fromEntries(r.result.items.map((i) => [i.rfi_no, i]));
  assert.equal(by['001'].status, 'closed'); assert.equal(by['001'].answered_date, '2026-09-08');
  assert.equal(by['002'].status, 'open'); assert.ok(by['002'].flags.includes('overdue')); assert.ok(by['002'].flags.includes('superseded_reference'));
  assert.deepEqual(by['002'].references, ['A-201 rev 2', '09 29 00']);
  assert.equal(by['003'].cost_impact, 'Yes: 1500'); assert.equal(by['003'].schedule_impact, 'Yes: 3 days'); assert.deepEqual(by['003'].flags, []);
});

test('the Procore file and the same RFIs in Epeius\'s own layout agree on the open and overdue items', async () => {
  const own = await review({ rfis: 'rfis.csv' }); const procore = await review({ rfis: 'exports/procore-rfis.csv' });
  const two = (r) => r.result.items.filter((i) => i.rfi_no === '002').map((i) => [i.status, i.due_date, i.ball_in_court, i.flags.filter((f) => f !== 'impact_unstated')]);
  assert.deepEqual(two(procore), two(own));
});

test('a submittal log with other column names maps by the "also called" list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'epeius-src-'));
  copyFileSync(join(fixtures, 'documents.csv'), join(dir, 'documents.csv'));
  writeFileSync(join(dir, 'subs.csv'), 'Submittal Number,Spec Section,Title,Submittal Status,Final Due Date,Date Submitted,Date Returned,Rev.,Ball In Court\n08 71 00-01,08 71 00,Door hardware schedule,submitted,10/15/2026,10/14/2026,,0,Architect\n');
  const r = await review({ submittals: 'subs.csv' }, dir);
  assert.equal(r.sources[0].profile, null); assert.equal(r.sources[0].mapped.required_by, 'Final Due Date');
  assert.equal(r.result.submittal_items[0].submittal_no, '08 71 00-01');
  assert.equal(r.result.submittal_items[0].required_by, '2026-10-15');
});
