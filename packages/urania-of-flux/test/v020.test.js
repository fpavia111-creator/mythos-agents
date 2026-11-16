import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsv, validate } from 'mythos-agent-core';
import { manifest, variances, checkClaims, numbersIn, polarity, comparePrior, chartSvg, svgPoints, svgSafety, tracePoints } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const figs = () => variances(parseCsv(readFileSync(join(fixtures, 'figures.csv'), 'utf8')));
const priorFigs = () => variances(parseCsv(readFileSync(join(fixtures, 'prior/figures-2026-09.csv'), 'utf8')));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'urania-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const rtFor = (root, opts = {}) => new AgentRuntime(manifest, { root, audit: false, stateDir: join(root, '.mythos'), mode: 'auto', autoActions: ['urania_lock_figures'], ...opts });
const claim = (t) => checkClaims([{ path: 'x', text: t }], figs()).claims[0];

test('percent claims: rounding as written, hedges widen by one unit', () => {
  assert.equal(claim('Revenue was up 12% on budget [F1].').status, 'ok', '12.18% rounds to 12%');
  assert.equal(claim('Revenue was up 12.2% on budget [F1].').status, 'ok');
  assert.equal(claim('Revenue was up 12.3% on budget [F1].').status, 'number_mismatch', '12.18 is not 12.3 at one decimal');
  assert.equal(claim('Revenue was up 11% on budget [F1].').status, 'number_mismatch');
  assert.equal(claim('Revenue was up about 11% on budget [F1].').status, 'number_mismatch', 'a hedge widens to one unit, 11 vs 12.18 is still out');
  assert.equal(claim('Revenue grew 4% on the prior month [F1].').status, 'number_mismatch', '4.58% does not round to 4%');
  assert.equal(claim('Revenue grew roughly 4% on the prior month [F1].').status, 'ok', 'hedged: within one unit');
  const n = numbersIn('about 4% and 4%');
  assert.deepEqual(n.map((x) => x.hedged), [true, false]);
});

test('percent claims: ratios and changes between two cited figures', () => {
  assert.deepEqual(claim('Gross margin was 58.5% of revenue [F3, F1].').matched[0].matches, ['F3/F1.ratio']);
  assert.equal(claim('Gross margin was 58.5% of revenue [F3].').status, 'number_mismatch', 'a ratio needs both figures cited');
  assert.equal(claim('Gross margin was 61% of revenue [F3][F1].').status, 'number_mismatch');
});

test('direction words must agree with the sign of a matched variance', () => {
  assert.equal(polarity('Revenue rose and fell'), 0);
  assert.equal(polarity('Cash fell'), -1);
  assert.equal(claim('Payroll was 5,000 above budget [F4].').status, 'direction_mismatch');
  assert.equal(claim('Payroll was 5,000 below budget [F4].').status, 'ok');
  assert.equal(claim('Revenue was down 12.2% on budget [F1].').status, 'direction_mismatch');
  assert.equal(claim('Cash fell 160,000 in the month [F6].').status, 'ok');
  assert.equal(claim('Revenue rose to 1,234,000 [F1].').status, 'ok', 'a level is not a variance: no direction check');
  const c = checkClaims([{ path: 'n', text: readFileSync(join(fixtures, 'docs/cfo-notes.md'), 'utf8') }], figs());
  assert.equal(c.claims_checked, 4); assert.equal(c.ok, 3); assert.equal(c.direction_mismatch, 1); assert.equal(c.issues, 1);
});

test('charts: self-contained SVG and every point traces to a figure id', () => {
  const vs = figs();
  for (const name of ['variance', 'variance_pct', 'actual_vs_basis']) {
    const { svg, points } = chartSvg(vs, name, { source: 'figures.csv' });
    assert.deepEqual(svgSafety(svg), [], `${name} is script-free`);
    assert.doesNotMatch(svg, /<script|\son\w+=|href=/i);
    assert.match(svg, /role="img"/); assert.match(svg, /<title id="chart-title">/);
    assert.ok(points.length >= vs.length, `${name} has a point per figure`);
    assert.deepEqual(tracePoints(points, vs), [], `${name} traces`);
    const rects = (svg.match(/<rect /g) || []).length - 1; // minus the background
    assert.equal(rects, points.length, 'every drawn bar is a traced point');
    for (const p of points) assert.ok(vs.some((v) => v.id === p.figure_id));
  }
  const one = chartSvg(vs, 'variance', { ids: ['F5'] });
  assert.deepEqual(one.points, [{ figure_id: 'F5', field: 'var_budget', value: 26000 }]);
  assert.throws(() => chartSvg(vs, 'variance', { ids: ['F99'] }), /unknown figure id F99/);
  assert.throws(() => chartSvg(vs, 'pie'), /unknown chart/);
  assert.deepEqual(tracePoints([{ figure_id: 'F1', field: 'actual', value: 1 }], vs).length, 1, 'a wrong value is caught');
  assert.ok(svgSafety('<svg><script>x</script><a href="https://example.com" onclick="y"></a></svg>').length >= 3);
  const evil = chartSvg([{ ...vs[0], id: 'F1', metric: '<script>alert(1)</script>' }], 'variance');
  assert.doesNotMatch(evil.svg, /<script/, 'metric names are escaped');
});

test('charts tool refuses unlocked figures, then writes SVGs and charts.json with output_sha256', async () => {
  const root = tmpRoot(); const rt = rtFor(root);
  assert.match((await rt.call('urania_charts', { figures: 'figures.csv' })).reason, /lock the figures first/);
  await rt.call('urania_lock_figures', { figures: 'figures.csv' });
  const r = await rt.call('urania_charts', { figures: 'figures.csv', charts: ['variance', 'actual_vs_basis'] });
  assert.equal(r.status, 'executed'); assert.equal(r.decision, 'allow');
  assert.match(r.result.output_sha256, /^[0-9a-f]{64}$/);
  const index = JSON.parse(readFileSync(join(root, 'mythos-out/urania/charts/charts.json'), 'utf8'));
  assert.equal(index.charts.length, 2);
  for (const c of index.charts) {
    const svg = readFileSync(join(root, 'mythos-out/urania/charts', c.file), 'utf8');
    assert.deepEqual(svgPoints(svg), c.points); assert.deepEqual(tracePoints(c.points, figs()), []);
  }
  const bad = await rt.call('urania_charts', { figures: 'figures.csv', charts: ['pie'] });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments/);
  writeFileSync(join(root, 'figures.csv'), readFileSync(join(root, 'figures.csv'), 'utf8').replace('86000', '87000'));
  assert.match((await rt.call('urania_charts', { figures: 'figures.csv' })).reason, /changed since they were locked/);
});

test('prior-pack comparison flags restated figures and the sentences that cite them', () => {
  const r = comparePrior(figs(), priorFigs(), { docs: ['docs/ceo-letter.md', 'docs/ops-update.md'].map((p) => ({ path: p, text: readFileSync(join(fixtures, p), 'utf8') })) });
  assert.equal(r.prior_restated, 2); assert.deepEqual(r.affected_ids, ['F2', 'F3']);
  assert.deepEqual(r.changes.filter((x) => x.type === 'prior_restated').map((x) => [x.id, x.was, x.now, x.delta]), [['F2', 465000, 470000, 5000], ['F3', 715000, 710000, -5000]]);
  assert.equal(r.dropped_metrics, 1); assert.equal(r.changes.find((x) => x.type === 'dropped_metric').metric, 'Travel');
  assert.deepEqual(r.impact.map((x) => `${x.doc}:${x.line}`), ['docs/ops-update.md:3', 'docs/ops-update.md:5']);
  // Same period, changed value: a restatement. Id change for the same metric is listed too.
  const same = figs().map((v) => (v.id === 'F4' ? { ...v, actual: 309000 } : v.id === 'F5' ? { ...v, id: 'M5' } : v));
  const r2 = comparePrior(same, figs());
  assert.deepEqual(r2.changes.filter((x) => x.type === 'restated').map((x) => [x.id, x.field, x.delta]), [['F4', 'actual', -1000]]);
  assert.equal(r2.id_changes, 1); assert.equal(r2.prior_restated, 0);
  assert.equal(comparePrior(figs(), figs()).changes.length, 0, 'identical packs: no changes');
});

test('compare tool checks the prior manifest and validates it against the pack_manifest schema', async () => {
  const root = tmpRoot(); const rt = rtFor(root);
  const args = { figures: 'figures.csv', prior_figures: 'prior/figures-2026-09.csv', prior_manifest: 'prior/pack-manifest-2026-09.json' };
  const ok = await rt.call('urania_compare_prior', args);
  assert.equal(ok.status, 'executed'); assert.equal(ok.result.prior_pack.figures_match_manifest, true);
  writeFileSync(join(root, 'prior/figures-2026-09.csv'), readFileSync(join(root, 'prior/figures-2026-09.csv'), 'utf8').replace('298000', '299000'));
  const changed = await rt.call('urania_compare_prior', args);
  assert.equal(changed.result.prior_pack.figures_match_manifest, false); assert.match(changed.result.summary, /WARNING/);
  const good = JSON.parse(readFileSync(join(fixtures, 'prior/pack-manifest-2026-09.json'), 'utf8'));
  const mutated = {
    'unknown-key.json': [{ ...good, approved: true }, /\/approved is not an allowed property/],
    'wrong-type.json': [{ ...good, claims_issues: 'none' }, /\/claims_issues expected integer/],
    'missing-required.json': [(({ pack_sha256, ...rest }) => rest)(good), /\/pack_sha256 is required/],
  };
  for (const [name, [doc, re]] of Object.entries(mutated)) {
    writeFileSync(join(root, name), JSON.stringify(doc));
    const r = await rt.call('urania_compare_prior', { ...args, prior_manifest: name });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid pack_manifest/); assert.match(r.reason, re);
    assert.equal(validate(manifest.configSchemas.pack_manifest, doc).ok, false);
  }
  assert.equal(validate(manifest.configSchemas.pack_manifest, good).ok, true);
});

test('HTML pack: self-contained, charts inline, hash in the manifest, sign-off refuses a changed HTML', async () => {
  const root = tmpRoot(); const rt = rtFor(root);
  await rt.call('urania_lock_figures', { figures: 'figures.csv' });
  const p = await rt.call('urania_assemble_pack', { figures: 'figures.csv', docs: ['docs/cfo-notes.md'], html: true, title: 'Pack <b>' });
  assert.equal(p.status, 'executed'); assert.equal(p.result.output_sha256, p.result.pack_sha256);
  const mf = 'mythos-out/urania/pack-manifest.json'; const m = JSON.parse(readFileSync(join(root, mf), 'utf8'));
  const html = readFileSync(join(root, m.html), 'utf8');
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /<script/i); assert.match(html, /data-figure-id="F1"/);
  assert.match(html, /Pack &lt;b&gt;/); assert.match(html, /direction_mismatch/);
  assert.equal(validate(manifest.configSchemas.pack_manifest, m).ok, true, 'what we write passes our own schema');
  writeFileSync(join(root, m.html), html + '<!-- edited -->');
  const args = { pack_manifest: mf, pack_sha256: m.pack_sha256, controller: 'Casey', accept_open_issues: true, note: 'known' };
  const a = await rt.call('urania_record_signoff', args); rt.approvals.approve(a.approval_id, 'Casey');
  const s = await rt.call('urania_record_signoff', args);
  assert.equal(s.status, 'error'); assert.match(s.reason, /board-pack.html changed/);
});

test('MCP prompt walks the workflow and keeps the human clicks', () => {
  const p = manifest.prompts.find((x) => x.name === 'urania_board_pack');
  for (const t of ['urania_variance', 'urania_compare_prior', 'urania_lock_figures', 'urania_check_claims', 'urania_charts', 'urania_assemble_pack', 'urania_record_signoff', 'urania_request_distribution']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /one named human click/); assert.match(p.text, /\{\{figures\}\}/);
  for (const t of manifest.tools) if (['urania_charts', 'urania_compare_prior'].includes(t.name)) assert.ok(t.title);
});
