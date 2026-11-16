import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, validateSarif, createMcpHandler, validate, sha256, parseCsv } from 'mythos-agent-core';
import { manifest, analyse, tokenize, estimateEffort, inventory, dependencyGraph, progress } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'epimetheus-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };

test('N/record and nlapi calls inside comments, strings, templates and regexes are not counted', () => {
  const src = [
    '/** @NApiVersion 2.1 */',
    "// define(['N/record'], function (r) {}); nlapiLoadRecord('x', 1);",
    "/* nlapiSubmitRecord(rec) */",
    "define(['N/search'], (search) => {",
    "  const msg = 'uses N/record and nlapiDeleteRecord';",
    '  const t = `nlapiSendEmail ${search.Type.SALES_ORDER}`;',
    '  const re = /nlapiRequestURL\\(/;',
    "  log.debug('N/record');",
    '  return {};',
    '});',
  ].join('\n');
  const r = analyse(src);
  assert.deepEqual(r.modules, ['N/search']);
  assert.equal(r.call_count, 0);
  assert.equal(r.version, '2.1');
  assert.equal(r.score, 0);
});

test('real calls inside template expressions are counted with the right line', () => {
  const r = analyse('var a = 1;\nvar s = `user ${nlapiGetUser()}`;\n');
  assert.deepEqual(r.calls, { nlapiGetUser: 1 });
  assert.equal(r.hits[0].line, 2);
});

test('division is not mistaken for a regex', () => {
  const { tokens } = tokenize('var x = a / b; nlapiLogExecution("DEBUG", x / 2);');
  assert.ok(tokens.some((t) => t.type === 'ident' && t.value === 'nlapiLogExecution'));
  assert.ok(!tokens.some((t) => t.type === 'regex'));
});

test('define([...]) with aliases is detected (function, arrow and single-param forms)', () => {
  const a = analyse("define(['N/record', 'N/search', './lib/util'], function (rec, s, util) { return {}; });");
  assert.deepEqual(a.aliases, { rec: 'N/record', s: 'N/search', util: './lib/util' });
  assert.deepEqual(a.custom_dependencies, ['./lib/util']);
  const b = analyse("define(['N/log', 'N/runtime'], (log, runtime) => ({}));");
  assert.deepEqual(b.aliases, { log: 'N/log', runtime: 'N/runtime' });
  const c = analyse("define(['N/https'], https => ({}));");
  assert.deepEqual(c.aliases, { https: 'N/https' });
  const d = analyse("var record = require('N/record');");
  assert.deepEqual(d.aliases, { record: 'N/record' });
});

test('effort estimate is deterministic and explained by its counted signals', () => {
  const text = readFileSync(join(fixtures, 'FileCabinet/SuiteScripts/sch_close_prep.js'), 'utf8');
  const e1 = estimateEffort(analyse(text)); const e2 = estimateEffort(analyse(text));
  assert.deepEqual(e1, e2);
  assert.equal(e1.hours, e1.signals.reduce((x, s) => x + s.hours, 0));
  assert.deepEqual(e1.signals.map((s) => s.signal), ['version', 'distinct_apis', 'calls', 'redesign', 'writes']);
  assert.equal(e1.hours, 11);
  const custom = estimateEffort(analyse(text), { name: 'calibrated', base_hours: { '1.0': 4 }, redesign: 6 });
  assert.equal(custom.hours, 14);
  assert.equal(custom.weights, 'calibrated');
  assert.equal(estimateEffort(analyse('/** @NApiVersion 2.1 */ define([], () => ({}));')).hours, 0);
});

test('dependency graph reports the cycle and a stable topological order', () => {
  const inv = inventory(join(fixtures, 'deps'));
  const g = dependencyGraph(inv);
  assert.deepEqual(g.cycles, [['SuiteScripts/lib/pricing.js', 'SuiteScripts/lib/tax.js']]);
  const order = g.order.map((o) => o.file);
  assert.deepEqual(order, ['SuiteScripts/lib/audit_log.js', 'SuiteScripts/lib/pricing.js', 'SuiteScripts/lib/tax.js', 'SuiteScripts/sl_legacy_report.js', 'SuiteScripts/ue_order.js']);
  assert.ok(order.indexOf('SuiteScripts/lib/pricing.js') < order.indexOf('SuiteScripts/ue_order.js'));
  assert.ok(g.edges.some((e) => e.from === 'SuiteScripts/ue_order.js' && e.to === 'SuiteScripts/lib/audit_log.js' && e.module === '/SuiteScripts/lib/audit_log'));
  assert.deepEqual(g.unresolved, [{ file: 'SuiteScripts/sl_legacy_report.js', module: './lib/missing_helper' }]);
  // Stable: same order on repeated runs and with items shuffled.
  const shuffled = { ...inv, items: [...inv.items].reverse() };
  assert.deepEqual(dependencyGraph(shuffled).order, g.order);
  assert.match(g.mermaid, /^graph LR/);
});

test('progress against a baseline lists converted, regressed, added and removed files', () => {
  const rows = readFileSync(join(fixtures, 'baseline/inventory.csv'), 'utf8');
  const r = progress(parseCsv(rows), inventory(join(fixtures, 'FileCabinet')));
  assert.deepEqual(r.converted.map((x) => x.file), ['SuiteScripts/mr_item_cleanup.js']);
  assert.deepEqual(r.regressed.map((x) => x.file), ['SuiteScripts/ue_invoice_sync.js']);
  assert.deepEqual(r.improved.map((x) => x.file), ['SuiteScripts/cs_vendor_form.js']);
  assert.deepEqual(r.removed.map((x) => x.file), ['SuiteScripts/old_portlet.js']);
  assert.equal(r.previous.needs_2_1, 6); assert.equal(r.current.needs_2_1, 4);
});

test('SARIF output is valid and points at the right lines', async () => {
  const root = tmpRoot();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('epimetheus_write_sarif', { dir: 'FileCabinet', out_dir: 'out-sarif' });
  assert.equal(r.status, 'executed', r.reason);
  const text = readFileSync(r.result.files[0], 'utf8');
  assert.equal(r.result.output_sha256, sha256(text));
  const doc = JSON.parse(text);
  assert.ok(validateSarif(doc).ok);
  const hit = doc.runs[0].results.find((x) => /nlapiRequestURL/.test(x.message.text));
  assert.equal(hit.locations[0].physicalLocation.artifactLocation.uri, 'FileCabinet/SuiteScripts/ue_invoice_sync.js');
  assert.equal(hit.locations[0].physicalLocation.region.startLine, 11);
  assert.ok(doc.runs[0].results.some((x) => x.ruleId === 'EPI005' && x.level === 'error'));
});

test('write_plan adds effort and dependency order; output hash is recorded', async () => {
  const root = tmpRoot();
  const state = mkdtempSync(join(tmpdir(), 'epimetheus-state-'));
  const rt = new AgentRuntime(manifest, { root, stateDir: state });
  const r = await rt.call('epimetheus_write_plan', { dir: 'deps', out_dir: 'out-plan' });
  assert.equal(r.status, 'executed', r.reason);
  const csv = readFileSync(r.result.files[0], 'utf8');
  assert.match(csv.split('\n')[0], /effort_hours,conversion_order,depends_on/);
  const md = readFileSync(r.result.files[1], 'utf8');
  assert.match(md, /Conversion order by dependency/); assert.match(md, /dependency cycle/); assert.match(md, /missing_helper/);
  const audit = readFileSync(join(state, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.at(-1).output_sha256, r.result.output_sha256);
});

test('estimate_config: three mutated configs fail with JSON pointers', async () => {
  const root = tmpRoot();
  const good = JSON.parse(readFileSync(join(fixtures, 'estimate-config.json'), 'utf8'));
  assert.ok(validate(manifest.configSchemas.estimate_config, good).ok);
  const cases = {
    'unknown.json': [{ ...good, per_distinct_apis: 1 }, /\/per_distinct_apis is not an allowed property/],
    'wrongtype.json': [{ ...good, redesign: 'six' }, /\/redesign expected number/],
    'missing.json': [(({ name, ...rest }) => rest)(good), /\/name is required/],
    'badversion.json': [{ ...good, base_hours: { '3.0': 1 } }, /\/base_hours\/3\.0 is not an allowed property/],
  };
  const rt = new AgentRuntime(manifest, { root, audit: false });
  for (const [file, [cfg, re]] of Object.entries(cases)) {
    writeFileSync(join(root, file), JSON.stringify(cfg));
    const r = await rt.call('epimetheus_inventory', { dir: 'FileCabinet', estimate_config: file });
    assert.equal(r.status, 'error', file);
    assert.match(r.reason, re, file);
  }
  const ok = await rt.call('epimetheus_inventory', { dir: 'FileCabinet', estimate_config: 'estimate-config.json' });
  assert.equal(ok.result.effort_weights, 'Sample team calibration (fictional)');
});

test('deploy stays blocked in every mode and cannot be put on Auto', async () => {
  for (const mode of ['review', 'assist', 'auto']) {
    const rt = new AgentRuntime(manifest, { root: fixtures, audit: false, mode });
    assert.equal((await rt.call('epimetheus_deploy_conversion', {})).status, 'blocked');
  }
  assert.throws(() => new AgentRuntime(manifest, { root: fixtures, audit: false, mode: 'auto', autoActions: ['epimetheus_deploy_conversion'] }), /one-click/);
});

test('MCP prompt walks the workflow', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'epimetheus_conversion_plan', arguments: { dir: 'FileCabinet' } } });
  const text = got.result.messages[0].content.text;
  for (const t of ['epimetheus_inventory', 'epimetheus_explain_file', 'epimetheus_dependency_graph', 'epimetheus_progress', 'epimetheus_write_plan', 'named person']) assert.ok(text.includes(t), t);
  assert.match(text, /dir=FileCabinet/);
});
