// Statistical regression thresholds. Everything is seeded, so the same inputs give the same
// interval. Two methods:
//  - with repeated trials: a stratified bootstrap that resamples trials inside each case
//    (the suite is fixed; the noise is run-to-run variation), plus a Fisher exact test per case;
//  - with one response per case: a paired bootstrap over cases plus an exact sign (McNemar) test.
import { round2 } from 'mythos-agent-core';

/** Small seeded PRNG (mulberry32). */
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const lf = (() => { const c = [0]; return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; }; })();
const choose = (n, k) => Math.exp(lf(n) - lf(k) - lf(n - k));

/** One-sided Fisher exact p-value that the candidate's pass rate is lower than the baseline's. */
export function fisherLower(bPass, bN, cPass, cN) {
  const pass = bPass + cPass, n = bN + cN; if (!bN || !cN) return 1;
  const prob = (x) => (choose(pass, x) * choose(n - pass, cN - x)) / choose(n, cN); // x = candidate passes
  let p = 0; for (let x = Math.max(0, cN - (n - pass)); x <= Math.min(cPass, pass, cN); x++) p += prob(x);
  return Math.min(1, p);
}

/** Exact two-sided sign test on discordant pairs (McNemar exact). */
export function signTest(regressed, fixed) {
  const n = regressed + fixed; if (!n) return 1;
  const k = Math.min(regressed, fixed); let p = 0;
  for (let i = 0; i <= k; i++) p += choose(n, i) * 0.5 ** n;
  return Math.min(1, 2 * p);
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * Bootstrap confidence interval for the score change (candidate - baseline, in points).
 * opts: { resamples = 2000, seed = 1, confidence = 0.95, min_delta = 0 }
 * verdict: 'regression' | 'improvement' | 'within_noise'.
 */
export function scoreDeltaCI(base, cand, opts = {}) {
  const resamples = Number(opts.resamples ?? 2000), seed = Number(opts.seed ?? 1), confidence = Number(opts.confidence ?? 0.95), minDelta = Number(opts.min_delta ?? 0);
  const b = new Map(base.results.map((r) => [r.id, r]));
  const pairs = cand.results.filter((r) => b.has(r.id)).map((c) => ({ id: c.id, w: c.weight, b: b.get(c.id).trial_passes.length ? b.get(c.id).trial_passes : [0], c: c.trial_passes.length ? c.trial_passes : [0], critical: c.critical }));
  const tw = pairs.reduce((s, p) => s + p.w, 0) || 1;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const delta = round2((pairs.reduce((s, p) => s + p.w * (mean(p.c) - mean(p.b)), 0) / tw) * 100);
  const multi = pairs.some((p) => p.b.length > 1 || p.c.length > 1);
  const rnd = prng(seed); const draws = new Array(resamples);
  const resampleMean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[Math.floor(rnd() * a.length)]; return s / a.length; };
  for (let k = 0; k < resamples; k++) {
    let num = 0, den = tw;
    if (multi) for (const p of pairs) num += p.w * (resampleMean(p.c) - resampleMean(p.b));
    else { den = 0; for (let i = 0; i < pairs.length; i++) { const p = pairs[Math.floor(rnd() * pairs.length)]; num += p.w * (p.c[0] - p.b[0]); den += p.w; } }
    draws[k] = (num / (den || 1)) * 100;
  }
  draws.sort((x, y) => x - y);
  const a = (1 - confidence) / 2;
  const lo = round2(pct(draws, a)), hi = round2(pct(draws, 1 - a));
  const alpha = 1 - confidence;
  const per_case = pairs.map((p) => {
    const bp = p.b.reduce((s, x) => s + x, 0), cp = p.c.reduce((s, x) => s + x, 0);
    const worse = mean(p.c) < mean(p.b);
    const pv = multi ? round4(fisherLower(bp, p.b.length, cp, p.c.length)) : null;
    return { id: p.id, baseline: `${bp}/${p.b.length}`, candidate: `${cp}/${p.c.length}`, change: round2((mean(p.c) - mean(p.b)) * 100), ...(multi ? { p_value: pv, significant: worse && pv < alpha } : {}), critical: p.critical };
  }).filter((x) => x.change !== 0);
  const down = pairs.filter((p) => mean(p.c) < mean(p.b)).length, up = pairs.filter((p) => mean(p.c) > mean(p.b)).length;
  const significant = hi < 0 || lo > 0;
  const verdict = hi < 0 && delta <= -minDelta ? 'regression' : lo > 0 && delta >= minDelta ? 'improvement' : 'within_noise';
  return {
    method: multi ? 'stratified bootstrap over trials within each case' : 'paired bootstrap over cases',
    resamples, seed, confidence, min_delta: minDelta, cases: pairs.length,
    delta, ci_low: lo, ci_high: hi, significant, verdict,
    ...(multi ? {} : { sign_test_p: round4(signTest(down, up)) }),
    significant_case_regressions: per_case.filter((x) => x.significant).map((x) => x.id),
    within_noise_cases: per_case.filter((x) => x.change < 0 && !x.significant && multi).map((x) => x.id),
    per_case,
    note: multi ? 'The suite is treated as fixed; the interval reflects run-to-run variation across the recorded trials.' : `One response per case: the interval reflects which cases are in the suite. With ${pairs.length} cases it is wide; record several trials per case for a tighter answer.`,
  };
}
const round4 = (x) => Math.round(x * 10000) / 10000;

export const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    min_score: { type: 'number', minimum: 0, maximum: 100, description: 'Candidate score must be at least this' },
    max_regressions: { type: 'integer', minimum: 0, description: 'Cases that passed in the baseline and fail now (default 0 when a baseline is given)' },
    fail_on: { type: 'string', enum: ['any_regression', 'significant_regression'], description: 'any_regression counts every pass-to-fail case; significant_regression uses the bootstrap interval and per-case tests' },
    min_delta: { type: 'number', minimum: 0, description: 'Score drops smaller than this many points are never a statistical regression' },
    confidence: { type: 'number', exclusiveMinimum: 0.5, exclusiveMaximum: 1 },
    resamples: { type: 'integer', minimum: 100, maximum: 20000 },
    seed: { type: 'integer', minimum: 0 },
    must_pass: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Case ids that must pass (cases marked critical in the suite always must)' },
    max_flaky: { type: 'integer', minimum: 0 },
    require_comparable: { type: 'boolean', description: 'Fail when responses do not carry the pinned model id (default true)' },
    min_rubric_score: { type: 'number', minimum: 0, maximum: 100 },
  },
};

/** Apply a gate to a graded run (and optional comparison / rubric result). Returns { result, reasons, checks }. */
export function applyGate(gate, g, cmp = null, rubric = null) {
  const reasons = []; const checks = [];
  const check = (name, ok, why) => { checks.push({ check: name, ok }); if (!ok) reasons.push(why); };
  if (gate.require_comparable !== false) check('comparable', g.comparable && (!cmp || cmp.comparable), 'run is not comparable to the pinned model');
  if (gate.min_score !== undefined) check('min_score', g.score >= gate.min_score, `score ${g.score} < ${gate.min_score}`);
  const must = [...new Set([...(gate.must_pass || []), ...g.results.filter((r) => r.critical).map((r) => r.id)])];
  const failing = must.filter((id) => !(g.results.find((r) => r.id === id) || {}).pass);
  if (must.length) check('must_pass', failing.length === 0, `must-pass case(s) failing: ${failing.join(', ')}`);
  if (gate.max_flaky !== undefined) { const n = g.trials ? g.trials.flaky_cases.length : 0; check('max_flaky', n <= gate.max_flaky, `${n} flaky case(s) > ${gate.max_flaky}`); }
  if (cmp) {
    if ((gate.fail_on || 'any_regression') === 'significant_regression' && cmp.stats) {
      const s = cmp.stats; const bad = s.verdict === 'regression' || s.significant_case_regressions.length > 0;
      check('significant_regression', !bad, s.verdict === 'regression' ? `score change ${s.delta} points, ${Math.round(s.confidence * 100)}% interval ${s.ci_low} to ${s.ci_high} is below zero` : `significant regression in: ${s.significant_case_regressions.join(', ')}`);
    } else { const max = gate.max_regressions ?? 0; check('max_regressions', cmp.regressions.length <= max, `${cmp.regressions.length} regression(s) > ${max}: ${cmp.regressions.map((r) => r.id).join(', ')}`); }
  }
  if (gate.min_rubric_score !== undefined) check('min_rubric_score', !!rubric && rubric.score >= gate.min_rubric_score, rubric ? `rubric score ${rubric.score} < ${gate.min_rubric_score}` : 'min_rubric_score set but no rubric was given');
  return { result: reasons.length ? 'fail' : 'pass', reasons, checks };
}
