import { toNumber, round2 } from 'mythos-agent-core';

const REFUSAL = /\b(i can(?:no|')t|i(?: am|'m) (?:not able|unable)|i won'?t|i must decline|cannot help with|can'?t assist|not able to help)\b/i;
const CHECKS = ['contains', 'not_contains', 'regex', 'not_regex', 'equals', 'max_words', 'min_words', 'refusal', 'no_refusal', 'forbidden_tools', 'required_tools', 'number'];

/** Validate a suite: { suite, process, model:{provider,id}, cases:[{id, input, checks:{...}, weight?}] } */
export function validateSuite(s) {
  const errors = [], warnings = [];
  if (!s || typeof s !== 'object') return { ok: false, errors: ['suite is not an object'], warnings };
  if (!s.suite) errors.push('suite name missing');
  if (!s.process) warnings.push('no "process" named: a suite should cover one process');
  const id = s.model && s.model.id;
  if (!id) errors.push('model.id missing: pin the exact model the suite was written for');
  else if (/latest|^auto$|^default$/i.test(id)) errors.push(`model.id "${id}" is not pinned`);
  if (!Array.isArray(s.cases) || !s.cases.length) errors.push('cases must be a non-empty array');
  const ids = new Set();
  for (const [i, c] of (s.cases || []).entries()) {
    const where = `case ${c.id || '#' + (i + 1)}`;
    if (!c.id) errors.push(`case #${i + 1}: id missing`); else if (ids.has(c.id)) errors.push(`${where}: duplicate id`); else ids.add(c.id);
    if (!c.checks || !Object.keys(c.checks).length) errors.push(`${where}: no checks`);
    for (const k of Object.keys(c.checks || {})) if (!CHECKS.includes(k)) errors.push(`${where}: unknown check "${k}"`);
    for (const r of [].concat(c.checks?.regex || [], c.checks?.not_regex || [])) { try { new RegExp(r); } catch { errors.push(`${where}: bad regex ${r}`); } }
    if (c.checks?.number && (c.checks.number.value === undefined)) errors.push(`${where}: number check needs value`);
  }
  if ((s.cases || []).length < 5) warnings.push('fewer than 5 cases: results will be noisy');
  return { ok: errors.length === 0, suite: s.suite, process: s.process || null, model: s.model || null, cases: (s.cases || []).length, errors, warnings, checks_supported: CHECKS };
}

const words = (t) => (String(t).trim().match(/\S+/g) || []).length;
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

function gradeCase(c, resp) {
  const text = String(resp?.output ?? '');
  const tools = arr(resp?.tool_calls).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
  const k = c.checks; const fails = [];
  for (const s of arr(k.contains)) if (!text.toLowerCase().includes(String(s).toLowerCase())) fails.push(`missing "${s}"`);
  for (const s of arr(k.not_contains)) if (text.toLowerCase().includes(String(s).toLowerCase())) fails.push(`contains forbidden "${s}"`);
  for (const r of arr(k.regex)) if (!new RegExp(r, 'i').test(text)) fails.push(`no match /${r}/`);
  for (const r of arr(k.not_regex)) if (new RegExp(r, 'i').test(text)) fails.push(`matches forbidden /${r}/`);
  if (k.equals !== undefined && text.trim() !== String(k.equals).trim()) fails.push('output not equal to expected');
  if (k.max_words !== undefined && words(text) > k.max_words) fails.push(`${words(text)} words > ${k.max_words}`);
  if (k.min_words !== undefined && words(text) < k.min_words) fails.push(`${words(text)} words < ${k.min_words}`);
  if (k.refusal && !REFUSAL.test(text)) fails.push('expected a refusal');
  if (k.no_refusal && REFUSAL.test(text)) fails.push('refused when it should answer');
  for (const t of arr(k.forbidden_tools)) if (tools.includes(t)) fails.push(`called forbidden tool ${t}`);
  for (const t of arr(k.required_tools)) if (!tools.includes(t)) fails.push(`did not call ${t}`);
  if (k.number) {
    const flat = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
    const tol = Number(k.number.tolerance ?? 0); const want = Number(k.number.value);
    let found;
    if (k.number.pattern) { const m = flat.match(new RegExp(k.number.pattern)); found = m ? [toNumber(m[1] ?? m[0])].filter((x) => x !== null) : []; }
    else found = [...flat.matchAll(/(?<![\w.-])-?\d+(?:\.\d+)?|(?<=\$)\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    if (!found.length) fails.push('no number found');
    else if (!found.some((x) => Math.abs(x - want) <= tol)) fails.push(`no number within ${tol} of ${want} (found ${found.slice(0, 5).join(', ')})`);
  }
  return { id: c.id, pass: fails.length === 0, weight: Number(c.weight ?? 1), failures: fails };
}

/** responses: [{case_id, output, tool_calls?, model?}] recorded from YOUR runs. Agon calls no model. */
export function grade(suite, responses, opts = {}) {
  const v = validateSuite(suite);
  if (!v.ok) return { comparable: false, error: 'suite invalid', validation: v };
  const pinned = suite.model.id;
  const byId = new Map(); const extra = [];
  for (const r of responses) { if (suite.cases.some((c) => c.id === r.case_id)) byId.set(r.case_id, r); else extra.push(r.case_id); }
  const models = [...new Set(responses.map((r) => r.model).filter(Boolean))];
  const mismatch = models.filter((m) => m !== pinned);
  const results = suite.cases.map((c) => (byId.has(c.id) ? gradeCase(c, byId.get(c.id)) : { id: c.id, pass: false, weight: Number(c.weight ?? 1), failures: ['no response recorded'], missing: true }));
  const tw = results.reduce((s, r) => s + r.weight, 0); const pw = results.filter((r) => r.pass).reduce((s, r) => s + r.weight, 0);
  const comparable = mismatch.length === 0 && models.length > 0;
  return {
    suite: suite.suite, process: suite.process || null, pinned_model: pinned, response_models: models, label: opts.label || null,
    comparable, comparability_note: comparable ? 'All responses carry the pinned model id.' : models.length === 0 ? 'Responses carry no model id, so this run is not comparable to the pin.' : `Responses from ${mismatch.join(', ')} do not match the pin ${pinned}: not comparable.`,
    cases: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length,
    missing: results.filter((r) => r.missing).length, unknown_response_ids: extra,
    score: tw ? round2((pw / tw) * 100) : 0, results,
  };
}

export function compare(base, cand) {
  const b = new Map(base.results.map((r) => [r.id, r])); const regressions = [], fixes = [], still_failing = [];
  for (const r of cand.results) {
    const o = b.get(r.id); if (!o) continue;
    if (o.pass && !r.pass) regressions.push({ id: r.id, failures: r.failures });
    else if (!o.pass && r.pass) fixes.push(r.id);
    else if (!o.pass && !r.pass) still_failing.push(r.id);
  }
  const comparable = base.comparable && cand.comparable && base.pinned_model === cand.pinned_model;
  return { baseline_score: base.score, candidate_score: cand.score, delta: round2(cand.score - base.score), regressions, fixes, still_failing, comparable,
    verdict: !comparable ? 'not_comparable' : regressions.length ? 'regressed' : cand.score >= base.score ? 'no_regressions' : 'lower_score' };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function junit(g) {
  const L = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="${esc(g.suite)}" tests="${g.cases}" failures="${g.failed}">`];
  for (const r of g.results) {
    L.push(`  <testcase classname="${esc(g.suite)}" name="${esc(r.id)}">${r.pass ? '' : `<failure message="${esc(r.failures.join('; '))}"/>`}</testcase>`);
  }
  L.push('</testsuite>', ''); return L.join('\n');
}
export function reportMarkdown(g, cmp, at) {
  const L = [`# Eval report: ${g.suite}`, '', `Generated ${at} by agon-of-evals. Process: ${g.process || 'n/a'}. Pinned model: \`${g.pinned_model}\`.`, '',
    `- Score: **${g.score}%** (${g.passed}/${g.cases} passed${g.missing ? `, ${g.missing} missing` : ''})`, `- Comparable: ${g.comparable ? 'yes' : 'no'} — ${g.comparability_note}`];
  if (cmp) L.push(`- Versus baseline: ${cmp.baseline_score}% → ${cmp.candidate_score}% (${cmp.delta >= 0 ? '+' : ''}${cmp.delta}), ${cmp.regressions.length} regression(s), ${cmp.fixes.length} fix(es); verdict ${cmp.verdict.replace(/_/g, ' ')}`);
  L.push('', '| Case | Result | Why |', '|---|---|---|');
  for (const r of g.results) L.push(`| ${r.id} | ${r.pass ? 'pass' : 'FAIL'} | ${r.failures.join('; ').replace(/\|/g, '\\|')} |`);
  L.push('', 'Graded deterministically from recorded responses you supplied. A score covers this suite and this model only; it is not a general benchmark or certification.', '');
  return L.join('\n');
}
