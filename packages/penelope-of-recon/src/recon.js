import { toCsv, toNumber, round2 } from 'mythos-agent-core';

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
  for (const b of bank) {
    if (!b.reference) continue;
    const g = gl.find((x) => !usedG.has(x.id) && x.reference && x.reference.toLowerCase() === b.reference.toLowerCase() && eq(x.amount, b.amount, tol));
    if (g) { usedB.add(b.id); usedG.add(g.id); matches.push({ type: 'reference', confidence: 'high', bank: [b.id], gl: [g.id], amount: b.amount, note: `reference ${b.reference}` }); }
  }
  for (const b of bank) {
    if (usedB.has(b.id)) continue;
    const c = gl.filter((x) => !usedG.has(x.id) && eq(x.amount, b.amount, tol) && near(x.date, b.date, w));
    if (!c.length) continue;
    c.sort((x, y) => Math.abs(day(x.date) - day(b.date)) - Math.abs(day(y.date) - day(b.date)));
    usedB.add(b.id); usedG.add(c[0].id);
    matches.push({ type: 'amount_date', confidence: c.length > 1 ? 'low' : 'medium', bank: [b.id], gl: [c[0].id], amount: b.amount, note: c.length > 1 ? `ambiguous: ${c.length} GL lines with this amount` : `same amount, ${Math.abs(day(c[0].date) - day(b.date))} day(s) apart` });
  }
  for (const b of bank) {
    if (usedB.has(b.id) || b.amount === null) continue;
    const pool = gl.filter((x) => !usedG.has(x.id) && x.amount !== null && Math.sign(x.amount) === Math.sign(b.amount) && near(x.date, b.date, w)).slice(0, 14);
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
  const bankOnly = bank.filter((b) => !usedB.has(b.id)).map((b) => { const k = KIND.find(([re]) => re.test(b.description)); return { ...b, kind: k ? k[1] : 'not_in_gl', suggestion: k ? k[2] : 'In the bank but not the GL: find the source document before any entry.', adjusting_entry: k && k[1] !== 'returned_item' ? { amount: b.amount, account: k[1] === 'bank_fee' ? 'Bank fees expense' : 'Interest income', memo: `${b.description} ${b.date}` } : null }; });
  const glOnly = gl.filter((g) => !usedG.has(g.id)).map((g) => ({ ...g, kind: g.amount >= 0 ? 'deposit_in_transit' : 'outstanding_payment', suggestion: g.amount >= 0 ? 'Deposit in transit: should clear the bank soon.' : 'Outstanding check or payment: has not cleared the bank yet.' }));
  const sum = (a) => round2(a.reduce((t, x) => t + (x.amount || 0), 0));
  let balance = null;
  const bb = toNumber(opts.bank_balance), gb = toNumber(opts.gl_balance);
  if (bb !== null && gb !== null) {
    const adjBank = round2(bb + sum(glOnly)); const adjBook = round2(gb + sum(bankOnly));
    balance = { bank_balance: bb, gl_balance: gb, adjusted_bank: adjBank, adjusted_book: adjBook, difference: round2(adjBank - adjBook), ties: Math.abs(adjBank - adjBook) < 0.005 };
  }
  return { bank_lines: bank.length, gl_lines: gl.length, matched_groups: matches.length, by_confidence: { high: matches.filter((m) => m.confidence === 'high').length, medium: matches.filter((m) => m.confidence === 'medium').length, low: matches.filter((m) => m.confidence === 'low').length },
    bank_only: bankOnly, gl_only: glOnly, matches, balance, settings: { date_window: w, amount_tolerance: tol, max_group: maxG },
    note: 'Proposed matches and entries only. A person accepts matches and approves any adjusting entry; Penelope never posts to the ledger.' };
}

export const WORKPAPER_COLUMNS = ['item', 'type', 'confidence', 'bank_ids', 'gl_ids', 'date', 'description', 'amount', 'suggestion', 'reviewer_decision', 'reviewer_name', 'review_date'];
export function workpaperCsv(r, bank, gl) {
  const by = new Map([...bank, ...gl].map((x) => [x.id, x]));
  const rows = [
    ...r.matches.map((m, i) => ({ item: `M${i + 1}`, type: `match:${m.type}`, confidence: m.confidence, bank_ids: m.bank.join(' '), gl_ids: m.gl.join(' '), date: by.get(m.bank[0]).date, description: by.get(m.bank[0]).description, amount: m.amount, suggestion: m.note })),
    ...r.bank_only.map((b) => ({ item: b.id, type: b.kind, confidence: '', bank_ids: b.id, gl_ids: '', date: b.date, description: b.description, amount: b.amount, suggestion: b.suggestion })),
    ...r.gl_only.map((g) => ({ item: g.id, type: g.kind, confidence: '', bank_ids: '', gl_ids: g.id, date: g.date, description: g.description, amount: g.amount, suggestion: g.suggestion })),
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
