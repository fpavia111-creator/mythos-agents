// Month-end roll-forward: carry last period's outstanding items into this period,
// show which cleared the bank, which are still open (with age), and tie out.

import { toNumber, round2 } from 'mythos-agent-core';
import { reconcile } from './recon.js';

const CARRY = new Set(['deposit_in_transit', 'outstanding_payment']);
const day = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? Math.floor(t / 86400000) : null; };
const sum = (a) => round2(a.reduce((t, x) => t + (x.amount || 0), 0));

/**
 * prior: rows of last period's reconciliation.csv (penelope_write_workpaper). Carried items are
 * GL-only rows (deposits in transit, outstanding payments). They clear against this period's bank
 * lines by amount, on or after their own date (minus date_window); a matching reference wins.
 */
export function rollForward(prior, bank, gl, opts = {}) {
  const w = Number(opts.date_window ?? 3), tol = Number(opts.amount_tolerance ?? 0), staleDays = Number(opts.stale_days ?? 60);
  const carried = prior.filter((r) => CARRY.has(String(r.type || '').trim())).map((r) => ({ id: `P:${r.item}`, prior_item: r.item, date: String(r.date || ''), description: String(r.description || ''), reference: String(r.reference || ''), amount: toNumber(r.amount), kind: r.type }));
  const toCheck = prior.filter((r) => ['bank_fee', 'interest', 'not_in_gl', 'returned_item'].includes(String(r.type || '').trim())).map((r) => ({ prior_item: r.item, type: r.type, date: r.date, description: r.description, amount: toNumber(r.amount), check: 'Bank-only last period: confirm an entry was posted (it is not carried as a reconciling item).' }));
  const used = new Set(); const cleared = [], open = [];
  for (const c of [...carried].sort((a, b) => a.date.localeCompare(b.date))) {
    const dc = day(c.date);
    const cand = bank.filter((b) => !used.has(b.id) && b.amount !== null && c.amount !== null && Math.abs(b.amount - c.amount) <= tol + 1e-9 && (dc === null || day(b.date) === null || day(b.date) >= dc - w)
      && !(c.reference && b.reference && c.reference.toLowerCase() !== b.reference.toLowerCase()))
      .sort((x, y) => (Number(!!(c.reference && y.reference && y.reference.toLowerCase() === c.reference.toLowerCase())) - Number(!!(c.reference && x.reference && x.reference.toLowerCase() === c.reference.toLowerCase()))) || String(x.date).localeCompare(String(y.date)) || x.row - y.row);
    if (cand.length) { used.add(cand[0].id); cleared.push({ ...c, cleared_by: cand[0].id, cleared_on: cand[0].date, days_to_clear: dc !== null && day(cand[0].date) !== null ? day(cand[0].date) - dc : null }); }
    else open.push(c);
  }
  const rest = bank.filter((b) => !used.has(b.id));
  const r = reconcile(rest, gl, { ...opts, bank_balance: undefined, gl_balance: undefined });
  const dates = [...bank, ...gl].map((x) => x.date).filter((d) => day(d) !== null).sort();
  const asOf = opts.as_of || dates[dates.length - 1] || '';
  const age = (x) => (day(asOf) !== null && day(x.date) !== null ? day(asOf) - day(x.date) : null);
  const closing = [...open.map((c) => ({ ...c, origin: 'carried' })), ...r.gl_only.map((g) => ({ id: g.id, date: g.date, description: g.description, reference: g.reference, amount: g.amount, kind: g.kind, origin: 'new' }))]
    .map((x) => { const a = age(x); return { ...x, age_days: a, stale: a !== null && a > staleDays }; })
    .sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0) || a.id.localeCompare(b.id));
  const opening = sum(carried), clearedT = sum(cleared), newT = sum(r.gl_only), closingT = sum(closing);
  const roll = { opening_outstanding: opening, cleared: clearedT, new_outstanding: newT, closing_outstanding: closingT, check: round2(opening - clearedT + newT - closingT), ties: Math.abs(opening - clearedT + newT - closingT) < 0.005 };
  let balance = null;
  const bb = toNumber(opts.bank_balance), gb = toNumber(opts.gl_balance);
  if (bb !== null && gb !== null) {
    const adjBank = round2(bb + closingT), adjBook = round2(gb + sum(r.bank_only));
    balance = { bank_balance: bb, gl_balance: gb, adjusted_bank: adjBank, adjusted_book: adjBook, difference: round2(adjBank - adjBook), ties: Math.abs(adjBank - adjBook) < 0.005 };
  }
  return { as_of: asOf, carried_in: carried.length, cleared, still_outstanding: closing.filter((x) => x.origin === 'carried'), new_outstanding: closing.filter((x) => x.origin === 'new'), closing_outstanding: closing,
    stale: closing.filter((x) => x.stale).length, stale_days: staleDays, roll_forward: roll, balance, current: { matched_groups: r.matched_groups, matches: r.matches, bank_only: r.bank_only }, prior_bank_only_to_check: toCheck,
    note: 'Carried items come from last period\'s workpaper. Stale items need a person to follow up (for example void and reissue a check under your policy). Penelope never posts.' };
}
