import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toNumber, round2, toCsv, nameSimilarity, sha256File, htmlPage, escapeHtml } from 'mythos-agent-core';
import { pick, parseDate } from './expenses.js';
import { normalizeReceipt } from './receipts.js';

const DAY = 86400000;
const SAFE_FILE = /^[\w.\- ]+$/;

function lineOf(l, i, source) {
  return {
    source, report_id: pick(l, 'report_id', 'report'), line_id: pick(l, 'line_id', 'line', 'id') || `L${i + 1}`, employee: pick(l, 'employee', 'employee_name', 'submitter'),
    date: pick(l, 'date', 'expense_date', 'spent_on'), merchant: pick(l, 'merchant', 'vendor'), amount: round2(toNumber(pick(l, 'amount', 'total')) || 0), receipt: pick(l, 'receipt', 'receipt_file'),
  };
}
function receiptInfo(dir, name, cache) {
  if (!dir || !name || !SAFE_FILE.test(name)) return null;
  if (cache.has(name)) return cache.get(name);
  const f = join(dir, name); let info = null;
  if (existsSync(f)) {
    if (/\.(txt|md|text)$/i.test(f)) { const r = normalizeReceipt(readFileSync(f, 'utf8')); info = { hash: r.content_sha256, total: r.total, date: r.date, merchant: r.merchant }; }
    else info = { hash: sha256File(f), total: null, date: null, merchant: '' };
  }
  cache.set(name, info); return info;
}

/**
 * Possible duplicate claims within the current lines and against earlier (history) lines.
 * Signals: same receipt file, identical receipt text after normalising, the same merchant,
 * total and date on two receipt files, and fuzzy matches (same employee, similar merchant,
 * amount within tolerance, dates within a window). Each pair gets an explainable score.
 */
export function findDuplicates(lines, a = {}) {
  const win = a.date_window_days !== undefined ? Number(a.date_window_days) : 3;
  const tolPct = a.amount_tolerance_pct !== undefined ? Number(a.amount_tolerance_pct) : 0.01;
  const cache = new Map();
  const all = lines.map((l, i) => lineOf(l, i, 'current')).concat((a.history || []).map((l, i) => lineOf(l, i, 'history')));
  for (const l of all) l.r = receiptInfo(a.receiptsDir, l.receipt, cache);
  // Only pairs that can match are scored: the same receipt file, receipt text, or receipt
  // total and date (from indexes), or the same employee with amounts and dates close
  // enough for a fuzzy match. Same result as checking every pair, in the same order.
  const cand = all.map(() => new Set());
  const block = (key) => { const m = new Map(); all.forEach((l, i) => { const k = key(l); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(i); } }); return m.values(); };
  const linkAll = (ids, ok = () => true) => { for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) if (ok(all[ids[p]], all[ids[q]])) cand[ids[p]].add(ids[q]); };
  // One receipt shared by hundreds of lines would mean tens of thousands of pairs; such a
  // receipt is listed once under not_paired instead (its lines are still checked for
  // fuzzy duplicates by employee, amount and date).
  const MAX_SHARED = 200; const notPaired = [];
  const receiptBlocks = (key, what) => { for (const ids of block(key)) { if (ids.length > MAX_SHARED) { const l = all[ids[0]]; notPaired.push(`${ids.length} lines share ${what === 'file' ? `the receipt file "${l.receipt}"` : what === 'text' ? `the same receipt text (first: ${l.receipt})` : `one receipt total and date (first: ${l.receipt})`}; check them as a group`); continue; } linkAll(ids); } };
  receiptBlocks((l) => (l.receipt ? l.receipt.toLowerCase() : ''), 'file');
  receiptBlocks((l) => (l.r && l.r.hash !== undefined ? `h:${l.r.hash}` : ''), 'text');
  receiptBlocks((l) => (l.r && l.r.total !== null && l.r.date ? `${l.r.total}|${l.r.date}` : ''), 'total');
  // Fuzzy: same employee, dates within the window (sorted by date, so only neighbours are
  // compared), amounts within the tolerance.
  for (const ids of block((l) => (l.employee ? l.employee.toLowerCase() : ''))) {
    const dated = ids.map((i) => [i, parseDate(all[i].date)]).filter(([, d]) => d !== null).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    for (let p = 0; p < dated.length; p++) for (let q = p + 1; q < dated.length && (dated[q][1] - dated[p][1]) / DAY <= win; q++) {
      const i = Math.min(dated[p][0], dated[q][0]), j = Math.max(dated[p][0], dated[q][0]); const x = all[i], y = all[j];
      if (Math.abs(x.amount - y.amount) <= Math.max(0.01, tolPct * Math.max(x.amount, y.amount))) cand[i].add(j);
    }
  }
  const pairs = [];
  for (let i = 0; i < all.length; i++) for (const j of [...cand[i]].sort((p, q) => p - q)) {
    const x = all[i]; const y = all[j];
    if (x.source === 'history' && y.source === 'history') continue;
    const reasons = []; let score = 0; const why = (pts, text) => { score += pts; reasons.push({ points: pts, reason: text }); };
    const sameFile = x.receipt && y.receipt && x.receipt.toLowerCase() === y.receipt.toLowerCase();
    if (sameFile) why(50, `same receipt file "${x.receipt}"`);
    else if (x.r && y.r && x.r.hash === y.r.hash) why(60, 'identical receipt text after normalising (different file names)');
    else if (x.r && y.r && x.r.total !== null && x.r.total === y.r.total && x.r.date && x.r.date === y.r.date && nameSimilarity(x.r.merchant, y.r.merchant) >= 0.9) why(35, `two receipts with the same merchant, total ${x.r.total.toFixed(2)} and date ${x.r.date}`);
    const receiptMatch = reasons.length > 0;
    const sameEmp = x.employee && x.employee.toLowerCase() === y.employee.toLowerCase();
    const sim = nameSimilarity(x.merchant, y.merchant);
    const dx = parseDate(x.date); const dy = parseDate(y.date); const days = dx !== null && dy !== null ? Math.abs(dx - dy) / DAY : null;
    const amtEq = Math.abs(x.amount - y.amount) <= 0.005; const amtNear = Math.abs(x.amount - y.amount) <= Math.max(0.01, tolPct * Math.max(x.amount, y.amount));
    const fuzzy = sameEmp && sim >= 0.85 && amtNear && days !== null && days <= win;
    if (!receiptMatch && !fuzzy) continue;
    if (sameEmp) why(10, 'same employee');
    if (sim >= 0.85) why(sim >= 0.999 ? 15 : 10, sim >= 0.999 ? 'same merchant' : `similar merchant names (${Math.round(sim * 100)}%)`);
    if (amtEq) why(20, `same amount ${x.amount.toFixed(2)}`); else if (amtNear) why(10, `amounts within ${Math.round(tolPct * 1000) / 10}% (${x.amount.toFixed(2)} / ${y.amount.toFixed(2)})`);
    if (days === 0) why(15, 'same date'); else if (days !== null && days <= win) why(8, `dates ${days} day(s) apart`);
    const kind = sameEmp && sim >= 0.999 && amtEq && days === 0 ? 'exact' : receiptMatch ? 'receipt' : 'fuzzy';
    pairs.push({ a: `${x.report_id}/${x.line_id}`, a_source: x.source, b: `${y.report_id}/${y.line_id}`, b_source: y.source, employee: sameEmp ? x.employee : `${x.employee} / ${y.employee}`, amount: x.amount, kind, receipt_match: receiptMatch, score: Math.min(100, score), reasons: reasons.sort((p, q) => q.points - p.points) });
  }
  pairs.sort((p, q) => q.score - p.score || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  return {
    ...(notPaired.length ? { not_paired: notPaired } : {}),
    pairs: pairs.length, cross_period: pairs.filter((p) => p.b_source === 'history' || p.a_source === 'history').length, date_window_days: win, amount_tolerance_pct: tolPct, items: pairs,
    note: 'Possible duplicates for a person to check. Not a finding of wrongdoing and not fraud detection.',
  };
}

export const DEFAULT_RISK_WEIGHTS = {
  disallowed_category: 30, possible_duplicate: 30, receipt_reused: 30, receipt_amount_mismatch: 25, preapproval_missing: 25, receipt_date_mismatch: 15,
  missing_receipt: 15, receipt_not_found: 15, late_submission: 10, over_limit: 10, mileage_mismatch: 10, attendees_missing: 8, missing_purpose: 8,
  currency_review: 5, unknown_category: 10, per_diem_rate_missing: 5, mileage_rate_missing: 5, miles_missing: 8, cross_period_duplicate: 30, amount_per_100: 1, amount_max: 15,
};

/**
 * Rank reports for a person's attention. Score = sum of finding weights + duplicate pairs
 * against history + 1 point per 100 claimed (max 15), capped at 100. Every point has a reason.
 */
export function auditQueue(review, dups, weights = {}) {
  const w = { ...DEFAULT_RISK_WEIGHTS, ...weights };
  const queue = review.report_summaries.map((s) => {
    const reasons = [];
    for (const l of review.items.filter((x) => x.report_id === s.report_id)) for (const f of l.findings) {
      const pts = w[f.check] ?? 5; reasons.push({ points: pts, reason: `${l.line_id}: ${f.check} (${f.policy_section})` });
    }
    for (const p of (dups ? dups.items : []).filter((d) => (d.a_source === 'history' || d.b_source === 'history') && [d.a, d.b].some((id) => id.startsWith(`${s.report_id}/`)))) {
      const mine = p.a.startsWith(`${s.report_id}/`) ? p.a : p.b; const other = mine === p.a ? p.b : p.a;
      reasons.push({ points: w.cross_period_duplicate, reason: `${mine.slice(s.report_id.length + 1)}: possible duplicate of earlier ${other} (${p.kind}, score ${p.score})` });
    }
    const amt = Math.min(w.amount_max, Math.floor(s.claimed / 100) * w.amount_per_100);
    if (amt > 0) reasons.push({ points: amt, reason: `claimed ${s.claimed.toFixed(2)} ${review.currency}` });
    reasons.sort((p, q) => q.points - p.points || p.reason.localeCompare(q.reason));
    const score = Math.min(100, reasons.reduce((t, r) => t + r.points, 0));
    return { report_id: s.report_id, employee: s.employee, claimed: s.claimed, recommended: s.recommended, recommendation: s.recommendation, score, tier: score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low', reasons };
  });
  queue.sort((p, q) => q.score - p.score || q.claimed - p.claimed || p.report_id.localeCompare(q.report_id));
  queue.forEach((q, i) => { q.rank = i + 1; });
  return {
    reports: queue.length, high: queue.filter((q) => q.tier === 'high').length, medium: queue.filter((q) => q.tier === 'medium').length, low: queue.filter((q) => q.tier === 'low').length,
    weights: w, queue, note: 'An order for a person to review in, with the reason for every point. Not fraud detection and not a finding about anyone.',
  };
}

export const QUEUE_COLUMNS = ['rank', 'report_id', 'employee', 'claimed', 'recommended', 'recommendation', 'score', 'tier', 'reasons', 'reviewer', 'reviewer_decision'];
export const queueCsv = (q) => toCsv(q.queue.map((x) => ({ ...x, claimed: x.claimed.toFixed(2), recommended: x.recommended.toFixed(2), reasons: x.reasons.map((r) => `+${r.points} ${r.reason}`).join('; '), reviewer: '', reviewer_decision: '' })), QUEUE_COLUMNS);

/** Self-contained HTML evidence pack (no scripts, no network). */
export function evidenceHtml({ review, queue, dups, manifest }) {
  const e = escapeHtml; const money = (n) => Number(n).toFixed(2);
  const tiles = [['Reports', review.reports], ['Claimed', `${money(review.claimed)} ${review.currency}`], ['Recommended', `${money(review.recommended)} ${review.currency}`], ['High priority', queue.high], ['Possible duplicates', dups.pairs]];
  const b = [`<h1>Expense review evidence pack</h1><p class="mut">Policy: ${e(review.policy_source)}</p>`, `<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span class="mut">${e(k)}</span><b>${e(v)}</b></div>`).join('')}</div>`];
  b.push('<h2>Review order</h2><div class="wrap"><table><tr><th>#</th><th>Report</th><th>Employee</th><th class="num">Claimed</th><th class="num">Recommended</th><th>Recommendation</th><th class="num">Score</th><th>Why</th></tr>');
  for (const q of queue.queue) b.push(`<tr><td>${q.rank}</td><td>${e(q.report_id)}</td><td>${e(q.employee)}</td><td class="num">${money(q.claimed)}</td><td class="num">${money(q.recommended)}</td><td>${e(q.recommendation)}</td><td class="num ${q.tier === 'high' ? 'bad' : q.tier === 'medium' ? 'warn' : 'ok'}">${q.score}</td><td>${q.reasons.map((r) => `+${r.points} ${e(r.reason)}`).join('<br>')}</td></tr>`);
  b.push('</table></div><h2>Findings with policy sections</h2><div class="wrap"><table><tr><th>Line</th><th>Check</th><th>Section</th><th>Detail</th><th>Line decision</th></tr>');
  for (const l of review.items) for (const f of l.findings) b.push(`<tr><td>${e(`${l.report_id}/${l.line_id}`)}</td><td>${e(f.check)}</td><td>${e(f.policy_section)}</td><td>${e(f.detail)}</td><td>${e(l.decision)}</td></tr>`);
  b.push('</table></div><h2>Possible duplicates</h2>');
  if (!dups.items.length) b.push('<p class="mut">None found.</p>');
  else { b.push('<div class="wrap"><table><tr><th>Line</th><th>Other line</th><th>Kind</th><th class="num">Score</th><th>Why</th></tr>'); for (const d of dups.items) b.push(`<tr><td>${e(d.a)}</td><td>${e(d.b)}${d.b_source === 'history' ? ' <span class="mut">(earlier)</span>' : ''}</td><td>${e(d.kind)}</td><td class="num">${d.score}</td><td>${d.reasons.map((r) => e(r.reason)).join('; ')}</td></tr>`); b.push('</table></div>'); }
  b.push('<h2>Inputs (sha256)</h2><div class="wrap"><table><tr><th>File</th><th>sha256</th></tr>');
  for (const [f, h] of Object.entries(manifest.inputs)) b.push(`<tr><td>${e(f)}</td><td><code>${e(h)}</code></td></tr>`);
  b.push('</table></div>');
  return htmlPage({ title: 'Expense review evidence pack', bodyHtml: b.join('\n'), footer: `${review.note} Receipt text is not included; receipts are identified by hash.` });
}
