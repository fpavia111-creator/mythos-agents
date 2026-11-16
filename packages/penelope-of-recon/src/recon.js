import { toCsv, toNumber, round2, escapeHtml, htmlPage } from 'mythos-agent-core';
import { applyRules } from './rules.js';

const s = (v) => String(v ?? '').trim();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}
function amountOf(r) {
  const a = toNumber(col(r, ['amount', 'amt', 'value', 'net']));
  if (a !== null) return a;
  const dr = toNumber(col(r, ['debit', 'dr', 'withdrawal', 'withdrawals'])) || 0; const cr = toNumber(col(r, ['credit', 'cr', 'deposit', 'deposits'])) || 0;
  return round2(cr - dr);
}
/** Bank lines: deposits positive, withdrawals negative. */
export const normBank = (rows) => rows.map((r, i) => ({ side: 'bank', id: `B${i + 2}`, row: i + 2, date: s(col(r, ['date', 'postingdate', 'transactiondate', 'valuedate'])), description: s(col(r, ['description', 'memo', 'details', 'narrative', 'payee'])), reference: s(col(r, ['reference', 'ref', 'checknumber', 'check', 'docnumber'])), amount: amountOf(r) }));
/** GL cash-account lines: debits (money in) positive, credits (money out) negative. Use credit/debit columns if your export has them. */
export const normGL = (rows) => rows.map((r, i) => {
  const a = toNumber(col(r, ['amount', 'amt', 'value', 'net']));
  const dr = toNumber(col(r, ['debit', 'dr'])) || 0; const cr = toNumber(col(r, ['credit', 'cr'])) || 0;
  return { side: 'gl', id: `G${i + 2}`, row: i + 2, date: s(col(r, ['date', 'postingdate', 'trandate', 'transactiondate'])), description: s(col(r, ['memo', 'description', 'name', 'details'])), reference: s(col(r, ['reference', 'ref', 'docnumber', 'document', 'checknumber', 'tranid'])), amount: a !== null ? a : round2(dr - cr) };
});

const day = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? Math.floor(t / 86400000) : null; };
const near = (a, b, w) => { const x = day(a), y = day(b); return x !== null && y !== null && Math.abs(x - y) <= w; };
const eq = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol + 1e-9;
const KIND = [
  [/\b(fee|charge|service chg|maintenance|wire fee|overdraft)\b/i, 'bank_fee', 'Bank fee not in the GL: propose an adjusting entry to bank fees expense.'],
  [/\binterest\b/i, 'interest', 'Interest not in the GL: propose an adjusting entry to interest income.'],
  [/\b(nsf|returned|return item|chargeback)\b/i, 'returned_item', 'Returned item: confirm with AR before any entry.'],
];

/**
 * Propose bank-to-GL matches. Nothing is accepted or posted here.
 * Order: same reference + amount; then same amount within date_window (nearest date);
 * then one bank line = sum of 2..max_group GL lines within the window (deposits batched by the bank).
 */
export function reconcile(bank, gl, opts = {}) {
  const w = Number(opts.date_window ?? 3), tol = Number(opts.amount_tolerance ?? 0), maxG = Math.min(Number(opts.max_group ?? 3), 4);
  const usedB = new Set(), usedG = new Set(), matches = [];
  // Indexes so each line looks only at lines with the same reference or within the
  // date window, not at every line (10,000 x 10,000 comparisons took ~40 s before).
  // Candidates are always taken in file order, so results are the same as a full scan.
  const pos = new Map([...bank.map((x, i) => [x, i]), ...gl.map((x, i) => [x, i])]);
  const dayOf = new Map([...bank, ...gl].map((x) => [x, day(x.date)]));
  const byDay = (list) => { const m = new Map(); for (const x of list) { const d = dayOf.get(x); if (d === null) continue; if (!m.has(d)) m.set(d, []); m.get(d).push(x); } return m; };
  const glByDay = byDay(gl), bankByDay = byDay(bank);
  // The per-day lists inside the window. A very wide window (or one given as a huge
  // number) walks the days that exist instead of every day in the range.
  const daysNear = (idx, d) => {
    const out = [];
    if (!(w >= 0)) return out;
    if (2 * w + 1 > idx.size) { for (const [k, a] of idx) if (Math.abs(k - d) <= w) out.push(a); }
    else for (let k = d - w; k <= d + w; k++) { const a = idx.get(k); if (a) out.push(a); }
    return out;
  };
  const within = (idx, d) => { if (d === null) return []; const out = []; for (const a of daysNear(idx, d)) for (const x of a) out.push(x); return out.sort((x, y) => pos.get(x) - pos.get(y)); };
  // The first `limit` lines in file order inside the window that pass `ok`, by merging
  // the per-day lists (each already in file order) instead of sorting the whole window.
  const firstWithin = (idx, d, ok, limit) => {
    if (d === null) return [];
    const lists = daysNear(idx, d).filter((a) => a.length);
    const at = lists.map(() => 0); const out = [];
    while (out.length < limit) {
      let best = -1; for (let j = 0; j < lists.length; j++) if (at[j] < lists[j].length && (best < 0 || pos.get(lists[j][at[j]]) < pos.get(lists[best][at[best]]))) best = j;
      if (best < 0) break; const x = lists[best][at[best]++]; if (ok(x)) out.push(x);
    }
    return out;
  };
  // Exact-amount candidates (no tolerance) come from an amount index instead of the window.
  const cents = (a) => Math.round(a * 100);
  const glByAmount = new Map(); if (!tol) for (const x of gl) if (x.amount !== null && dayOf.get(x) !== null) { const k = cents(x.amount); if (!glByAmount.has(k)) glByAmount.set(k, []); glByAmount.get(k).push(x); }
  const glByRef = new Map(); for (const x of gl) if (x.reference) { const k = x.reference.toLowerCase(); if (!glByRef.has(k)) glByRef.set(k, []); glByRef.get(k).push(x); }
  for (const b of bank) {
    if (!b.reference) continue;
    const g = (glByRef.get(b.reference.toLowerCase()) || []).find((x) => !usedG.has(x.id) && eq(x.amount, b.amount, tol));
    if (g) { usedB.add(b.id); usedG.add(g.id); matches.push({ type: 'reference', confidence: 'high', bank: [b.id], gl: [g.id], amount: b.amount, note: `reference ${b.reference}` }); }
  }
  // Accepted, learned rules (only when the caller passes them).
  for (const m of applyRules(bank, gl, opts.rules || [], { usedB, usedG, tol, day })) matches.push(m);
  const dist = (x, b) => Math.abs(dayOf.get(x) - dayOf.get(b));
  for (const b of bank) {
    if (usedB.has(b.id)) continue;
    const db = dayOf.get(b); if (db === null) continue;
    const c = (tol || b.amount === null ? within(glByDay, db) : (glByAmount.get(cents(b.amount)) || []).filter((x) => Math.abs(dayOf.get(x) - db) <= w)).filter((x) => !usedG.has(x.id) && eq(x.amount, b.amount, tol));
    if (!c.length) continue;
    c.sort((x, y) => dist(x, b) - dist(y, b));
    usedB.add(b.id); usedG.add(c[0].id);
    matches.push({ type: 'amount_date', confidence: c.length > 1 ? 'low' : 'medium', bank: [b.id], gl: [c[0].id], amount: b.amount, note: c.length > 1 ? `ambiguous: ${c.length} GL lines with this amount` : `same amount, ${dist(c[0], b)} day(s) apart` });
  }
  for (const b of bank) {
    if (usedB.has(b.id) || b.amount === null) continue;
    const pool = firstWithin(glByDay, dayOf.get(b), (x) => !usedG.has(x.id) && x.amount !== null && Math.sign(x.amount) === Math.sign(b.amount), 14);
    let hit = null;
    const rec = (start, pick, sum) => {
      if (hit) return;
      if (pick.length >= 2 && eq(sum, b.amount, tol)) { hit = [...pick]; return; }
      if (pick.length === maxG) return;
      for (let i = start; i < pool.length; i++) { pick.push(pool[i]); rec(i + 1, pick, sum + pool[i].amount); pick.pop(); }
    };
    rec(0, [], 0);
    if (hit) { usedB.add(b.id); hit.forEach((g) => usedG.add(g.id)); matches.push({ type: 'group', confidence: 'medium', bank: [b.id], gl: hit.map((g) => g.id), amount: b.amount, note: `bank line equals ${hit.length} GL lines` }); }
  }
  // One GL line = 2..max_group bank lines (e.g. one payroll entry clearing as several debits).
  for (const g of gl) {
    if (usedG.has(g.id) || g.amount === null) continue;
    const pool = firstWithin(bankByDay, dayOf.get(g), (x) => !usedB.has(x.id) && x.amount !== null && Math.sign(x.amount) === Math.sign(g.amount), 14);
    let hit = null;
    const rec = (start, pick, sum) => {
      if (hit) return;
      if (pick.length >= 2 && eq(sum, g.amount, tol)) { hit = [...pick]; return; }
      if (pick.length === maxG) return;
      for (let i = start; i < pool.length; i++) { pick.push(pool[i]); rec(i + 1, pick, sum + pool[i].amount); pick.pop(); }
    };
    rec(0, [], 0);
    if (hit) { usedG.add(g.id); hit.forEach((b) => usedB.add(b.id)); matches.push({ type: 'group_bank', confidence: 'medium', bank: hit.map((b) => b.id), gl: [g.id], amount: g.amount, note: `GL line equals ${hit.length} bank lines` }); }
  }
  const bankOnly = bank.filter((b) => !usedB.has(b.id)).map((b) => { const k = KIND.find(([re]) => re.test(b.description)); return { ...b, kind: k ? k[1] : 'not_in_gl', suggestion: k ? k[2] : 'In the bank but not the GL: find the source document before any entry.', adjusting_entry: k && k[1] !== 'returned_item' ? { amount: b.amount, account: k[1] === 'bank_fee' ? 'Bank fees expense' : 'Interest income', memo: `${b.description} ${b.date}` } : null }; });
  const glOnly = gl.filter((g) => !usedG.has(g.id)).map((g) => ({ ...g, kind: g.amount >= 0 ? 'deposit_in_transit' : 'outstanding_payment', suggestion: g.amount >= 0 ? 'Deposit in transit: should clear the bank soon.' : 'Outstanding check or payment: has not cleared the bank yet.' }));
  const sum = (a) => round2(a.reduce((t, x) => t + (x.amount || 0), 0));
  let balance = null;
  const bb = toNumber(opts.bank_balance), gb = toNumber(opts.gl_balance);
  if (bb !== null && gb !== null) {
    const adjBank = round2(bb + sum(glOnly)); const adjBook = round2(gb + sum(bankOnly));
    balance = { bank_balance: bb, gl_balance: gb, adjusted_bank: adjBank, adjusted_book: adjBook, difference: round2(adjBank - adjBook), ties: Math.abs(adjBank - adjBook) < 0.005 };
  }
  return { bank_lines: bank.length, gl_lines: gl.length, matched_groups: matches.length, rules_applied: (opts.rules || []).length, by_confidence: { high: matches.filter((m) => m.confidence === 'high').length, medium: matches.filter((m) => m.confidence === 'medium').length, low: matches.filter((m) => m.confidence === 'low').length },
    bank_only: bankOnly, gl_only: glOnly, matches, balance, settings: { date_window: w, amount_tolerance: tol, max_group: maxG },
    note: 'Proposed matches and entries only. A person accepts matches and approves any adjusting entry; Penelope never posts to the ledger.' };
}

export const WORKPAPER_COLUMNS = ['item', 'type', 'confidence', 'bank_ids', 'gl_ids', 'date', 'description', 'reference', 'amount', 'suggestion', 'reviewer_decision', 'reviewer_name', 'review_date'];
export function workpaperCsv(r, bank, gl) {
  const by = new Map([...bank, ...gl].map((x) => [x.id, x]));
  const rows = [
    ...r.matches.map((m, i) => ({ item: `M${i + 1}`, type: `match:${m.type}`, confidence: m.confidence, bank_ids: m.bank.join(' '), gl_ids: m.gl.join(' '), date: by.get(m.bank[0]).date, description: by.get(m.bank[0]).description, reference: by.get(m.bank[0]).reference, amount: m.amount, suggestion: m.note })),
    ...r.bank_only.map((b) => ({ item: b.id, type: b.kind, confidence: '', bank_ids: b.id, gl_ids: '', date: b.date, description: b.description, reference: b.reference, amount: b.amount, suggestion: b.suggestion })),
    ...r.gl_only.map((g) => ({ item: g.id, type: g.kind, confidence: '', bank_ids: '', gl_ids: g.id, date: g.date, description: g.description, reference: g.reference, amount: g.amount, suggestion: g.suggestion })),
  ].map((x) => ({ ...x, reviewer_decision: '', reviewer_name: '', review_date: '' }));
  return toCsv(rows, WORKPAPER_COLUMNS);
}
export function summaryMarkdown(r, at) {
  const L = ['# Bank reconciliation (proposed)', '', `Generated ${at} by penelope-of-recon. Date window ${r.settings.date_window} day(s), amount tolerance ${r.settings.amount_tolerance}.`, '',
    `- Bank lines ${r.bank_lines}, GL lines ${r.gl_lines}; ${r.matched_groups} proposed match(es): high ${r.by_confidence.high}, medium ${r.by_confidence.medium}, low ${r.by_confidence.low}`,
    `- In bank only: ${r.bank_only.length} · In GL only: ${r.gl_only.length}`];
  if (r.balance) L.push(`- Adjusted bank ${r.balance.adjusted_bank} vs adjusted book ${r.balance.adjusted_book}: difference ${r.balance.difference} (${r.balance.ties ? 'ties' : 'does not tie'})`);
  L.push('', '## Proposed adjusting entries (not posted)', '', '| Bank line | Date | Description | Amount | Account |', '|---|---|---|---:|---|');
  for (const b of r.bank_only.filter((x) => x.adjusting_entry)) L.push(`| ${b.id} | ${b.date} | ${b.description} | ${b.amount} | ${b.adjusting_entry.account} |`);
  L.push('', 'A preparer accepts each match in `reconciliation.csv`; a reviewer approves any entry, which is then posted in the ledger by a person.', '');
  return L.join('\n');
}

/** Self-contained HTML reconciliation with preparer and reviewer sign-off lines (blank). No scripts. */
export function reconciliationHtml(r, bank, gl, { title = 'Bank reconciliation (proposed)', at = '', source = '' } = {}) {
  const e = escapeHtml; const by = new Map([...bank, ...gl].map((x) => [x.id, x])); const money = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));
  const tile = (l, v, c = '') => `<div class="tile"><span class="mut">${e(l)}</span><b class="${c}">${e(v)}</b></div>`;
  const b = r.balance;
  const body = [`<h1>${e(title)}</h1><p class="mut">Generated ${e(at)} by penelope-of-recon${source ? ` from ${e(source)}` : ''}. Proposed matches and entries only; nothing was posted.</p>`,
    `<div class="tiles">${tile('Bank lines', r.bank_lines)}${tile('GL lines', r.gl_lines)}${tile('Proposed matches', r.matched_groups)}${tile('Bank only', r.bank_only.length, r.bank_only.length ? 'warn' : 'ok')}${tile('GL only', r.gl_only.length, r.gl_only.length ? 'warn' : 'ok')}${b ? tile('Difference', money(b.difference), b.ties ? 'ok' : 'bad') : ''}</div>`];
  if (b) body.push('<h2>Tie-out</h2><table>', `<tr><td>Balance per bank</td><td class="num">${money(b.bank_balance)}</td></tr>`, `<tr><td>+ GL-only items (in transit / outstanding)</td><td class="num">${money(round2(b.adjusted_bank - b.bank_balance))}</td></tr>`, `<tr><th>Adjusted bank</th><th class="num">${money(b.adjusted_bank)}</th></tr>`,
    `<tr><td>Balance per book</td><td class="num">${money(b.gl_balance)}</td></tr>`, `<tr><td>+ Bank-only items (to be booked)</td><td class="num">${money(round2(b.adjusted_book - b.gl_balance))}</td></tr>`, `<tr><th>Adjusted book</th><th class="num">${money(b.adjusted_book)}</th></tr>`,
    `<tr><th>Difference</th><th class="num ${b.ties ? 'ok' : 'bad'}">${money(b.difference)} (${b.ties ? 'ties' : 'does not tie'})</th></tr></table>`);
  body.push('<h2>Proposed matches</h2><div class="wrap"><table><tr><th>Type</th><th>Confidence</th><th>Bank</th><th>GL</th><th>Description</th><th class="num">Amount</th><th>Note</th></tr>',
    ...r.matches.map((m) => `<tr><td>${e(m.type)}</td><td>${e(m.confidence)}</td><td>${e(m.bank.join(' '))}</td><td>${e(m.gl.join(' '))}</td><td>${e((by.get(m.bank[0]) || {}).description)}</td><td class="num">${money(m.amount)}</td><td>${e(m.note)}</td></tr>`),
    '</table></div><h2>Reconciling items</h2><div class="wrap"><table><tr><th>Item</th><th>Kind</th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Suggestion</th></tr>',
    ...[...r.bank_only, ...r.gl_only].map((x) => `<tr><td>${e(x.id)}</td><td>${e(x.kind)}</td><td>${e(x.date)}</td><td>${e(x.description)}</td><td class="num">${money(x.amount)}</td><td>${e(x.suggestion)}</td></tr>`),
    '</table></div><h2>Sign-off</h2><table><tr><td>Prepared by</td><td>______________________</td><td>Date</td><td>__________</td></tr><tr><td>Reviewed by</td><td>______________________</td><td>Date</td><td>__________</td></tr></table>');
  return htmlPage({ title, bodyHtml: body.join('\n'), footer: 'penelope-of-recon: proposed reconciliation for a person to review. Not accounting or audit advice. It never posts to a ledger, bank or ERP.' });
}
