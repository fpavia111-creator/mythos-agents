import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, validate, readAudit, createMcpHandler, readRecords } from 'mythos-agent-core';
import { manifest, grade, compare, scoreDeltaCI, applyGate, fisherLower, signTest, prng, gradeRubric, dashboardHtml, wilson, runChecks } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const json = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const recs = (f) => readRecords(join(fixtures, f));
const suite = json('suite.json');
const M = suite.model.id;
const run = (f) => grade(suite, recs(f));

// ---- trials ----
test('trials: several responses per case give pass rates, flaky cases and a threshold', () => {
  const g = run('trials-baseline.jsonl');
  const po = g.results.find((r) => r.id === 'cites-po');
  assert.deepEqual([po.trials, po.passes, po.pass_rate, po.flaky, po.pass], [5, 4, 0.8, true, true]);
  assert.match(po.failures[0], /\(1\/5 trials\)/);
  assert.deepEqual(g.trials.flaky_cases, ['cites-po']);
  assert.equal(g.score, 96.67); assert.equal(g.passed, 6);
  const strict = grade({ ...suite, pass_threshold: 1 }, recs('trials-baseline.jsonl'));
  assert.equal(strict.results.find((r) => r.id === 'cites-po').pass, false);
  const single = run('baseline.jsonl');
  assert.equal(single.trials, null); assert.equal(single.score, 83.33);
  assert.deepEqual(single.by_tag.facts, { cases: 3, passed: 2, pass_pct: 66.67 });
  assert.deepEqual(run('candidate.jsonl').critical_failures, ['no-bank-change']);
});

// ---- statistics ----
test('statistics: noise below the threshold is not flagged; a seeded regression is', () => {
  const base = run('trials-baseline.jsonl');
  const noise = scoreDeltaCI(base, run('trials-candidate-noise.jsonl'));
  assert.equal(noise.verdict, 'within_noise'); assert.equal(noise.significant, false);
  assert.ok(noise.ci_low < 0 && noise.ci_high > 0);
  assert.deepEqual(noise.significant_case_regressions, []); assert.deepEqual(noise.within_noise_cases, ['short-answer']);
  const reg = scoreDeltaCI(base, run('trials-candidate-regressed.jsonl'));
  assert.equal(reg.verdict, 'regression'); assert.ok(reg.ci_high < 0);
  assert.equal(reg.delta, -16.67); assert.deepEqual(reg.significant_case_regressions, ['no-bank-change']);
  assert.equal(reg.per_case.find((p) => p.id === 'no-bank-change').p_value, 0.004);
  assert.match(reg.method, /stratified bootstrap over trials/);
});
test('statistics: seeded and reproducible; min_delta; single-trial runs use a paired bootstrap', () => {
  const base = run('trials-baseline.jsonl'), cand = run('trials-candidate-regressed.jsonl');
  assert.deepEqual(scoreDeltaCI(base, cand, { seed: 7 }), scoreDeltaCI(base, cand, { seed: 7 }));
  assert.equal(scoreDeltaCI(base, cand, { min_delta: 50 }).verdict, 'within_noise', 'a drop smaller than min_delta is not a regression');
  const a = prng(42), b = prng(42); assert.equal(a(), b()); assert.notEqual(prng(1)(), prng(2)());
  const single = scoreDeltaCI(run('baseline.jsonl'), run('candidate.jsonl'));
  assert.match(single.method, /paired bootstrap over cases/); assert.equal(single.verdict, 'within_noise'); assert.equal(single.sign_test_p, 1);
  assert.match(single.note, /6 cases/);
  // 40 cases, 12 flip to fail: clearly below zero even with one response per case
  const big = { suite: 'big', model: { id: M }, cases: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, checks: { contains: 'ok' } })) };
  const all = big.cases.map((c) => ({ case_id: c.id, model: M, output: 'ok' }));
  const worse = all.map((r, i) => (i < 12 ? { ...r, output: 'no' } : r));
  const s = scoreDeltaCI(grade(big, all), grade(big, worse));
  assert.equal(s.verdict, 'regression'); assert.ok(s.sign_test_p < 0.001);
  assert.equal(scoreDeltaCI(grade(big, all), grade(big, all)).verdict, 'within_noise');
});
test('exact tests and Wilson interval', () => {
  assert.ok(Math.abs(fisherLower(5, 5, 0, 5) - 1 / 252) < 1e-9);
  assert.equal(fisherLower(5, 5, 5, 5), 1);
  assert.equal(signTest(0, 0), 1); assert.ok(Math.abs(signTest(6, 0) - 0.03125) < 1e-9);
  assert.deepEqual(wilson(5, 6), [43.65, 96.99]);
});

// ---- gate ----
test('gate: critical cases, min score, flaky limit and significant-regression mode', () => {
  const gate = json('gate.json');
  const base = run('trials-baseline.jsonl');
  const ok = run('trials-candidate-noise.jsonl');
  assert.equal(applyGate(gate, ok, compare(base, ok, { stats: scoreDeltaCI(base, ok, gate) })).result, 'pass');
  const bad = run('trials-candidate-regressed.jsonl');
  const r = applyGate(gate, bad, compare(base, bad, { stats: scoreDeltaCI(base, bad, gate) }));
  assert.equal(r.result, 'fail'); assert.match(r.reasons.join('|'), /must-pass case\(s\) failing: no-bank-change/); assert.match(r.reasons.join('|'), /interval .* is below zero/);
  assert.match(applyGate({ min_score: 99 }, ok).reasons[0], /score 96\.67 < 99/);
  assert.match(applyGate({ max_flaky: 0 }, ok).reasons[0], /1 flaky/);
  assert.match(applyGate({}, grade(suite, recs('other-model.jsonl'))).reasons[0], /not comparable/);
  const s1 = run('baseline.jsonl'), s2 = run('candidate.jsonl');
  assert.match(applyGate({}, s2, compare(s1, s2)).reasons.join('|'), /1 regression\(s\) > 0: no-bank-change/);
});

// ---- rubric ----
test('rubric: every grade cites the rubric item and its evidence', () => {
  const r = gradeRubric(json('rubric.json'), suite, recs('baseline.jsonl'), recs('judgments.jsonl'));
  const ids = new Set(json('rubric.json').criteria.map((c) => c.id));
  for (const c of r.results) for (const k of c.criteria) {
    assert.ok(ids.has(k.criterion), `${c.id}: cites ${k.criterion}`); assert.ok(k.text.length > 3);
    assert.ok(k.evidence?.quote || k.reason, `${c.id}/${k.criterion} has evidence or a reason`);
  }
  const bank = r.results.find((c) => c.id === 'no-bank-change');
  assert.deepEqual(bank.criteria.map((k) => `${k.criterion}:${k.earned}/${k.points}`), ['R2:3/3', 'R3:2/2', 'R5:2/2']);
  assert.match(bank.criteria[0].evidence.quote, /verify by phone/);
  assert.equal(bank.criteria[2].source, 'judgment'); assert.equal(bank.criteria[2].evidence.verified, true);
  assert.deepEqual([r.earned, r.possible, r.score], [14, 16, 87.5]);
});
test('rubric: unverified quotes earn nothing, unknown criteria are rejected, missing judgments are pending', () => {
  const r = gradeRubric(json('rubric.json'), suite, recs('baseline.jsonl'), recs('judgments.jsonl'));
  const short = r.results.find((c) => c.id === 'short-answer').criteria[0];
  assert.equal(short.status, 'citation_not_found'); assert.equal(short.earned, 0); assert.equal(r.unverified_citations, 1);
  assert.deepEqual(r.rejected_judgments, [{ case_id: 'cites-po', criterion: 'R9', reason: 'cites a criterion that is not in the rubric' }]);
  const none = gradeRubric(json('rubric.json'), suite, recs('baseline.jsonl'), []);
  assert.equal(none.pending, 2); assert.equal(none.possible, 12, 'pending criteria are left out of the score');
  const cand = gradeRubric(json('rubric.json'), suite, recs('candidate.jsonl'), []);
  const k = cand.results.find((c) => c.id === 'no-bank-change').criteria[0];
  assert.equal(k.status, 'not_met'); assert.match(k.reason, /expected a refusal/);
  assert.throws(() => gradeRubric({ rubric: 'x', criteria: [{ id: 'A', text: 'both', points: 1, checks: { contains: 'a' }, judged: true }] }, suite, [], []), /exactly one of/);
});

// ---- new check kinds ----
test('checks: json_schema, tool_order, tool_args, max_tool_calls', () => {
  const g = grade(json('suite-agent.json'), recs('agent-run.jsonl'));
  assert.deepEqual(g.results.map((r) => r.pass), [true, true, true, false, false]);
  assert.match(g.results[3].failures[0], /no lookup_invoice call with invoice_id="INV-1005"/);
  assert.match(g.results[4].failures[0], /1 tool calls > 0/);
  const schema = { type: 'object', required: ['total'], properties: { total: { type: 'number' } } };
  assert.deepEqual(runChecks({ json_schema: schema }, { output: 'not json' }).fails, ['output is not valid JSON']);
  assert.deepEqual(runChecks({ json_schema: schema }, { output: '{"total":"12"}' }).fails, ['JSON /total expected number, got string']);
  assert.match(runChecks({ tool_order: ['a', 'b'] }, { output: '', tool_calls: ['b', 'a'] }).fails[0], /not called in order a > b/);
  assert.deepEqual(runChecks({ tool_order: ['a', 'b'] }, { output: '', tool_calls: '["a","x","b"]' }).fails, []);
});

// ---- dashboard ----
test('dashboard: self-contained HTML, zero network references, regression highlighted, deterministic', async () => {
  const root = tmpRoot('agon2-d-');
  const rt = new AgentRuntime(manifest, { root });
  const args = { suite: 'suite.json', runs: ['trials-baseline.jsonl', 'trials-candidate-noise.jsonl', 'trials-candidate-regressed.jsonl'], labels: ['v1', 'v2', 'v3 <script>alert(1)</script>'], gate: 'gate.json' };
  const d = await rt.call('agon_write_dashboard', args);
  assert.equal(d.status, 'executed'); assert.deepEqual(d.result.regressions, ['no-bank-change']); assert.equal(d.result.gate.result, 'fail');
  const html = readFileSync(d.result.files[0], 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  for (const re of [/<script/i, /<link/i, /<img/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /https?:\/\//i, /url\(/i, /@import/i, /\ssrc=/i, /\shref=/i, /\son\w+=/i]) assert.ok(!re.test(html), `no ${re}`);
  assert.ok(html.includes('v3 &lt;script&gt;'), 'labels are escaped');
  assert.match(html, /REGRESSED/); assert.match(html, /significant regression/); assert.match(html, /flaky/);
  const again = await rt.call('agon_write_dashboard', { ...args, out_dir: 'again' });
  assert.equal(again.result.output_sha256, d.result.output_sha256, 'same runs, same bytes');
  assert.equal(readAudit(join(root, '.mythos', 'audit.jsonl')).find((e) => e.tool === 'agon_write_dashboard').output_sha256, d.result.output_sha256);
  const one = dashboardHtml(suite, [{ label: 'only', grade: run('baseline.jsonl') }]);
  assert.ok(!/REGRESSED/.test(one));
  assert.equal((await rt.call('agon_write_dashboard', { suite: 'suite.json', runs: ['baseline.jsonl'], labels: ['a', 'b'] })).status, 'error');
});

// ---- report ----
test('write_report: statistics, rubric, gate and audit hash; original three files kept', async () => {
  const root = tmpRoot('agon2-r-');
  const rt = new AgentRuntime(manifest, { root });
  const w = await rt.call('agon_write_report', { suite: 'suite.json', responses: 'trials-candidate-regressed.jsonl', baseline: 'trials-baseline.jsonl', gate: 'gate.json', rubric: 'rubric.json', judgments: 'judgments.jsonl' });
  assert.equal(w.status, 'executed'); assert.equal(w.result.files.length, 3); assert.equal(w.result.gate.result, 'fail'); assert.equal(w.result.stat_verdict, 'regression');
  const md = readFileSync(w.result.files[0], 'utf8');
  for (const s of ['- Statistics: regression', '- Gate: **fail**', '## Rubric: ap-answer-quality-v1', 'Critical cases failing', '| safety | 1/2 | 50 |']) assert.ok(md.includes(s), s);
  const j = JSON.parse(readFileSync(w.result.files[1], 'utf8'));
  assert.equal(j.compare.stats.seed, 7); assert.equal(j.rubric.rubric, 'ap-answer-quality-v1');
  assert.match(readFileSync(w.result.files[2], 'utf8'), /failures="1"/);
  assert.equal(readAudit(join(root, '.mythos', 'audit.jsonl')).find((e) => e.tool === 'agon_write_report').output_sha256, w.result.output_sha256);
  const c = await rt.call('agon_compare', { suite: 'suite.json', baseline: 'trials-baseline.jsonl', candidate: 'trials-candidate-noise.jsonl', gate: 'gate.json' });
  assert.equal(c.result.gate.result, 'pass'); assert.equal(c.result.stats.verdict, 'within_noise');
  assert.equal((await rt.call('agon_publish_results', {})).status, 'blocked');
});

// ---- config schemas ----
test('config schemas: fixtures validate; mutated suite, rubric and gate fail with JSON pointers', async () => {
  const s = manifest.configSchemas;
  for (const [name, f] of [['agon-suite', 'suite.json'], ['agon-suite', 'suite-agent.json'], ['agon-rubric', 'rubric.json'], ['agon-gate', 'gate.json']]) assert.deepEqual(validate(s[name], json(f)).errors, [], f);
  const root = tmpRoot('agon2-cfg-');
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const { model, ...noModel } = suite;
  const mutants = {
    'unknown.json': [{ ...suite, modle: 'x' }, '/modle'],
    'type.json': [{ ...suite, cases: [{ ...suite.cases[0], weight: '2' }] }, '/cases/0/weight'],
    'missing.json': [noModel, '/model'],
    'check-typo.json': [{ ...suite, cases: [{ id: 'a', checks: { contain: 'x' } }] }, '/cases/0/checks/contain'],
  };
  for (const [f, [cfg, ptr]] of Object.entries(mutants)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const v = validate(s['agon-suite'], cfg); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => e.path === ptr), `${f}: ${JSON.stringify(v.errors)}`);
    const r = await rt.call('agon_grade', { suite: f, responses: 'baseline.jsonl' });
    assert.equal(r.status, 'error', f); assert.ok(JSON.stringify(r).includes(ptr), `${f} names ${ptr}`);
    const val = await rt.call('agon_validate_suite', { suite: f });
    assert.equal(val.status, 'executed'); assert.equal(val.result.ok, false); assert.ok(val.result.errors.some((e) => e.startsWith(ptr)), `${f} validate lists ${ptr}`);
  }
  writeFileSync(join(root, 'bad-gate.json'), JSON.stringify({ min_score: '80', fail_on: 'vibes', extra: 1 }));
  const g = await rt.call('agon_grade', { suite: 'suite.json', responses: 'baseline.jsonl', gate: 'bad-gate.json' });
  assert.equal(g.status, 'error'); for (const p of ['/min_score', '/fail_on', '/extra']) assert.ok(JSON.stringify(g).includes(p), p);
  writeFileSync(join(root, 'bad-rubric.json'), JSON.stringify({ rubric: 'r', criteria: [{ id: 'A', text: 'no points', checks: { contains: 'x' } }] }));
  const rb = await rt.call('agon_grade_rubric', { suite: 'suite.json', rubric: 'bad-rubric.json', responses: 'baseline.jsonl' });
  assert.equal(rb.status, 'error'); assert.ok(JSON.stringify(rb).includes('/criteria/0/points'));
});

// ---- prompt ----
test('MCP prompt covers the workflow and the human decision', async () => {
  const p = manifest.prompts[0];
  for (const t of ['agon_validate_suite', 'agon_grade', 'agon_compare', 'agon_grade_rubric', 'agon_write_report', 'agon_write_dashboard', 'never invent judgments', 'A person decides']) assert.ok(p.text.includes(t), t);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: tmpRoot('agon2-p-'), audit: false }));
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'agon_eval_run', arguments: { suite: 'suite.json', candidate: 'candidate.jsonl' } } });
  assert.match(r.result.messages[0].content.text, /suite "suite\.json"/);
  const missing = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'agon_eval_run', arguments: { suite: 'suite.json' } } });
  assert.ok(missing.error);
});
