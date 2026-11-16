import { defineManifest, validate, sha256 } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { validateSuite, grade, compare, junit, reportMarkdown } from './grade.js';
import { scoreDeltaCI, applyGate, GATE_SCHEMA } from './stats.js';
import { gradeRubric, SUITE_SCHEMA, RUBRIC_SCHEMA } from './rubric.js';
import { dashboardHtml } from './dashboard.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const P = {
  suite: { ...str, description: 'Suite JSON (schema agon-suite): process, pinned model id, cases with checks' },
  responses: { ...str, description: 'Recorded responses (JSONL/CSV/JSON): case_id, output, tool_calls, model. Several rows per case are trials.' },
  baseline: { ...str, description: 'Recorded responses of the baseline run' },
  gate: { ...str, description: 'Gate JSON (schema agon-gate): min_score, max_regressions or fail_on significant_regression, must_pass, max_flaky' },
  rubric: { ...str, description: 'Rubric JSON (schema agon-rubric): criteria with points, graded by checks or by recorded judgments' },
  judgments: { ...str, description: 'Recorded judgments (JSONL/CSV/JSON) for judged criteria: case_id, criterion, score 0..1, quote, rationale, judge' },
  resamples: { type: 'integer', minimum: 100, maximum: 20000, description: 'Bootstrap resamples (default 2000)' },
  seed: { type: 'integer', minimum: 0, description: 'Bootstrap seed (default 1); the same seed gives the same interval' },
  confidence: { type: 'number', exclusiveMinimum: 0.5, exclusiveMaximum: 1, description: 'Confidence level (default 0.95)' },
  min_delta: { type: 'number', minimum: 0, description: 'Ignore score drops smaller than this many points (default 0)' },
};
const loadSuite = (ctx, p) => ctx.readJson(p, 'agon-suite');
function g(ctx, suite, resp, label) {
  const r = grade(suite, ctx.records(resp), { label });
  if (r.error) throw new Error(`${r.error}: ${r.validation.errors.join('; ')}`);
  return r;
}
const statOpts = (a, gate) => ({ resamples: a.resamples ?? gate?.resamples, seed: a.seed ?? gate?.seed, confidence: a.confidence ?? gate?.confidence, min_delta: a.min_delta ?? gate?.min_delta });
const loadGate = (ctx, a) => (a.gate ? ctx.readJson(a.gate, 'agon-gate') : null);
const loadRubric = (ctx, a, suite) => (a.rubric ? gradeRubric(ctx.readJson(a.rubric, 'agon-rubric'), suite, ctx.records(a.responses || a.candidate), a.judgments ? ctx.records(a.judgments) : []) : null);
function compared(ctx, suite, basePath, cand, a, gate) {
  const base = g(ctx, suite, basePath, 'baseline');
  return compare(base, cand, { stats: scoreDeltaCI(base, cand, statOpts(a, gate)) });
}

const PROMPT = `You are running a private eval with Agon of Evals. Agon grades responses that were already recorded; it calls no model and publishes nothing. Work only with files under its --root.

1. Call agon_validate_suite with suite "{{suite}}". Fix every error before going on (errors carry a JSON-pointer path). The suite must pin an exact model id.
2. Call agon_grade with the suite and responses "{{candidate}}". If "comparable" is false, stop and tell the user: the responses do not carry the pinned model id, so the score cannot be compared with earlier runs.
3. If a baseline exists ("{{baseline}}"), call agon_compare with baseline and candidate. Read "stats": report the score change with its interval, name each case in significant_case_regressions, and say which drops are within noise. With one response per case, say the interval is wide and suggest recording several trials.
4. If the user has a rubric, call agon_grade_rubric. For every grade quote the criterion id and the evidence. Judged criteria need a judgments file that a person or the user's own judge produced; never invent judgments. Report citation_not_found and pending items as they are.
5. Call agon_write_report (with gate "{{gate}}" if one was given) for Markdown, JSON and JUnit, and agon_write_dashboard with the runs oldest first for the offline HTML page.
6. A person decides whether to ship. Do not try to publish scores (agon_publish_results is blocked). Say plainly that a score covers this suite and this pinned model only.`;

export const manifest = defineManifest({
  name: 'agon-of-evals',
  version: pkg.version,
  description: 'Private, fixture-based evals for one business process and one pinned model. Grades responses you recorded (JSONL) against your suite, including repeated trials; compares baseline vs candidate with seeded bootstrap confidence intervals; grades rubrics with cited criteria; applies a CI gate; and writes Markdown, JSON, JUnit and an offline HTML dashboard. Calls no model and publishes nothing.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { 'agon-suite': SUITE_SCHEMA, 'agon-rubric': RUBRIC_SCHEMA, 'agon-gate': GATE_SCHEMA },
  prompts: [{
    name: 'agon_eval_run', title: 'Grade a run and check for regressions',
    description: 'Walks the host model through a private eval: validate the suite, grade the recorded run, compare with a baseline using confidence intervals, grade the rubric with citations, write the report and dashboard, and leave the ship decision to a person.',
    arguments: [
      { name: 'suite', description: 'Suite JSON under --root', required: true },
      { name: 'candidate', description: 'Recorded responses of the run to grade', required: true },
      { name: 'baseline', description: 'Recorded responses of the earlier run (optional)', required: false },
      { name: 'gate', description: 'Gate JSON (optional)', required: false },
    ],
    text: PROMPT,
  }],
  tools: [
    {
      name: 'agon_validate_suite', kind: 'read', title: 'Validate a suite',
      description: 'Check a suite file against the agon-suite schema (JSON-pointer errors) and the suite rules: pinned model (no "latest"), unique case ids, known checks, valid regexes.',
      inputSchema: { type: 'object', required: ['suite'], additionalProperties: false, properties: { suite: P.suite } },
      handler: async (a, ctx) => {
        const json = ctx.readJson(a.suite);
        const v = validateSuite(json);
        const schema = validate(SUITE_SCHEMA, json);
        const errors = [...v.errors, ...schema.errors.map((e) => `${e.path} ${e.message}`)];
        return { ...v, ok: errors.length === 0, errors, summary: errors.length ? `Suite has ${errors.length} error(s).` : `Suite valid: ${v.cases} case(s), model ${v.model.id}.` };
      },
    },
    {
      name: 'agon_grade', kind: 'read', title: 'Grade a recorded run',
      description: 'Grade recorded responses (JSONL/CSV/JSON: case_id, output, tool_calls, model) against the suite. Several rows per case are trials (pass rate, flaky cases). Reports per-tag results, critical failures and a 95% interval. Responses from a different model are marked not comparable.',
      inputSchema: { type: 'object', required: ['suite', 'responses'], additionalProperties: false, properties: { suite: P.suite, responses: P.responses, label: str, gate: P.gate } },
      handler: async (a, ctx) => {
        const r = g(ctx, loadSuite(ctx, a.suite), a.responses, a.label);
        const gate = loadGate(ctx, a);
        return { summary: `${r.passed}/${r.cases} passed (${r.score}%). ${r.comparable ? 'Comparable to the pin.' : 'NOT comparable: ' + r.comparability_note}`, ...r, ...(gate ? { gate: applyGate(gate, r) } : {}) };
      },
    },
    {
      name: 'agon_compare', kind: 'read', title: 'Compare baseline and candidate',
      description: 'Compare a baseline and a candidate run on the same suite: regressions, fixes, score delta, whether the runs are comparable, and "stats": a seeded bootstrap confidence interval on the score change with a regression / improvement / within-noise verdict and per-case tests when trials were recorded.',
      inputSchema: { type: 'object', required: ['suite', 'baseline', 'candidate'], additionalProperties: false, properties: { suite: P.suite, baseline: P.baseline, candidate: { ...P.responses, description: 'Recorded responses of the candidate run' }, gate: P.gate, resamples: P.resamples, seed: P.seed, confidence: P.confidence, min_delta: P.min_delta } },
      handler: async (a, ctx) => {
        const s = loadSuite(ctx, a.suite); const gate = loadGate(ctx, a);
        const c = g(ctx, s, a.candidate, 'candidate');
        const r = compared(ctx, s, a.baseline, c, a, gate);
        return { summary: `${r.baseline_score}% → ${r.candidate_score}%: ${r.regressions.length} regression(s), ${r.fixes.length} fix(es); ${r.verdict.replace(/_/g, ' ')}. Statistics: ${r.stats.verdict.replace(/_/g, ' ')} (${Math.round(r.stats.confidence * 100)}% interval ${r.stats.ci_low} to ${r.stats.ci_high}).`, ...r, ...(gate ? { gate: applyGate(gate, c, r) } : {}) };
      },
    },
    {
      name: 'agon_grade_rubric', kind: 'read', title: 'Grade against a rubric with citations',
      description: 'Grade recorded responses against a rubric. Every grade cites the rubric criterion (id and text) and the evidence: the matched text for check-based criteria, or the verified quote from a recorded judgment for judged criteria. Judgments that cite an unknown criterion or quote text that is not in the output are rejected. Calls no model.',
      inputSchema: { type: 'object', required: ['suite', 'rubric', 'responses'], additionalProperties: false, properties: { suite: P.suite, rubric: P.rubric, responses: P.responses, judgments: P.judgments } },
      handler: async (a, ctx) => {
        const r = loadRubric(ctx, a, loadSuite(ctx, a.suite));
        return { summary: `Rubric ${r.rubric}: ${r.earned}/${r.possible} points (${r.score}%), ${r.passed}/${r.cases} case(s) at or above ${r.pass_score}%; ${r.pending} pending, ${r.unverified_citations} citation(s) not found.`, ...r };
      },
    },
    {
      name: 'agon_write_report', kind: 'report', title: 'Write Markdown, JSON and JUnit',
      description: 'Write eval-report.md, eval-results.json and junit.xml (for CI) into out_dir (default mythos-out/agon). Optional baseline adds regressions and statistics; optional rubric adds cited rubric grades; optional gate adds a pass/fail result. The results hash is recorded in the audit log.',
      inputSchema: { type: 'object', required: ['suite', 'responses'], additionalProperties: false, properties: { suite: P.suite, responses: P.responses, baseline: P.baseline, gate: P.gate, rubric: P.rubric, judgments: P.judgments, out_dir: str, resamples: P.resamples, seed: P.seed, confidence: P.confidence, min_delta: P.min_delta } },
      handler: async (a, ctx) => {
        const s = loadSuite(ctx, a.suite); const gateCfg = loadGate(ctx, a);
        const r = g(ctx, s, a.responses, 'candidate');
        const cmp = a.baseline ? compared(ctx, s, a.baseline, r, a, gateCfg) : null;
        const rubric = loadRubric(ctx, a, s);
        const gate = gateCfg ? applyGate(gateCfg, r, cmp, rubric) : null;
        const out = ctx.outDir(a.out_dir || 'mythos-out/agon');
        const json = JSON.stringify({ grade: r, compare: cmp, rubric, gate }, null, 2);
        const files = [ctx.writeFile(out, 'eval-report.md', reportMarkdown(r, cmp, new Date().toISOString(), { gate, rubric })), ctx.writeFile(out, 'eval-results.json', json), ctx.writeFile(out, 'junit.xml', junit(r))];
        return { summary: `Report written: ${r.score}%${cmp ? `, ${cmp.regressions.length} regression(s), ${cmp.stats.verdict.replace(/_/g, ' ')}` : ''}${gate ? `, gate ${gate.result}` : ''}.`, files, score: r.score, comparable: r.comparable, ...(cmp ? { stat_verdict: cmp.stats.verdict } : {}), ...(gate ? { gate } : {}), output_sha256: sha256(json) };
      },
    },
    {
      name: 'agon_write_dashboard', kind: 'report', title: 'Write the offline HTML dashboard',
      description: 'Write dashboard.html (and dashboard.json) into out_dir (default mythos-out/agon): score trend across runs, a case-by-run grid with regressions and fixes highlighted, flaky and critical cases, per-tag results and the statistics for the last two runs. One self-contained file: inline CSS, no scripts, no network requests.',
      inputSchema: { type: 'object', required: ['suite', 'runs'], additionalProperties: false, properties: { suite: P.suite, runs: { type: 'array', minItems: 1, maxItems: 24, items: str, description: 'Recorded response files, oldest first' }, labels: { type: 'array', items: str, description: 'A label per run (default: file names)' }, gate: P.gate, rubric: P.rubric, judgments: P.judgments, out_dir: str, resamples: P.resamples, seed: P.seed, confidence: P.confidence, min_delta: P.min_delta } },
      handler: async (a, ctx) => {
        if (a.labels && a.labels.length !== a.runs.length) throw new Error('labels must have one entry per run');
        const s = loadSuite(ctx, a.suite); const gateCfg = loadGate(ctx, a);
        const runs = a.runs.map((p, i) => ({ label: a.labels ? a.labels[i] : p.split(/[\\/]/).pop().replace(/\.(jsonl?|csv)$/i, ''), grade: g(ctx, s, p, a.labels ? a.labels[i] : null) }));
        const last = runs[runs.length - 1].grade; const prev = runs.length > 1 ? runs[runs.length - 2].grade : null;
        const stats = prev ? scoreDeltaCI(prev, last, statOpts(a, gateCfg)) : null;
        const cmp = prev ? compare(prev, last, { stats }) : null;
        const rubric = a.rubric ? gradeRubric(ctx.readJson(a.rubric, 'agon-rubric'), s, ctx.records(a.runs[a.runs.length - 1]), a.judgments ? ctx.records(a.judgments) : []) : null;
        const gate = gateCfg ? applyGate(gateCfg, last, cmp, rubric) : null;
        const html = dashboardHtml(s, runs, { stats, gate, rubric });
        const json = JSON.stringify({ suite: s.suite, pinned_model: s.model.id, runs: runs.map((r) => ({ label: r.label, score: r.grade.score, passed: r.grade.passed, cases: r.grade.cases, comparable: r.grade.comparable, results: r.grade.results.map(({ id, pass, passes, trials }) => ({ id, pass, passes, trials })) })), compare: cmp, gate }, null, 2) + '\n';
        const out = ctx.outDir(a.out_dir || 'mythos-out/agon');
        const files = [ctx.writeFile(out, 'dashboard.html', html), ctx.writeFile(out, 'dashboard.json', json)];
        return { summary: `Dashboard written: ${runs.length} run(s), latest ${last.score}%${cmp ? `, ${cmp.regressions.length} regression(s) vs previous` : ''}.`, files, runs: runs.length, latest_score: last.score, regressions: cmp ? cmp.regressions.map((r) => r.id) : [], ...(gate ? { gate } : {}), output_sha256: sha256(html) };
      },
    },
    {
      name: 'agon_publish_results', kind: 'action', category: 'binding_send',
      description: 'Listed so agents can see it is refused. Agon keeps results private; it never posts scores to a leaderboard or shares them.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'agon_validate_suite', decision: 'allow' },
    { tool: 'agon_grade', decision: 'allow' },
    { tool: 'agon_compare', decision: 'allow' },
    { tool: 'agon_grade_rubric', decision: 'allow' },
    { tool: 'agon_write_report', decision: 'allow' },
    { tool: 'agon_write_dashboard', decision: 'allow' },
    { tool: 'agon_publish_results', decision: 'block', reason: 'Eval results stay private; Agon never publishes them.' },
    { tool: '*', decision: 'block', reason: 'Not on the Agon allowlist.' },
  ] },
});
