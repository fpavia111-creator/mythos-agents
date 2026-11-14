import { defineManifest } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { validateSuite, grade, compare, junit, reportMarkdown } from './grade.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const loadSuite = (ctx, p) => JSON.parse(readFileSync(ctx.path(p), 'utf8'));
const g = (ctx, suite, resp, label) => grade(suite, ctx.records(resp), { label });

export const manifest = defineManifest({
  name: 'agon-of-evals',
  version: pkg.version,
  description: 'Private, fixture-based evals for one business process and one pinned model. Grades responses you recorded (JSONL) against your suite, compares baseline vs candidate for regressions, and writes Markdown, JSON and JUnit. Calls no model and publishes nothing.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'agon_validate_suite', kind: 'read',
      description: 'Check a suite file: pinned model (no "latest"), unique case ids, known checks, valid regexes.',
      inputSchema: { type: 'object', required: ['suite'], properties: { suite: str } },
      handler: async (a, ctx) => { const v = validateSuite(loadSuite(ctx, a.suite)); return { summary: v.ok ? `Suite valid: ${v.cases} case(s), model ${v.model.id}.` : `Suite has ${v.errors.length} error(s).`, ...v }; },
    },
    {
      name: 'agon_grade', kind: 'read',
      description: 'Grade recorded responses (JSONL/CSV/JSON: case_id, output, tool_calls, model) against the suite. Responses from a different model are marked not comparable.',
      inputSchema: { type: 'object', required: ['suite', 'responses'], properties: { suite: str, responses: str, label: str } },
      handler: async (a, ctx) => { const r = g(ctx, loadSuite(ctx, a.suite), a.responses, a.label); if (r.error) throw new Error(`${r.error}: ${r.validation.errors.join('; ')}`); return { summary: `${r.passed}/${r.cases} passed (${r.score}%). ${r.comparable ? 'Comparable to the pin.' : 'NOT comparable: ' + r.comparability_note}`, ...r }; },
    },
    {
      name: 'agon_compare', kind: 'read',
      description: 'Compare a baseline and a candidate run on the same suite: regressions, fixes, score delta, and whether the runs are comparable.',
      inputSchema: { type: 'object', required: ['suite', 'baseline', 'candidate'], properties: { suite: str, baseline: str, candidate: str } },
      handler: async (a, ctx) => {
        const s = loadSuite(ctx, a.suite); const b = g(ctx, s, a.baseline, 'baseline'); const c = g(ctx, s, a.candidate, 'candidate');
        if (b.error || c.error) throw new Error('suite invalid');
        const r = compare(b, c);
        return { summary: `${r.baseline_score}% → ${r.candidate_score}%: ${r.regressions.length} regression(s), ${r.fixes.length} fix(es); ${r.verdict.replace(/_/g, ' ')}.`, ...r };
      },
    },
    {
      name: 'agon_write_report', kind: 'report',
      description: 'Write eval-report.md, eval-results.json and junit.xml (for CI) into out_dir (default mythos-out/agon). Optional baseline adds a regression section.',
      inputSchema: { type: 'object', required: ['suite', 'responses'], properties: { suite: str, responses: str, baseline: str, out_dir: str } },
      handler: async (a, ctx) => {
        const s = loadSuite(ctx, a.suite); const r = g(ctx, s, a.responses, 'candidate'); if (r.error) throw new Error('suite invalid');
        const cmp = a.baseline ? compare(g(ctx, s, a.baseline, 'baseline'), r) : null;
        const out = ctx.outDir(a.out_dir || 'mythos-out/agon');
        const files = [ctx.writeFile(out, 'eval-report.md', reportMarkdown(r, cmp, new Date().toISOString())), ctx.writeFile(out, 'eval-results.json', JSON.stringify({ grade: r, compare: cmp }, null, 2)), ctx.writeFile(out, 'junit.xml', junit(r))];
        return { summary: `Report written: ${r.score}%${cmp ? `, ${cmp.regressions.length} regression(s)` : ''}.`, files, score: r.score, comparable: r.comparable };
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
    { tool: 'agon_write_report', decision: 'allow' },
    { tool: 'agon_publish_results', decision: 'block', reason: 'Eval results stay private; Agon never publishes them.' },
    { tool: '*', decision: 'block', reason: 'Not on the Agon allowlist.' },
  ] },
});
