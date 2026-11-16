// Contract terms, renewal-aware savings, owner confirmation drafts, a renewal calendar
// and period-over-period comparison. Deterministic: every date comes from as_of.
import { round2, toCsv, toIcs, slugify } from 'mythos-agent-core';

const n = (s) => String(s ?? '').trim();
const low = (s) => n(s).toLowerCase();
const DAY = 86400000;
const d2s = (t) => new Date(t).toISOString().slice(0, 10);
const parse = (s) => { const t = Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`); return Number.isFinite(t) ? t : null; };
const addYears = (s, y) => { const t = new Date(parse(s)); t.setUTCFullYear(t.getUTCFullYear() + y); return d2s(t); };

export const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    idle_days: { type: 'integer', minimum: 1 },
    downgrade_ratio: { type: 'number', minimum: 0, maximum: 1 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    default_owner: { type: 'string', format: 'email', description: 'Who confirms seats for apps with no owner' },
    apps: {
      type: 'object', description: 'Contract terms per app (app name as in the seat export, case-insensitive)',
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: {
          billing: { type: 'string', enum: ['monthly', 'annual'] },
          renewal_date: { type: 'string', format: 'date' },
          notice_days: { type: 'integer', minimum: 0 },
          min_seats: { type: 'integer', minimum: 0 },
          owner: { type: 'string', format: 'email' },
          idle_days: { type: 'integer', minimum: 1 },
          downgrade_ratio: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

/** Contract terms keyed by lower-case app name, from the policy and/or contract records (CSV/JSON rows). */
export function contractTerms(policy, rows = []) {
  const m = new Map();
  for (const [app, t] of Object.entries(policy?.apps || {})) m.set(low(app), { app, ...t });
  for (const r of rows) {
    const app = n(r.app || r.application || r.vendor); if (!app) continue;
    const t = { ...(m.get(low(app)) || { app }) };
    if (n(r.billing)) t.billing = low(r.billing).startsWith('annual') || low(r.billing) === 'yearly' ? 'annual' : 'monthly';
    if (n(r.renewal_date)) t.renewal_date = n(r.renewal_date).slice(0, 10);
    for (const k of ['notice_days', 'min_seats']) if (n(r[k]) !== '' && Number.isFinite(Number(r[k]))) t[k] = Number(r[k]);
    if (n(r.owner)) t.owner = n(r.owner);
    m.set(low(app), t);
  }
  return m;
}

/**
 * When a removal would actually save money. Monthly: from as_of. Annual: from the next
 * renewal whose notice window is still open (act_by = renewal - notice_days).
 */
export function savingWindow(terms, asOf) {
  if (!terms || !terms.billing) return { billing: 'unknown', effective: asOf, act_by: null, renewal_date: null, notice_passed: false, assumption: 'no contract terms: assumed the saving starts now (monthly billing)' };
  if (terms.billing === 'monthly') return { billing: 'monthly', effective: asOf, act_by: null, renewal_date: terms.renewal_date || null, notice_passed: false };
  if (!terms.renewal_date || parse(terms.renewal_date) === null) return { billing: 'annual', effective: null, act_by: null, renewal_date: null, notice_passed: false, assumption: 'annual billing with no renewal date: no saving counted' };
  let renewal = terms.renewal_date;
  while (parse(renewal) < parse(asOf)) renewal = addYears(renewal, 1);
  const notice = Number(terms.notice_days || 0);
  let actBy = d2s(parse(renewal) - notice * DAY);
  let passed = false;
  if (parse(actBy) < parse(asOf)) { passed = true; renewal = addYears(renewal, 1); actBy = d2s(parse(renewal) - notice * DAY); }
  return { billing: 'annual', effective: renewal, act_by: actBy, renewal_date: renewal, notice_passed: passed };
}

/** Saving over the 12 months after as_of, pro-rated by day from the effective date. */
export function proRated12(monthly, win, asOf) {
  if (!win.effective) return 0;
  const end = parse(asOf) + 365 * DAY;
  const days = Math.max(0, Math.min(365, (end - parse(win.effective)) / DAY));
  return round2((monthly * 12 * days) / 365);
}

/** Add renewal fields to a findWaste result, apply contract minimums. Mutates and returns r. */
export function applyContracts(r, terms) {
  const asOf = r.as_of;
  const counted = new Map(); // app -> seats that stay after counted removals
  const appSeats = new Map(); for (const i of r.items) appSeats.set(low(i.app), (appSeats.get(low(i.app)) || 0) + 1);
  for (const [k, v] of appSeats) counted.set(k, v);
  for (const i of r.items) {
    const t = terms.get(low(i.app));
    const win = savingWindow(t, asOf);
    Object.assign(i, { billing: win.billing, renewal_date: win.renewal_date, act_by: win.act_by, owner: t?.owner || null });
    if (i.suggested_action === 'revoke candidate' && t?.min_seats !== undefined) {
      if (counted.get(low(i.app)) - 1 < t.min_seats) { i.flags.push(`contract_minimum_${t.min_seats}`); i.est_monthly_saving = 0; }
      else counted.set(low(i.app), counted.get(low(i.app)) - 1);
    }
    if (win.notice_passed && i.suggested_action !== 'keep') i.flags.push('notice_window_passed');
    i.est_saving_next_12m = proRated12(i.est_monthly_saving, win, asOf);
    if (win.assumption) i.assumption = win.assumption;
  }
  for (const a of r.by_app) {
    const t = terms.get(low(a.app)); const win = savingWindow(t, asOf);
    const items = r.items.filter((i) => low(i.app) === low(a.app));
    a.est_monthly_saving = round2(items.reduce((s, i) => s + i.est_monthly_saving, 0));
    a.est_saving_next_12m = round2(items.reduce((s, i) => s + i.est_saving_next_12m, 0));
    Object.assign(a, { billing: win.billing, renewal_date: win.renewal_date, act_by: win.act_by, notice_passed: win.notice_passed, owner: t?.owner || null, min_seats: t?.min_seats ?? null });
    a.recommended_seats = Math.max(t?.min_seats ?? 0, a.seats - items.filter((i) => i.suggested_action === 'revoke candidate').length);
  }
  r.est_monthly_saving = round2(r.items.reduce((s, i) => s + i.est_monthly_saving, 0));
  r.est_annual_saving = round2(r.est_monthly_saving * 12);
  r.est_saving_next_12m = round2(r.items.reduce((s, i) => s + i.est_saving_next_12m, 0));
  r.renewal_note = 'est_saving_next_12m counts annual-contract savings only from the next renewal you can still give notice for, pro-rated by day; monthly and unknown terms count from as_of.';
  r.by_app.sort((a, b) => b.est_saving_next_12m - a.est_saving_next_12m || b.est_monthly_saving - a.est_monthly_saving || a.app.localeCompare(b.app));
  return r;
}

/** Prioritised actions: soonest act-by first, then biggest 12-month saving. */
export function actionList(r) {
  const rows = r.by_app.filter((a) => a.revoke_candidates || a.downgrade_candidates).map((a) => ({
    app: a.app, act_by: a.act_by || 'any time (monthly or unknown terms)', renewal_date: a.renewal_date || '', seats: a.seats, recommended_seats: a.recommended_seats,
    revoke_candidates: a.revoke_candidates, downgrade_candidates: a.downgrade_candidates, est_monthly_saving: a.est_monthly_saving, est_saving_next_12m: a.est_saving_next_12m,
    why: a.notice_passed ? 'Notice window for the coming renewal has passed; plan for the one after.' : a.act_by ? `Give notice by ${a.act_by} to true-down at the ${a.renewal_date} renewal.` : 'Seats can be removed now (monthly or unknown terms).',
  }));
  return rows.sort((x, y) => (x.act_by.startsWith('any') ? '9999' : x.act_by).localeCompare(y.act_by.startsWith('any') ? '9999' : y.act_by) || y.est_saving_next_12m - x.est_saving_next_12m);
}

/** Renewal calendar (.ics): an act-by and a renewal event per annual app. */
export function renewalIcs(r) {
  const ev = [];
  for (const a of r.by_app) {
    if (a.billing !== 'annual' || !a.renewal_date) continue;
    const desc = `${a.seats} active seat(s); ${a.revoke_candidates} revoke and ${a.downgrade_candidates} downgrade candidate(s); recommended seats at renewal: ${a.recommended_seats}${a.min_seats !== null ? ` (contract minimum ${a.min_seats})` : ''}. Estimated saving ${a.est_monthly_saving}/month. Estimates from your export; check the contract.`;
    if (a.act_by) ev.push({ uid: `helios-actby-${slugify(a.app, 'app')}-${a.act_by}@helios.local`, date: a.act_by, summary: `Seat true-down notice due: ${a.app}`, description: desc, reminders: [14, 3], categories: ['Helios', 'SaaS renewal'] });
    ev.push({ uid: `helios-renewal-${slugify(a.app, 'app')}-${a.renewal_date}@helios.local`, date: a.renewal_date, summary: `Renewal: ${a.app}`, description: desc, reminders: [30], categories: ['Helios', 'SaaS renewal'] });
  }
  ev.sort((x, y) => x.date.localeCompare(y.date) || x.summary.localeCompare(y.summary));
  return { events: ev.length, text: toIcs(ev, { prodId: '-//Mythos Machine//helios-of-seats//EN', calName: 'SaaS renewals (Helios)', stamp: `${r.as_of.replace(/-/g, '')}T000000Z` }) };
}

/**
 * Owner confirmation drafts: one Markdown draft per recipient (app owner, else default owner),
 * listing each flagged seat with a keep/remove box. Drafts only; Helios sends nothing.
 */
export function confirmationDrafts(r, { defaultOwner = null, managers = new Map() } = {}) {
  const groups = new Map();
  for (const i of r.items.filter((x) => x.suggested_action !== 'keep')) {
    const to = i.owner || defaultOwner || 'app-admin (owner not set)';
    if (!groups.has(to)) groups.set(to, []);
    groups.get(to).push(i);
  }
  const drafts = [];
  for (const [to, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cc = [...new Set(items.map((i) => managers.get(i.email)).filter(Boolean))].sort();
    const total = round2(items.reduce((s, i) => s + i.est_monthly_saving, 0));
    const L = ['<!-- DRAFT ONLY: Helios does not send this. Review, edit and send it yourself. -->', '', `To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: Please confirm ${items.length} SaaS seat(s) before ${firstActBy(items) || 'the next review'}`, '',
      'Hello,', '', `The seat review as of ${r.as_of} flagged the seats below. Please mark each one keep or remove (or downgrade) and reply. Nothing changes until an admin acts on your answer.`, '',
      '| Keep / Remove | App | User | Tier | Why flagged | Act by | Est. saving / month |', '|---|---|---|---|---|---|---:|'];
    for (const i of items) L.push(`| [ ] keep  [ ] ${i.suggested_action.startsWith('downgrade') ? 'downgrade' : 'remove'} | ${i.app} | ${i.user} | ${i.tier} | ${i.flags.join(', ')} | ${i.act_by || 'any time'} | ${i.est_monthly_saving} |`);
    L.push('', `Estimated total: ${total}/month if every flagged seat goes. Savings are estimates from the export; contract terms decide when they land.`, '', 'Thank you.', '');
    drafts.push({ to, cc, seats: items.length, est_monthly_saving: total, name: `confirm-${to.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.md`, text: L.join('\n') });
  }
  return drafts;
}
const firstActBy = (items) => items.map((i) => i.act_by).filter(Boolean).sort()[0] || null;
export const draftIndexCsv = (drafts) => toCsv(drafts.map((d) => ({ file: d.name, to: d.to, cc: d.cc.join('; '), seats: d.seats, est_monthly_saving: d.est_monthly_saving, status: 'draft - not sent' })), ['file', 'to', 'cc', 'seats', 'est_monthly_saving', 'status']);

/** Period-over-period: compare two findWaste results (earlier export vs current). */
export function compareReviews(prev, cur) {
  const key = (i) => `${low(i.app)}|${i.email || low(i.user)}`;
  // Duplicate seats for the same person and app are kept apart by occurrence (#1, #2...).
  const keyed = (items) => { const seen = new Map(); return new Map([...items].sort((a, b) => a.row - b.row).map((i) => { const k = key(i); const c = (seen.get(k) || 0) + 1; seen.set(k, c); return [`${k}#${c}`, i]; })); };
  const P = keyed(prev.items); const C = keyed(cur.items);
  const added = [], removed = [], resolved = [], new_waste = [], still_flagged = [], cost_changes = [];
  for (const [k, i] of C) {
    const o = P.get(k);
    if (!o) { added.push({ app: i.app, user: i.user, tier: i.tier, monthly_cost: i.monthly_cost, suggested_action: i.suggested_action }); if (i.suggested_action !== 'keep') new_waste.push({ app: i.app, user: i.user, flags: i.flags, est_monthly_saving: i.est_monthly_saving }); continue; }
    const was = o.suggested_action !== 'keep', is = i.suggested_action !== 'keep';
    if (was && !is) resolved.push({ app: i.app, user: i.user, was: o.suggested_action, flags_before: o.flags });
    else if (!was && is) new_waste.push({ app: i.app, user: i.user, flags: i.flags, est_monthly_saving: i.est_monthly_saving });
    else if (was && is) still_flagged.push({ app: i.app, user: i.user, flags: i.flags, est_monthly_saving: i.est_monthly_saving, flagged_since: prev.as_of });
    if ((o.monthly_cost ?? null) !== (i.monthly_cost ?? null)) cost_changes.push({ app: i.app, user: i.user, before: o.monthly_cost, after: i.monthly_cost });
  }
  for (const [k, o] of P) if (!C.has(k)) removed.push({ app: o.app, user: o.user, tier: o.tier, monthly_cost: o.monthly_cost, was: o.suggested_action });
  const spend = (r) => round2(r.items.reduce((s, i) => s + (i.monthly_cost || 0), 0));
  const byKey = (a, b) => a.app.localeCompare(b.app) || String(a.user).localeCompare(String(b.user));
  for (const l of [added, removed, resolved, new_waste, still_flagged, cost_changes]) l.sort(byKey);
  return {
    previous_as_of: prev.as_of, current_as_of: cur.as_of,
    monthly_spend_before: spend(prev), monthly_spend_after: spend(cur), monthly_spend_change: round2(spend(cur) - spend(prev)),
    waste_before: prev.est_monthly_saving, waste_after: cur.est_monthly_saving, waste_change: round2(cur.est_monthly_saving - prev.est_monthly_saving),
    seats_before: prev.seats, seats_after: cur.seats,
    added, removed, resolved, new_waste, still_flagged, cost_changes,
  };
}
