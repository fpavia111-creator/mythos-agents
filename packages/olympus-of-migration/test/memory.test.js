import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const SRC = `legacy_ref,customer,region,net_due,terms
L-1,Northwind Traders (fictional),EU,1200.00,Net 30
L-2,Blue Harbor Supply (fictional),US,850.00,Net 45
L-3,Juniper Labs (fictional),US,2450.00,Net 30
`;
const TGT = `legacy_ref,customer,region,net_due,terms
L-1,Northwind Traders (fictional),EU,1200.00,Net 30
L-2,Blue Harbor Supply (fictional),US,850.00,Net 45
L-3,Juniper Labs (fictional),US,2405.00,Net 30
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-mem-'));
  writeFileSync(join(dir, 'src.csv'), SRC);
  writeFileSync(join(dir, 'tgt.csv'), TGT);
  writeFileSync(join(dir, 'rules.json'), JSON.stringify({ name: 'Fictional rules', field_rules: [{ id: 'ref-required', column: 'legacy_ref', required: true, unique: true }] }));
  return { dir, rt: new AgentRuntime(manifest, { root: dir }) };
}

async function learnAndAccept(rt, kind, value, who = 'Morgan Hale (fictional)') {
  const l = await rt.call('olympus_learn', { kind, value });
  assert.equal(l.status, 'executed', JSON.stringify(l));
  const id = l.result.fact.id;
  const a1 = await rt.call('olympus_accept_learning', { id, decision: 'accept' });
  assert.equal(a1.status, 'needs_approval');
  rt.approvals.approve(a1.approval_id, who);
  const a2 = await rt.call('olympus_accept_learning', { id, decision: 'accept' });
  assert.equal(a2.status, 'executed', JSON.stringify(a2));
  return id;
}

test('Olympus: a learned key and amount column are used once a person accepts them', async () => {
  const { rt } = setup();
  const before = await rt.call('olympus_compare_exports', { source: 'src.csv', target: 'tgt.csv' });
  assert.equal(before.status, 'error');
  assert.match(before.reason, /could not find a key column/);
  await rt.call('olympus_learn', { kind: 'column_setting', value: { setting: 'key', column: 'legacy_ref' } });
  assert.equal((await rt.call('olympus_compare_exports', { source: 'src.csv', target: 'tgt.csv' })).status, 'error', 'a waiting fact changes nothing');

  await learnAndAccept(rt, 'column_setting', { setting: 'key', column: 'legacy_ref' });
  await learnAndAccept(rt, 'column_setting', { setting: 'amount_column', column: 'net_due' });
  const r = await rt.call('olympus_compare_exports', { source: 'src.csv', target: 'tgt.csv' });
  assert.equal(r.status, 'executed', JSON.stringify(r));
  assert.equal(r.result.key.source, 'legacy_ref');
  assert.equal(r.result.totals.difference, 45);
  assert.equal(r.result.memory.used.length, 2);
  assert.equal(r.memory_applied.length, 2);
  assert.match(r.result.summary, /2 learned fact\(s\) used/);
});

test('Olympus: the call and the config always win over a learned column', async () => {
  const { rt } = setup();
  await learnAndAccept(rt, 'column_setting', { setting: 'key', column: 'customer' });
  const r = await rt.call('olympus_compare_exports', { source: 'src.csv', target: 'tgt.csv', key: 'legacy_ref' });
  assert.equal(r.result.key.source, 'legacy_ref');
  assert.equal(r.result.memory.used.length, 0);
  assert.match(r.result.memory.skipped[0].why, /already sets key/);
});

test('Olympus: two accepted facts that disagree are both left out, with the reason', async () => {
  const { rt } = setup();
  await learnAndAccept(rt, 'column_setting', { setting: 'subsidiary_column', column: 'region' });
  await learnAndAccept(rt, 'column_setting', { setting: 'subsidiary_column', column: 'customer' });
  const r = await rt.call('olympus_compare_exports', { source: 'src.csv', target: 'tgt.csv', key: 'legacy_ref', amount_column: 'net_due' });
  assert.equal(r.result.totals.by_subsidiary, undefined);
  assert.equal(r.result.memory.skipped.length, 2);
  assert.match(r.result.memory.skipped[0].why, /disagree/);
});

test('Olympus: a learned field rule adds a check; a config rule with the same id wins', async () => {
  const { rt } = setup();
  const id = await learnAndAccept(rt, 'field_rule', { column: 'terms', enum: ['Net 30', 'Net 60'] });
  const alone = await rt.call('olympus_check_fields', { file: 'tgt.csv' });
  assert.equal(alone.status, 'executed', 'a learned rule is enough to run the check');
  assert.equal(alone.result.violation_count, 1);
  assert.equal(alone.result.violations[0].rule, id, 'the rule is named by its memory id');
  const withCfg = await rt.call('olympus_check_fields', { file: 'tgt.csv', config: 'rules.json' });
  assert.deepEqual(withCfg.result.rules.map((r) => r.rule), ['ref-required', id]);
  await learnAndAccept(rt, 'field_rule', { id: 'ref-required', column: 'customer', max_length: 3 });
  const clash = await rt.call('olympus_check_fields', { file: 'tgt.csv', config: 'rules.json' });
  assert.deepEqual(clash.result.rules.map((r) => r.rule), ['ref-required', id]);
  assert.match(clash.result.memory.skipped[0].why, /config has a field rule with id "ref-required"/);
});

test('Olympus: the readiness report lists the learned facts it used', async () => {
  const { dir, rt } = setup();
  await learnAndAccept(rt, 'column_setting', { setting: 'key', column: 'legacy_ref' });
  await learnAndAccept(rt, 'field_rule', { id: 'terms-known', column: 'terms', enum: ['Net 30', 'Net 60'], severity: 'warning' });
  const r = await rt.call('olympus_readiness_report', { source: 'src.csv', target: 'tgt.csv', amount_column: 'net_due' });
  assert.equal(r.status, 'executed', JSON.stringify(r));
  assert.equal(r.result.go_live, 'not_approved');
  const md = readFileSync(join(dir, 'mythos-out/olympus/readiness-report.md'), 'utf8');
  assert.match(md, /## Learned facts used/);
  assert.match(md, /key is column "legacy_ref" \(accepted by Morgan Hale \(fictional\)\)/);
  assert.match(md, /terms-known/);
  const html = readFileSync(join(dir, 'mythos-out/olympus/readiness-report.html'), 'utf8');
  assert.match(html, /Learned facts used/);
  const findings = JSON.parse(readFileSync(join(dir, 'mythos-out/olympus/findings.json'), 'utf8'));
  assert.equal(findings.learned_facts.used.length, 2);
});

test('Olympus: tolerances, FX rates and unsafe patterns cannot be learned', async () => {
  const { rt } = setup();
  const bad = [
    ['tolerance', { value: 1000 }, /kind|enum|allowed/],
    ['fx_rates', { EUR: 1.08 }, /kind|enum|allowed/],
    ['column_setting', { setting: 'tolerance', column: '9999' }, /must be one of/],
    ['field_rule', { column: 'terms', pattern: '(a+)+$' }, /nested quantifier/],
    ['field_rule', { column: 'terms', pattern: '([' }, /not a valid regular expression/],
    ['field_rule', { column: 'terms' }, /checks nothing/],
    ['field_rule', { column: 'net_due', type: 'number', min: 10, max: 1 }, /min is larger than max/],
  ];
  for (const [kind, value, re] of bad) {
    const r = await rt.call('olympus_learn', { kind, value });
    assert.equal(r.status, 'error', `${kind} ${JSON.stringify(value)}`);
    assert.match(r.reason, re, `${kind} ${JSON.stringify(value)}: ${r.reason}`);
  }
  assert.equal(rt.memory.lines().length, 0);
});

test('Olympus: go-live stays blocked and accepting a fact cannot go on Auto', () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['olympus_accept_learning'] }), /one-click/);
  const t = new AgentRuntime(manifest, { audit: false, mode: 'auto' }).listTools();
  assert.equal(t.find((x) => x.name === 'olympus_approve_go_live').decision, 'block');
  assert.equal(t.find((x) => x.name === 'olympus_accept_learning').decision, 'ask');
  assert.equal(t.find((x) => x.name === 'olympus_learn').decision, 'allow');
});
