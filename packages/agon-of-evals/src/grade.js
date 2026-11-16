import { toNumber, round2, validate, canonical, compareEvals } from 'mythos-agent-core';

const REFUSAL = /\b(i can(?:no|')t|i(?: am|'m) (?:not able|unable)|i won'?t|i must decline|cannot help with|can'?t assist|not able to help)\b/i;
export const CHECKS = ['contains', 'not_contains', 'regex', 'not_regex', 'equals', 'max_words', 'min_words', 'refusal', 'no_refusal', 'forbidden_tools', 'required_tools', 'number', 'json_schema', 'tool_order', 'tool_args', 'max_tool_calls'];

/** Validate a suite: { suite, process, model:{provider,id}, cases:[{id, input, checks:{...}, weight?, tags?, critical?}] } */
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
  for (const [i, c] of (Array.isArray(s.cases) ? s.cases : []).entries()) {
    const where = `case ${c.id || '#' + (i + 1)}`;
    if (!c.id) errors.push(`case #${i + 1}: id missing`); else if (ids.has(c.id)) errors.push(`${where}: duplicate id`); else ids.add(c.id);
    if (!c.checks || !Object.keys(c.checks).length) errors.push(`${where}: no checks`);
    for (const k of Object.keys(c.checks || {})) if (!CHECKS.includes(k)) errors.push(`${where}: unknown check "${k}"`);
    for (const r of [].concat(c.checks?.regex || [], c.checks?.not_regex || [])) { try { new RegExp(r); } catch { errors.push(`${where}: bad regex ${r}`); } }
    if (c.checks?.number && (c.checks.number.value === undefined)) errors.push(`${where}: number check needs value`);
    if (c.checks?.number?.pattern) { try { new RegExp(c.checks.number.pattern); } catch { errors.push(`${where}: bad regex ${c.checks.number.pattern}`); } }
  }
  const n = Array.isArray(s.cases) ? s.cases.length : 0;
  if (n < 5) warnings.push('fewer than 5 cases: results will be noisy');
  if (n && !s.cases.some((c) => c.critical)) warnings.push('no case is marked "critical": a gate cannot tell must-never-fail cases from the rest');
  return { ok: errors.length === 0, suite: s.suite, process: s.process || null, model: s.model || null, cases: n, errors, warnings, checks_supported: CHECKS };
}

const words = (t) => (String(t).trim().match(/\S+/g) || []).length;
const arr = (x) => (x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]);
const quote = (text, i, len) => { const s = Math.max(0, i - 30), e = Math.min(text.length, i + len + 30); return `${s ? '…' : ''}${text.slice(s, e).replace(/\s+/g, ' ')}${e < text.length ? '…' : ''}`; };

/** Recorded tool calls as [{ name, args }]. Accepts names, {name, arguments|args|input} objects, or a JSON string of either. */
export function toolCalls(resp) {
  let raw = resp?.tool_calls;
  if (typeof raw === 'string' && /^\s*\[/.test(raw)) { try { raw = JSON.parse(raw); } catch { /* keep as a name */ } }
  return arr(raw).map((t) => (typeof t === 'string' ? { name: t, args: {} } : { name: t?.name, args: t?.arguments ?? t?.args ?? t?.input ?? {} })).filter((t) => t.name);
}

function parseJsonOutput(text) {
  const t = text.trim();
  try { return { ok: true, value: JSON.parse(t) }; } catch { /* try a fenced block */ }
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (m) { try { return { ok: true, value: JSON.parse(m[1]) }; } catch { /* fall through */ } }
  return { ok: false };
}

/** Run a checks object against one response. Returns failures (why not) and evidence (quotes that satisfied a check). */
export function runChecks(k, resp) {
  const text = String(resp?.output ?? '');
  const calls = toolCalls(resp); const tools = calls.map((t) => t.name);
  const fails = [], evidence = [];
  const lowText = text.toLowerCase();
  for (const s of arr(k.contains)) { const i = lowText.indexOf(String(s).toLowerCase()); if (i < 0) fails.push(`missing "${s}"`); else evidence.push({ check: 'contains', quote: quote(text, i, String(s).length) }); }
  for (const s of arr(k.not_contains)) if (lowText.includes(String(s).toLowerCase())) fails.push(`contains forbidden "${s}"`);
  for (const r of arr(k.regex)) { const m = new RegExp(r, 'i').exec(text); if (!m) fails.push(`no match /${r}/`); else evidence.push({ check: 'regex', quote: quote(text, m.index, m[0].length) }); }
  for (const r of arr(k.not_regex)) if (new RegExp(r, 'i').test(text)) fails.push(`matches forbidden /${r}/`);
  if (k.equals !== undefined) { if (text.trim() !== String(k.equals).trim()) fails.push('output not equal to expected'); else evidence.push({ check: 'equals', quote: text.trim().slice(0, 120) }); }
  if (k.max_words !== undefined && words(text) > k.max_words) fails.push(`${words(text)} words > ${k.max_words}`);
  if (k.min_words !== undefined && words(text) < k.min_words) fails.push(`${words(text)} words < ${k.min_words}`);
  if (k.max_words !== undefined || k.min_words !== undefined) evidence.push({ check: 'words', quote: `${words(text)} words` });
  const ref = REFUSAL.exec(text);
  if (k.refusal) { if (!ref) fails.push('expected a refusal'); else evidence.push({ check: 'refusal', quote: quote(text, ref.index, ref[0].length) }); }
  if (k.no_refusal && ref) fails.push('refused when it should answer');
  for (const t of arr(k.forbidden_tools)) if (tools.includes(t)) fails.push(`called forbidden tool ${t}`);
  for (const t of arr(k.required_tools)) { if (!tools.includes(t)) fails.push(`did not call ${t}`); else evidence.push({ check: 'required_tools', quote: `called ${t}` }); }
  if (k.tool_order) {
    let i = 0; for (const t of tools) if (t === k.tool_order[i]) i++;
    if (i < k.tool_order.length) fails.push(`tools not called in order ${k.tool_order.join(' > ')} (called: ${tools.join(', ') || 'none'})`);
    else evidence.push({ check: 'tool_order', quote: `called ${tools.join(' > ')}` });
  }
  for (const [tool, want] of Object.entries(k.tool_args || {})) {
    const hit = calls.find((c) => c.name === tool && Object.entries(want).every(([a, v]) => canonical(c.args?.[a] ?? null) === canonical(v)));
    if (!hit) fails.push(`no ${tool} call with ${Object.entries(want).map(([a, v]) => `${a}=${JSON.stringify(v)}`).join(', ')}`);
    else evidence.push({ check: 'tool_args', quote: `${tool}(${JSON.stringify(hit.args)})`.slice(0, 160) });
  }
  if (k.max_tool_calls !== undefined && calls.length > k.max_tool_calls) fails.push(`${calls.length} tool calls > ${k.max_tool_calls}`);
  if (k.json_schema) {
    const p = parseJsonOutput(text);
    if (!p.ok) fails.push('output is not valid JSON');
    else { const v = validate(k.json_schema, p.value); if (!v.ok) for (const e of v.errors.slice(0, 5)) fails.push(`JSON ${e.path} ${e.message}`); else evidence.push({ check: 'json_schema', quote: 'output matches the JSON schema' }); }
  }
  if (k.number) {
    const flat = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
    const tol = Number(k.number.tolerance ?? 0); const want = Number(k.number.value);
    let found;
    if (k.number.pattern) { const m = flat.match(new RegExp(k.number.pattern)); found = m ? [toNumber(m[1] ?? m[0])].filter((x) => x !== null) : []; }
    else found = [...flat.matchAll(/(?<![\w.-])-?\d+(?:\.\d+)?|(?<=\$)\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const hit = found.find((x) => Math.abs(x - want) <= tol);
    if (!found.length) fails.push('no number found');
    else if (hit === undefined) fails.push(`no number within ${tol} of ${want} (found ${found.slice(0, 5).join(', ')})`);
    else evidence.push({ check: 'number', quote: `found ${hit}` });
  }
  return { fails, evidence };
}

/** Wilson score interval for a proportion, as percentages. */
export function wilson(passed, n, z = 1.96) {
  if (!n) return [0, 100];
  const p = passed / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [round2(Math.max(0, c - h) * 100), round2(Math.min(1, c + h) * 100)];
}

/**
 * responses: [{case_id, output, tool_calls?, model?, trial?}] recorded from YOUR runs. Agon calls no model.
 * Several responses for one case are trials: the case passes when its pass rate reaches
 * suite.pass_threshold (default 1 = every trial).
 */
export function grade(suite, responses, opts = {}) {
  const v = validateSuite(suite);
  if (!v.ok) return { comparable: false, error: 'suite invalid', validation: v };
  const pinned = suite.model.id;
  const threshold = Number(suite.pass_threshold ?? 1);
  const known = new Set(suite.cases.map((c) => c.id));
  const byId = new Map(); const extra = [];
  for (const r of responses) { if (known.has(r.case_id)) byId.set(r.case_id, [...(byId.get(r.case_id) || []), r]); else extra.push(r.case_id); }
  const models = [...new Set(responses.map((r) => r.model).filter(Boolean))];
  const mismatch = models.filter((m) => m !== pinned);
  const results = suite.cases.map((c) => {
    const base = { id: c.id, weight: Number(c.weight ?? 1), tags: c.tags || [], critical: !!c.critical };
    const rs = byId.get(c.id);
    if (!rs) return { ...base, pass: false, failures: ['no response recorded'], missing: true, trials: 0, passes: 0, pass_rate: 0, trial_passes: [], flaky: false };
    const graded = rs.map((r) => runChecks(c.checks, r));
    const tp = graded.map((g) => (g.fails.length ? 0 : 1)); const passes = tp.reduce((s, x) => s + x, 0); const n = tp.length;
    const count = new Map(); for (const g of graded) for (const f of new Set(g.fails)) count.set(f, (count.get(f) || 0) + 1);
    const failures = [...count].map(([f, k]) => (n > 1 ? `${f} (${k}/${n} trials)` : f));
    const rate = passes / n;
    return { ...base, pass: n === 1 ? passes === 1 : rate >= threshold, failures, trials: n, passes, pass_rate: round2(rate), trial_passes: tp, flaky: passes > 0 && passes < n };
  });
  const tw = results.reduce((s, r) => s + r.weight, 0);
  const score = tw ? round2((results.reduce((s, r) => s + r.weight * (r.trials ? r.passes / r.trials : 0), 0) / tw) * 100) : 0;
  const comparable = mismatch.length === 0 && models.length > 0;
  const passed = results.filter((r) => r.pass).length;
  const tags = {};
  for (const r of results) for (const t of r.tags) { const g = (tags[t] ||= { cases: 0, passed: 0 }); g.cases++; if (r.pass) g.passed++; }
  for (const g of Object.values(tags)) g.pass_pct = round2((g.passed / g.cases) * 100);
  const multi = results.some((r) => r.trials > 1);
  return {
    suite: suite.suite, process: suite.process || null, pinned_model: pinned, response_models: models, label: opts.label || null,
    comparable, comparability_note: comparable ? 'All responses carry the pinned model id.' : models.length === 0 ? 'Responses carry no model id, so this run is not comparable to the pin.' : `Responses from ${mismatch.join(', ')} do not match the pin ${pinned}: not comparable.`,
    cases: results.length, passed, failed: results.length - passed,
    missing: results.filter((r) => r.missing).length, unknown_response_ids: [...new Set(extra)],
    score, passed_ci95: wilson(passed, results.length),
    trials: multi ? { max_per_case: Math.max(...results.map((r) => r.trials)), pass_threshold: threshold, flaky_cases: results.filter((r) => r.flaky).map((r) => r.id) } : null,
    critical_failures: results.filter((r) => r.critical && !r.pass).map((r) => r.id),
    by_tag: tags, results,
    ...(results.length < 30 ? { sample_note: `${results.length} cases: one flipped case moves the score ${round2(100 / results.length)} points, and the 95% interval on cases passed is ${wilson(passed, results.length).join('–')}%.` } : {}),
  };
}

export function compare(base, cand, opts = {}) {
  const b = new Map(base.results.map((r) => [r.id, r])); const regressions = [], fixes = [], still_failing = [];
  for (const r of cand.results) {
    const o = b.get(r.id); if (!o) continue;
    if (o.pass && !r.pass) regressions.push({ id: r.id, failures: r.failures, critical: !!r.critical });
    else if (!o.pass && r.pass) fixes.push(r.id);
    else if (!o.pass && !r.pass) still_failing.push(r.id);
  }
  const sets = compareEvals(base, cand); // shared with the core: also gives added/removed case ids
  const comparable = base.comparable && cand.comparable && base.pinned_model === cand.pinned_model;
  const out = { baseline_score: base.score, candidate_score: cand.score, delta: round2(cand.score - base.score), regressions, fixes, still_failing, added_cases: sets.added, removed_cases: sets.removed, comparable,
    verdict: !comparable ? 'not_comparable' : regressions.length ? 'regressed' : cand.score >= base.score ? 'no_regressions' : 'lower_score' };
  if (opts.stats) out.stats = opts.stats;
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function junit(g) {
  const L = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="${esc(g.suite)}" tests="${g.cases}" failures="${g.failed}">`];
  for (const r of g.results) {
    L.push(`  <testcase classname="${esc(g.suite)}" name="${esc(r.id)}">${r.pass ? '' : `<failure message="${esc(r.failures.join('; '))}"/>`}</testcase>`);
  }
  L.push('</testsuite>', ''); return L.join('\n');
}
export function reportMarkdown(g, cmp, at, extra = {}) {
  const L = [`# Eval report: ${g.suite}`, '', `Generated ${at} by agon-of-evals. Process: ${g.process || 'n/a'}. Pinned model: \`${g.pinned_model}\`.`, '',
    `- Score: **${g.score}%** (${g.passed}/${g.cases} passed${g.missing ? `, ${g.missing} missing` : ''}; 95% interval on cases passed ${g.passed_ci95.join('–')}%)`, `- Comparable: ${g.comparable ? 'yes' : 'no'} — ${g.comparability_note}`];
  if (g.trials) L.push(`- Trials: up to ${g.trials.max_per_case} per case, pass threshold ${g.trials.pass_threshold}; flaky cases: ${g.trials.flaky_cases.join(', ') || 'none'}`);
  if (g.critical_failures.length) L.push(`- **Critical cases failing:** ${g.critical_failures.join(', ')}`);
  if (cmp) L.push(`- Versus baseline: ${cmp.baseline_score}% → ${cmp.candidate_score}% (${cmp.delta >= 0 ? '+' : ''}${cmp.delta}), ${cmp.regressions.length} regression(s), ${cmp.fixes.length} fix(es); verdict ${cmp.verdict.replace(/_/g, ' ')}`);
  if (cmp?.stats) { const s = cmp.stats; L.push(`- Statistics: ${s.verdict.replace(/_/g, ' ')} — score change ${s.delta >= 0 ? '+' : ''}${s.delta} points, ${Math.round(s.confidence * 100)}% interval ${s.ci_low} to ${s.ci_high} (${s.method}, ${s.resamples} resamples, seed ${s.seed})`); }
  if (extra.gate) L.push(`- Gate: **${extra.gate.result}**${extra.gate.reasons.length ? ' — ' + extra.gate.reasons.join('; ') : ''}`);
  L.push('', '| Case | Result | Why |', '|---|---|---|');
  for (const r of g.results) L.push(`| ${r.id}${r.critical ? ' (critical)' : ''} | ${r.pass ? 'pass' : 'FAIL'}${r.trials > 1 ? ` ${r.passes}/${r.trials}` : ''} | ${r.failures.join('; ').replace(/\|/g, '\\|')} |`);
  if (Object.keys(g.by_tag).length) { L.push('', '| Tag | Passed | % |', '|---|---:|---:|'); for (const [t, x] of Object.entries(g.by_tag).sort(([a], [b]) => a.localeCompare(b))) L.push(`| ${t} | ${x.passed}/${x.cases} | ${x.pass_pct} |`); }
  if (extra.rubric) {
    const rb = extra.rubric;
    L.push('', `## Rubric: ${rb.rubric}`, '', `Rubric score ${rb.score}% (${rb.earned}/${rb.possible} points; pass at ${rb.pass_score}%).${rb.pending ? ` ${rb.pending} judged criterion grade(s) still pending.` : ''}`, '', '| Case | Criterion | Points | Evidence or reason |', '|---|---|---:|---|');
    for (const c of rb.results) for (const k of c.criteria) L.push(`| ${c.id} | ${k.criterion}: ${k.text.replace(/\|/g, '/')} | ${k.status === 'pending' ? 'pending' : `${k.earned}/${k.points}`} | ${String(k.evidence?.quote || k.reason || '').replace(/\|/g, '/')} |`);
  }
  L.push('', 'Graded deterministically from recorded responses you supplied. A score covers this suite and this model only; it is not a general benchmark or certification.', '');
  return L.join('\n');
}
