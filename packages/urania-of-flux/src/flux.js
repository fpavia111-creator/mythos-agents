import { toNumber, round2, toCsv } from 'mythos-agent-core';

const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export const DEFAULTS = Object.freeze({ materiality_abs: 50000, materiality_pct: 10 });
const fmt = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
const fmtVar = (n) => `${sgn(n)}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const fmtPct = (p) => (p === null ? '—' : `${sgn(p)}${Math.abs(p).toFixed(1)}%`);

/** Figures: id, metric, period, actual, budget, prior, source */
export function variances(rows, a = {}) {
  const abs = Number(a.materiality_abs ?? DEFAULTS.materiality_abs); const pctT = Number(a.materiality_pct ?? DEFAULTS.materiality_pct);
  const seen = new Set();
  return rows.map((r, i) => {
    const id = pick(r, 'id', 'ref', 'figure_id') || `F${i + 1}`;
    if (seen.has(id)) throw new Error(`duplicate figure id ${id}`); seen.add(id);
    const actual = toNumber(pick(r, 'actual', 'value', 'amount'));
    if (actual === null) throw new Error(`figure ${id} has no actual value`);
    const budget = toNumber(pick(r, 'budget', 'plan')); const prior = toNumber(pick(r, 'prior', 'prior_period', 'last_period'));
    const vb = budget === null ? null : round2(actual - budget); const vp = prior === null ? null : round2(actual - prior);
    const pb = budget ? (vb / Math.abs(budget)) * 100 : null; const pp = prior ? (vp / Math.abs(prior)) * 100 : null;
    const basis = vb !== null ? 'budget' : vp !== null ? 'prior' : null;
    const v = basis === 'budget' ? vb : vp; const p = basis === 'budget' ? pb : pp;
    const material = basis !== null && (Math.abs(v) >= abs || (p !== null && Math.abs(p) >= pctT));
    return { id, metric: pick(r, 'metric', 'line', 'name', 'account'), period: pick(r, 'period', 'month'), actual, budget, prior, var_budget: vb, var_budget_pct: pb === null ? null : round2(pb), var_prior: vp, var_prior_pct: pp === null ? null : round2(pp), basis, material, source: pick(r, 'source', 'source_ref', 'cell') };
  });
}

export function varianceTable(vs) {
  const L = ['| Id | Metric | Actual | Budget | vs budget | Prior | vs prior | Material |', '|---|---|---:|---:|---:|---:|---:|---|'];
  for (const v of vs) L.push(`| ${v.id} | ${v.metric} | ${fmt(v.actual)} | ${fmt(v.budget)} | ${v.var_budget === null ? '—' : `${fmtVar(v.var_budget)} (${fmtPct(v.var_budget_pct)})`} | ${fmt(v.prior)} | ${v.var_prior === null ? '—' : `${fmtVar(v.var_prior)} (${fmtPct(v.var_prior_pct)})`} | ${v.material ? 'yes' : ''} |`);
  return L.join('\n');
}

export function draftCommentary(vs, a = {}) {
  const L = [`# Commentary draft${a.period ? ` — ${a.period}` : ''}`, '', '> DRAFT. Every figure cites its source id. Each "Reason" is written by the line owner; Urania does not guess causes.', ''];
  const mat = vs.filter((v) => v.material);
  if (!mat.length) L.push('No material variances at the current thresholds.', '');
  for (const v of mat) {
    const parts = [`**${v.metric}** was ${fmt(v.actual)}`];
    if (v.budget !== null) parts.push(`against budget ${fmt(v.budget)} (${fmtVar(v.var_budget)}, ${fmtPct(v.var_budget_pct)})`);
    if (v.prior !== null) parts.push(`${v.budget !== null ? 'and ' : 'against '}prior period ${fmt(v.prior)} (${fmtVar(v.var_prior)}, ${fmtPct(v.var_prior_pct)})`);
    L.push(`- ${parts.join(' ')} [${v.id}]. Reason: [TO WRITE — owner explains]`);
  }
  L.push('');
  return L.join('\n');
}

// ---- claims check -------------------------------------------------------
const NUM = /(?<![\w.\-/])([-+−]?)([$€£])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?!\d|,\d|\.\d)(\s?%|\s?(?:k|m|bn|million|thousand|billion)\b)?(?![-/]\d)/gi;
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

const HEDGE = /(?:\babout|\bapproximately|\bapprox\.?|\baround|\broughly|\bnearly|\balmost|\bc\.|~)\s*$/i;
export function numbersIn(text) {
  const out = [];
  for (const m of text.matchAll(NUM)) {
    const [raw, , cur, int, dec = '', unitRaw = ''] = m; const unit = unitRaw.trim().toLowerCase();
    const value = Number(int.replace(/,/g, '') + dec);
    if (!cur && !dec && !unit && !int.includes(',') && value >= 1900 && value <= 2100) continue; // a year
    const mult = unit === '%' ? 1 : MULT[unit] || 1;
    const places = dec ? dec.length - 1 : 0;
    // "about 12%" is read as "within one unit of the last digit written" rather than half a unit.
    const hedged = HEDGE.test(text.slice(Math.max(0, m.index - 16), m.index));
    out.push({ raw: raw.trim(), value: value * mult, percent: unit === '%', hedged, tolerance: (Math.pow(10, -places) * mult) / (hedged ? 1 : 2) + 1e-9 });
  }
  return out;
}

const UP = /\b(?:up|above|over|rose|risen|rise|rises|rising|increase[sd]?|increasing|grew|grown|growth|higher|ahead|exceed(?:ed|s|ing)?|beat)\b/i;
const DOWN = /\b(?:down|below|under|fell|fallen|fall|falls|falling|decrease[sd]?|decreasing|declined?|declines|declining|lower|behind|short|shortfall|dropped|drop|drops)\b/i;
/** +1 when the sentence only uses "up" words, -1 when it only uses "down" words, 0 when none or both. */
export function polarity(sentence) {
  const u = UP.test(sentence), d = DOWN.test(sentence);
  return u && !d ? 1 : d && !u ? -1 : 0;
}

/** Values a number in a sentence may match: levels (actual, budget, prior), signed variances, and ratios between cited figures. */
function pools(refs, byId) {
  const money = []; const pct = [];
  const vs = refs.map((r) => byId.get(r));
  for (const v of vs) {
    for (const [field, x] of [['actual', v.actual], ['budget', v.budget], ['prior', v.prior]]) if (x !== null) money.push({ id: v.id, field, value: Math.abs(x), kind: 'level' });
    for (const [field, x] of [['var_budget', v.var_budget], ['var_prior', v.var_prior]]) if (x !== null) money.push({ id: v.id, field, value: Math.abs(x), kind: 'var', sign: Math.sign(x) });
    for (const [field, x] of [['var_budget_pct', v.var_budget_pct], ['var_prior_pct', v.var_prior_pct]]) if (x !== null) pct.push({ id: v.id, field, value: Math.abs(x), kind: 'var', sign: Math.sign(x) });
  }
  // Ratios and changes between two cited figures, e.g. "gross margin was 58.5% of revenue [F3, F1]".
  for (const a of vs) for (const b of vs) {
    if (a === b || !b.actual) continue;
    pct.push({ id: `${a.id}/${b.id}`, field: 'ratio', value: Math.abs((a.actual / b.actual) * 100), kind: 'level' });
    const ch = ((a.actual - b.actual) / Math.abs(b.actual)) * 100;
    pct.push({ id: `${a.id}~${b.id}`, field: 'change', value: Math.abs(ch), kind: 'var', sign: Math.sign(ch) });
  }
  return { money, pct };
}

/**
 * Check every sentence with a number: it must cite known figure ids, each number must match a cited
 * value at the precision written, and an "up"/"down" word must agree with the sign of a matched variance.
 */
export function checkClaims(docs, vs) {
  const byId = new Map(vs.map((v) => [v.id, v])); const claims = [];
  for (const { path, text } of docs) {
    let fence = false;
    String(text).split(/\r?\n/).forEach((line, li) => {
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (fence || /^\s*#/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line) || !line.trim()) return;
      for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z[(*_])/)) {
        const refs = [...sentence.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).filter((t) => /^[A-Za-z][\w-]*\d[\w-]*$/.test(t) && !/^TO|^EXPLAIN|^MISSING/.test(t));
        const bare = sentence.replace(/\[[^\]]*\]/g, ' ');
        const nums = numbersIn(bare);
        if (!nums.length) continue;
        const unknown = refs.filter((r) => !byId.has(r));
        let status = 'ok'; const unmatched = []; const wrongDirection = []; const matched = [];
        if (!refs.length) status = 'uncited_number';
        else if (unknown.length) status = 'unknown_citation';
        else {
          const pool = pools(refs, byId); const dir = polarity(bare);
          for (const n of nums) {
            const hits = (n.percent ? pool.pct : pool.money).filter((x) => Math.abs(Math.abs(n.value) - x.value) <= n.tolerance);
            if (!hits.length) { unmatched.push(n.raw); continue; }
            matched.push({ number: n.raw, matches: hits.map((h) => `${h.id}.${h.field}`) });
            if (dir && hits.every((h) => h.kind === 'var') && !hits.some((h) => h.sign === dir || h.sign === 0)) wrongDirection.push(n.raw);
          }
          if (unmatched.length) status = 'number_mismatch';
          else if (wrongDirection.length) status = 'direction_mismatch';
        }
        claims.push({ doc: path, line: li + 1, text: sentence.trim().slice(0, 300), numbers: nums.map((n) => n.raw), refs, status, unknown_refs: unknown, unmatched, wrong_direction: wrongDirection, matched });
      }
    });
  }
  const count = (s) => claims.filter((c) => c.status === s).length;
  return { claims_checked: claims.length, ok: count('ok'), uncited_number: count('uncited_number'), unknown_citation: count('unknown_citation'), number_mismatch: count('number_mismatch'), direction_mismatch: count('direction_mismatch'), issues: claims.length - count('ok'), claims };
}
export const CITATION_COLUMNS = ['doc', 'line', 'status', 'refs', 'numbers', 'unmatched', 'wrong_direction', 'text'];
export const citationsCsv = (c) => toCsv(c.claims.map((x) => ({ ...x, refs: x.refs.join(' '), numbers: x.numbers.join(' '), unmatched: x.unmatched.join(' '), wrong_direction: (x.wrong_direction || []).join(' ') })), CITATION_COLUMNS);

// ---- prior-pack comparison ----------------------------------------------
const metricKey = (m) => String(m || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Compare this pack's figures with the figures of the previous pack.
 * - same metric, same period: any change to actual or budget is a restatement;
 * - same metric, later period: this pack's "prior" must equal last pack's "actual", else the prior period was restated;
 * - metrics that appear or disappear, and figure ids that changed for the same metric, are listed too.
 * When docs are given, every sentence citing an affected figure id is listed so its author can re-read it.
 */
export function comparePrior(cur, prev, { tolerance = 0.5, docs = [] } = {}) {
  const prevBy = new Map(prev.map((p) => [metricKey(p.metric) || p.id, p]));
  const used = new Set(); const changes = [];
  for (const c of cur) {
    const key = metricKey(c.metric) || c.id; const p = prevBy.get(key);
    if (!p) { changes.push({ type: 'new_metric', id: c.id, metric: c.metric, detail: 'not in the prior pack' }); continue; }
    used.add(key);
    if (p.id !== c.id) changes.push({ type: 'id_changed', id: c.id, prior_id: p.id, metric: c.metric, detail: `was [${p.id}] in the prior pack; citations to [${p.id}] in carried-over text now point elsewhere` });
    if (c.period && p.period && c.period === p.period) {
      for (const f of ['actual', 'budget']) {
        if (p[f] === null && c[f] === null) continue;
        if (p[f] === null || c[f] === null || Math.abs(c[f] - p[f]) > tolerance) changes.push({ type: 'restated', id: c.id, metric: c.metric, field: f, was: p[f], now: c[f], delta: p[f] === null || c[f] === null ? null : round2(c[f] - p[f]), detail: `${f} for ${c.period} changed since the prior pack` });
      }
    } else if (c.prior !== null && Math.abs(c.prior - p.actual) > tolerance) {
      changes.push({ type: 'prior_restated', id: c.id, metric: c.metric, field: 'prior', was: p.actual, now: c.prior, delta: round2(c.prior - p.actual), detail: `prior period ${p.period || ''} was reported as ${p.actual} in the prior pack but is ${c.prior} now`.replace('  ', ' ') });
    } else if (c.prior === null) {
      changes.push({ type: 'prior_missing', id: c.id, metric: c.metric, field: 'prior', was: p.actual, now: null, delta: null, detail: 'no prior value in this pack although the prior pack reported one' });
    }
  }
  for (const [key, p] of prevBy) if (!used.has(key)) changes.push({ type: 'dropped_metric', id: p.id, metric: p.metric, detail: 'in the prior pack, not in this one' });
  const affected = new Set(changes.filter((x) => ['restated', 'prior_restated', 'prior_missing', 'id_changed'].includes(x.type)).map((x) => x.id));
  const impact = [];
  for (const { path, text } of docs) String(text).split(/\r?\n/).forEach((line, i) => {
    const refs = [...line.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).filter((r) => affected.has(r));
    if (refs.length) impact.push({ doc: path, line: i + 1, refs: [...new Set(refs)], text: line.trim().slice(0, 300) });
  });
  const count = (t) => changes.filter((x) => x.type === t).length;
  return { restated: count('restated'), prior_restated: count('prior_restated'), prior_missing: count('prior_missing'), new_metrics: count('new_metric'), dropped_metrics: count('dropped_metric'), id_changes: count('id_changed'), affected_ids: [...affected].sort(), changes, impact };
}
