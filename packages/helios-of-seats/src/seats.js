import { toCsv, toNumber, round2 } from 'mythos-agent-core';

const n = (s) => String(s ?? '').trim();
const low = (s) => n(s).toLowerCase();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}

export function normalizeSeats(rows) {
  return rows.map((r, i) => ({
    row: i + 2,
    app: n(col(r, ['app', 'application', 'tool', 'product', 'vendor'])),
    user: n(col(r, ['user', 'name', 'username', 'member'])),
    email: low(col(r, ['email', 'useremail', 'mail'])),
    tier: n(col(r, ['tier', 'plan', 'license', 'licensetype', 'seattype', 'edition'])),
    monthly_cost: toNumber(col(r, ['monthlycost', 'costpermonth', 'cost', 'price', 'monthlyprice'])),
    last_active: n(col(r, ['lastactive', 'lastlogin', 'lastseen', 'lastused', 'lastactivity'])),
    premium_used: low(col(r, ['premiumfeaturesused', 'premiumused', 'usespremium', 'advancedfeaturesused'])),
    status: low(col(r, ['status', 'state'])) || 'active',
  }));
}

const days = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.floor((y - x) / 86400000) : null; };
const PREMIUM = /\b(pro|professional|premium|business|enterprise|plus|team|ultimate|advanced|max)\b/i;

/**
 * Find unused, idle, over-tiered, duplicate and leaver seats. Savings are estimates
 * from the cost column you supply; check your contract for minimums and renewal dates.
 */
export function findWaste(rows, opts = {}) {
  const asOf = opts.as_of || new Date().toISOString().slice(0, 10);
  const idle = Number(opts.idle_days ?? 60);
  const roster = opts.roster || null;
  const downgradeRatio = Number(opts.downgrade_ratio ?? 0.5);
  const seen = new Map();
  const items = rows.filter((r) => !/^(deactivated|disabled|removed|suspended)$/.test(r.status)).map((r) => {
    const flags = []; let action = 'keep'; let saving = 0;
    const cost = r.monthly_cost;
    if (roster && r.email) { const hr = roster.get(r.email); if (!hr) flags.push('not_in_roster'); else if (/terminat|left|inactive/.test(hr)) flags.push('leaver'); }
    const d = !r.last_active || /^never$/i.test(r.last_active) ? null : days(r.last_active, asOf);
    if (!r.last_active || /^never$/i.test(r.last_active)) flags.push('never_used');
    else if (d === null) flags.push('last_active_unreadable');
    else if (d > idle) flags.push(`idle_${d}_days`);
    const key = `${low(r.app)}|${r.email || low(r.user)}`;
    if (seen.has(key)) flags.push(`duplicate_of_row_${seen.get(key)}`); else seen.set(key, r.row);
    if (PREMIUM.test(r.tier) && /^(no|false|0|none)$/.test(r.premium_used)) flags.push('over_tiered');
    if (flags.some((f) => f === 'leaver' || f === 'never_used' || f.startsWith('idle_') || f.startsWith('duplicate'))) { action = 'revoke candidate'; saving = cost ?? 0; }
    else if (flags.includes('over_tiered')) { action = 'downgrade candidate'; saving = cost !== null ? round2(cost * downgradeRatio) : 0; }
    else if (flags.includes('not_in_roster')) action = 'check owner';
    return { ...r, flags, suggested_action: action, est_monthly_saving: round2(saving), cost_known: cost !== null };
  });
  const byApp = {};
  for (const i of items) {
    const a = (byApp[i.app || '(unknown)'] ||= { app: i.app || '(unknown)', seats: 0, monthly_cost: 0, revoke_candidates: 0, downgrade_candidates: 0, est_monthly_saving: 0, unknown_cost: 0 });
    a.seats++; if (i.monthly_cost === null) a.unknown_cost++; else a.monthly_cost = round2(a.monthly_cost + i.monthly_cost);
    if (i.suggested_action === 'revoke candidate') a.revoke_candidates++;
    if (i.suggested_action === 'downgrade candidate') a.downgrade_candidates++;
    a.est_monthly_saving = round2(a.est_monthly_saving + i.est_monthly_saving);
  }
  const monthly = round2(items.reduce((s, i) => s + i.est_monthly_saving, 0));
  const order = { 'revoke candidate': 0, 'downgrade candidate': 1, 'check owner': 2, keep: 3 };
  items.sort((a, b) => order[a.suggested_action] - order[b.suggested_action] || b.est_monthly_saving - a.est_monthly_saving);
  return {
    as_of: asOf, idle_days: idle, seats: items.length, skipped_inactive: rows.length - items.length,
    revoke_candidates: items.filter((i) => i.suggested_action === 'revoke candidate').length,
    downgrade_candidates: items.filter((i) => i.suggested_action === 'downgrade candidate').length,
    est_monthly_saving: monthly, est_annual_saving: round2(monthly * 12),
    seats_with_unknown_cost: items.filter((i) => !i.cost_known).length,
    by_app: Object.values(byApp).sort((a, b) => b.est_monthly_saving - a.est_monthly_saving), items,
    note: 'Estimates from your cost column. Check contract minimums, annual commitments and renewal dates before acting. Suggestions only.',
  };
}

export const SHEET_COLUMNS = ['app', 'user', 'email', 'tier', 'monthly_cost', 'last_active', 'flags', 'suggested_action', 'est_monthly_saving', 'reviewer_decision', 'reviewer_name', 'review_date'];
export function sheetCsv(r) {
  return toCsv(r.items.map((i) => ({ ...i, monthly_cost: i.monthly_cost ?? 'unknown', flags: i.flags.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '' })), SHEET_COLUMNS);
}
export function summaryMarkdown(r, at) {
  const L = ['# SaaS seat review', '', `Generated ${at} by helios-of-seats. As of ${r.as_of}; idle after ${r.idle_days} days.`, ''];
  L.push(`- Active seats: ${r.seats} · revoke candidates ${r.revoke_candidates} · downgrade candidates ${r.downgrade_candidates}`, `- Estimated saving: $${r.est_monthly_saving}/month (~$${r.est_annual_saving}/year)${r.seats_with_unknown_cost ? ` · ${r.seats_with_unknown_cost} seat(s) have no cost and are not counted` : ''}`, '');
  L.push('| App | Seats | Monthly cost | Revoke | Downgrade | Est. saving / month |', '|---|---:|---:|---:|---:|---:|');
  for (const a of r.by_app) L.push(`| ${a.app} | ${a.seats} | ${a.monthly_cost} | ${a.revoke_candidates} | ${a.downgrade_candidates} | ${a.est_monthly_saving} |`);
  L.push('', 'Savings are estimates. Contract minimums, annual prepay and renewal dates can mean a removed seat saves nothing until renewal. A named person decides each line in `seat-review.csv`; an admin makes the change in each app.', '');
  return L.join('\n');
}
