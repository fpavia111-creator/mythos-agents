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

export function numbersIn(text) {
  const out = [];
  for (const m of text.matchAll(NUM)) {
    const [raw, , cur, int, dec = '', unitRaw = ''] = m; const unit = unitRaw.trim().toLowerCase();
    const value = Number(int.replace(/,/g, '') + dec);
    if (!cur && !dec && !unit && !int.includes(',') && value >= 1900 && value <= 2100) continue; // a year
    const mult = unit === '%' ? 1 : MULT[unit] || 1;
    const places = dec ? dec.length - 1 : 0;
    out.push({ raw: raw.trim(), value: value * mult, percent: unit === '%', tolerance: (Math.pow(10, -places) * mult) / 2 + 1e-9 });
  }
  return out;
}
function candidates(v) {
  const money = [v.actual, v.budget, v.prior, v.var_budget, v.var_prior].filter((x) => x !== null).map(Math.abs);
  const pct = [v.var_budget_pct, v.var_prior_pct].filter((x) => x !== null).map(Math.abs);
  return { money, pct };
}

/** Check every sentence with a number: it must cite known figure ids, and each number must match a cited value. */
export function checkClaims(docs, vs) {
  const byId = new Map(vs.map((v) => [v.id, v])); const claims = [];
  for (const { path, text } of docs) {
    let fence = false;
    String(text).split(/\r?\n/).forEach((line, li) => {
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (fence || /^\s*#/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line) || !line.trim()) return;
      for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z[(*_])/)) {
        const refs = [...sentence.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).filter((t) => /^[A-Za-z][\w-]*\d[\w-]*$/.test(t) && !/^TO|^EXPLAIN|^MISSING/.test(t));
        const nums = numbersIn(sentence.replace(/\[[^\]]*\]/g, ' '));
        if (!nums.length) continue;
        const unknown = refs.filter((r) => !byId.has(r));
        let status = 'ok'; const unmatched = [];
        if (!refs.length) status = 'uncited_number';
        else if (unknown.length) status = 'unknown_citation';
        else {
          const cs = refs.map((r) => candidates(byId.get(r)));
          for (const n of nums) {
            const pool = cs.flatMap((c) => (n.percent ? c.pct : c.money));
            if (!pool.some((x) => Math.abs(Math.abs(n.value) - x) <= n.tolerance)) unmatched.push(n.raw);
          }
          if (unmatched.length) status = 'number_mismatch';
        }
        claims.push({ doc: path, line: li + 1, text: sentence.trim().slice(0, 300), numbers: nums.map((n) => n.raw), refs, status, unknown_refs: unknown, unmatched });
      }
    });
  }
  const count = (s) => claims.filter((c) => c.status === s).length;
  return { claims_checked: claims.length, ok: count('ok'), uncited_number: count('uncited_number'), unknown_citation: count('unknown_citation'), number_mismatch: count('number_mismatch'), issues: claims.length - count('ok'), claims };
}
export const CITATION_COLUMNS = ['doc', 'line', 'status', 'refs', 'numbers', 'unmatched', 'text'];
export const citationsCsv = (c) => toCsv(c.claims.map((x) => ({ ...x, refs: x.refs.join(' '), numbers: x.numbers.join(' '), unmatched: x.unmatched.join(' ') })), CITATION_COLUMNS);
