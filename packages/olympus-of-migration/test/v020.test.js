import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, readRecords, generateSigningKey, loadPublicKeys, readAudit, verifyChain, sha256, canonical, createMcpHandler, validate } from 'mythos-agent-core';
import { manifest, tieOutBalances, compareExports, checkFields, compareRuns } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rec = (f) => readRecords(join(fixtures, f));
const fx = { subsidiary_column: 'subsidiary', currency_column: 'currency', base_currency: 'USD', fx_rates: { EUR: 1.1 } };
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'olympus-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };

test('two subsidiaries with EUR/USD and FX rates give correct differences per subsidiary', () => {
  const r = tieOutBalances(rec('source-tb-multi.csv'), rec('netsuite-sandbox-tb-multi.csv'), { ...fx, tolerance: 0.01 });
  const de = r.by_subsidiary.find((g) => g.subsidiary === 'DE01');
  const us = r.by_subsidiary.find((g) => g.subsidiary === 'US01');
  assert.equal(de.difference, 110); // 100 EUR at 1.10
  assert.equal(de.currency, 'USD');
  assert.equal(us.difference, -0.5);
  const line = r.not_tied.find((l) => l.subsidiary === 'DE01');
  assert.deepEqual([line.account, line.source, line.target], ['1200', 1100, 990]);
  assert.equal(r.accounts, 6);
});

test('a tolerance of 0.01 vs 1.00 changes pass/fail', () => {
  const strict = tieOutBalances(rec('source-tb-multi.csv'), rec('netsuite-sandbox-tb-multi.csv'), { ...fx, tolerance: 0.01 });
  const loose = tieOutBalances(rec('source-tb-multi.csv'), rec('netsuite-sandbox-tb-multi.csv'), { ...fx, tolerance: 1.0 });
  assert.equal(strict.by_subsidiary.find((g) => g.subsidiary === 'US01').state, 'blocking');
  assert.equal(loose.by_subsidiary.find((g) => g.subsidiary === 'US01').state, 'ties');
  assert.equal(loose.by_subsidiary.find((g) => g.subsidiary === 'DE01').state, 'blocking');
  const c1 = compareExports([{ id: '1', amount: '10.00' }], [{ id: '1', amount: '10.50' }], { tolerance: 0.01 });
  const c2 = compareExports([{ id: '1', amount: '10.00' }], [{ id: '1', amount: '10.50' }], { tolerance: 1 });
  assert.equal(c1.status, 'blocking'); assert.equal(c2.status, 'clean');
});

test('currency without FX rates becomes part of the key; a missing rate is unknown, never guessed', () => {
  const s = [{ account: '1000', currency: 'EUR', balance: '10' }, { account: '1000', currency: 'USD', balance: '5' }];
  const t = [{ account: '1000', currency: 'EUR', balance: '10' }, { account: '1000', currency: 'USD', balance: '5' }];
  const r = tieOutBalances(s, t, { currency_column: 'currency' });
  assert.equal(r.accounts, 2); assert.equal(r.status, 'ties');
  const g = tieOutBalances([{ account: '1', currency: 'GBP', balance: '10' }], [{ account: '1', currency: 'GBP', balance: '10' }], { currency_column: 'currency', fx_rates: { EUR: 1.1 } });
  assert.deepEqual(g.missing_fx_rates, ['GBP']);
  assert.equal(g.not_tied[0].state, 'missing_or_unknown');
  assert.equal(g.not_tied[0].source, null);
  assert.throws(() => tieOutBalances(s, t, { subsidiary_column: 'nope' }), /subsidiary_column "nope"/);
});

test('compare ties totals per subsidiary', () => {
  const s = [{ id: '1', sub: 'A', amount: '10' }, { id: '2', sub: 'B', amount: '5' }];
  const t = [{ id: '1', sub: 'A', amount: '10' }, { id: '2', sub: 'A', amount: '5' }];
  const r = compareExports(s, t, { subsidiary_column: 'sub' });
  assert.deepEqual(r.totals.by_subsidiary.map((x) => [x.subsidiary, x.difference]), [['A', -5], ['B', null]]);
  assert.ok(r.findings.some((f) => f.code === 'subsidiary_totals_do_not_tie'));
});

test('field rules report every violation with its spreadsheet row', () => {
  const rules = JSON.parse(readFileSync(join(fixtures, 'migration-rules.json'), 'utf8')).field_rules;
  const r = checkFields(rec('bad-invoices.csv'), rules);
  assert.equal(r.status, 'blocking');
  const has = (rule, row, re) => r.violations.some((v) => v.rule === rule && v.row === row && re.test(v.problem));
  assert.ok(has('INV-KEY', 3, /duplicate of row 2/));
  assert.ok(has('INV-KEY', 5, /blank/));
  assert.ok(has('INV-DATE', 4, /YYYY-MM-DD/));
  assert.ok(has('INV-AMOUNT', 4, /below minimum 0/));
  assert.ok(has('INV-AMOUNT', 5, /not a number/));
  assert.ok(has('INV-CURRENCY', 4, /not one of/));
  assert.equal(r.rules.find((x) => x.rule === 'INV-STATUS').severity, 'warning');
  assert.equal(checkFields(rec('source-open-invoices.csv'), rules).status, 'clean');
  assert.match(checkFields(rec('bad-invoices.csv'), [{ column: 'nope' }]).violations[0].problem, /not in the file/);
});

test('run comparison lists resolved, new and still-open items', () => {
  const prev = JSON.parse(readFileSync(join(fixtures, 'runs/trial-load-1-findings.json'), 'utf8'));
  const cmp = compareExports(rec('source-open-invoices.csv'), rec('netsuite-sandbox-open-invoices.csv'), { key: 'externalid', amount_column: 'amount' });
  const tb = tieOutBalances(rec('source-trial-balance.csv'), rec('netsuite-sandbox-trial-balance.csv'));
  const r = compareRuns(prev, { compare: cmp, trial_balance: tb });
  assert.deepEqual(r.findings.resolved.map((f) => f.code), ['duplicate_keys_target']);
  assert.deepEqual(r.findings.new.map((f) => f.code), ['field_mismatch']);
  assert.deepEqual(r.missing_in_target.fixed, ['INV-1039']);
  assert.deepEqual(r.missing_in_target.still_missing, ['INV-1041']);
  assert.deepEqual(r.trial_balance.still_not_tied.sort(), ['1000', '1200']);
  assert.equal(r.counts.missing_in_target.change, -1);
  assert.equal(r.go_live, 'not_approved');
});

test('signed readiness report: the report hash is in the signed audit log and go-live stays blocked', async () => {
  const root = tmpRoot();
  const keys = generateSigningKey(mkdtempSync(join(tmpdir(), 'olympus-key-')), { root });
  const state = mkdtempSync(join(tmpdir(), 'olympus-state-'));
  const rt = new AgentRuntime(manifest, { root, stateDir: state, signingKey: keys.privateKeyFile });
  const r = await rt.call('olympus_readiness_report', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', config: 'migration-rules.json', source_tb: 'source-tb-multi.csv', target_tb: 'netsuite-sandbox-tb-multi.csv', out_dir: 'out-signed' });
  assert.equal(r.status, 'executed', r.reason);
  const hashes = {};
  for (const f of r.result.files) hashes[f.split(/[\\/]/).pop()] = sha256(readFileSync(f, 'utf8'));
  assert.equal(r.result.output_sha256, sha256(canonical(hashes)));
  assert.equal(r.result.files.length, 4);
  for (const mode of ['review', 'assist', 'auto']) {
    const x = new AgentRuntime(manifest, { root, stateDir: state, mode, signingKey: keys.privateKeyFile });
    assert.equal((await x.call('olympus_approve_go_live', {})).status, 'blocked');
  }
  assert.throws(() => new AgentRuntime(manifest, { root, audit: false, mode: 'auto', autoActions: ['olympus_approve_go_live'] }), /one-click/);
  const entries = readAudit(join(state, 'audit.jsonl'));
  const line = entries.find((e) => e.tool === 'olympus_readiness_report');
  assert.equal(line.output_sha256, r.result.output_sha256);
  assert.ok(line.sig && line.key_id === keys.keyId);
  const v = verifyChain(entries, { publicKeys: loadPublicKeys([keys.publicKeyFile]) });
  assert.equal(v.ok, true, JSON.stringify(v.breaks));
  assert.equal(v.signing, 'signed and verified');
  // Changing the recorded hash breaks the signed chain.
  const forged = entries.map((e) => (e === line ? { ...e, output_sha256: '0'.repeat(64) } : e));
  assert.equal(verifyChain(forged, { publicKeys: loadPublicKeys([keys.publicKeyFile]) }).ok, false);
});

test('report includes action list, exceptions.csv, html and change since previous run', async () => {
  const root = tmpRoot();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('olympus_readiness_report', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount', source_tb: 'source-trial-balance.csv', target_tb: 'netsuite-sandbox-trial-balance.csv', previous_findings: 'runs/trial-load-1-findings.json', out_dir: 'out-actions' });
  assert.equal(r.status, 'executed', r.reason);
  assert.equal(r.result.actions[0].priority, 1);
  const md = readFileSync(r.result.files[0], 'utf8');
  assert.match(md, /Next actions/); assert.match(md, /Change since the previous run/); assert.match(md, /Go-live: \*\*not approved/);
  const html = readFileSync(r.result.files[1], 'utf8');
  assert.match(html, /not approved/); assert.doesNotMatch(html, /<script/i);
  const csv = readFileSync(r.result.files[3], 'utf8');
  assert.match(csv, /missing_in_target,INV-1041/); assert.match(csv, /trial_balance,1000/);
});

test('migration_rules config: three mutated configs fail with JSON pointers', async () => {
  const root = tmpRoot();
  const good = JSON.parse(readFileSync(join(fixtures, 'migration-rules.json'), 'utf8'));
  assert.ok(validate(manifest.configSchemas.migration_rules, good).ok);
  const cases = {
    'unknown.json': [{ ...good, tolerence: 0.01 }, /\/tolerence is not an allowed property/],
    'wrongtype.json': [{ ...good, tolerance: '0.01' }, /\/tolerance expected number/],
    'missing.json': [(({ name, ...rest }) => rest)(good), /\/name is required/],
    'badrule.json': [{ ...good, field_rules: [{ column: 'x', requird: true }] }, /\/field_rules\/0\/requird is not an allowed property/],
  };
  const rt = new AgentRuntime(manifest, { root, audit: false });
  for (const [file, [cfg, re]] of Object.entries(cases)) {
    writeFileSync(join(root, file), JSON.stringify(cfg));
    const r = await rt.call('olympus_tie_out_balances', { source: 'source-tb-multi.csv', target: 'netsuite-sandbox-tb-multi.csv', config: file });
    assert.equal(r.status, 'error', file);
    assert.match(r.reason, re, file);
  }
});

test('invalid tool arguments are refused before running', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const r = await rt.call('olympus_tie_out_balances', { source: 'a.csv', target: 'b.csv', tolerance: -1 });
  assert.equal(r.status, 'error'); assert.match(r.reason, /\/tolerance/);
});

test('MCP prompt walks the workflow and fills arguments', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const h = createMcpHandler(rt);
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.ok(list.result.prompts.some((p) => p.name === 'olympus_go_live_readiness'));
  const got = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'olympus_go_live_readiness', arguments: { source: 'a.csv', target: 'b.csv' } } });
  const text = got.result.messages[0].content.text;
  for (const t of ['olympus_compare_exports', 'olympus_tie_out_balances', 'olympus_check_fields', 'olympus_compare_runs', 'olympus_readiness_report', 'named person']) assert.ok(text.includes(t), t);
  assert.match(text, /source=a\.csv/);
});
