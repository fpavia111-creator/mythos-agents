import { toCsv } from 'mythos-agent-core';

const n = (s) => String(s ?? '').trim();
const low = (s) => n(s).toLowerCase();
const DEFAULT_PRIV = /\b(admin|administrator|full ?access|owner|super ?user|root|superadmin|global admin|finance approver|payments?|treasury|security admin)\b/i;
const SHARED = /^(admin|administrator|shared|generic|test|temp|service|info|accounts?|ops)[@._-]/i;

function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === want); if (k) return row[k]; }
  return '';
}

export function normalizeAccess(rows) {
  return rows.map((r, i) => ({
    row: i + 2,
    system: n(col(r, ['system', 'app', 'application', 'tool'])),
    user: n(col(r, ['user', 'username', 'name', 'account', 'login'])),
    email: low(col(r, ['email', 'mail', 'useremail'])),
    account_type: low(col(r, ['accounttype', 'type', 'kind'])) || 'human',
    role: n(col(r, ['role', 'roles', 'permission', 'permissions', 'group', 'access'])),
    owner: n(col(r, ['owner', 'manager', 'accountowner', 'sponsor'])),
    last_login: n(col(r, ['lastlogin', 'lastlogon', 'lastused', 'lastactive', 'lastseen'])),
    status: low(col(r, ['status', 'state'])) || 'active',
    mfa: low(col(r, ['mfa', '2fa', 'mfaenabled', 'twofactor'])),
  }));
}

export function normalizeRoster(rows) {
  const m = new Map();
  for (const r of rows) {
    const email = low(col(r, ['email', 'mail', 'workemail']));
    if (email) m.set(email, { status: low(col(r, ['status', 'employmentstatus', 'state'])) || 'active', termination_date: n(col(r, ['terminationdate', 'enddate', 'leftdate'])), manager: n(col(r, ['manager'])) });
  }
  return m;
}

function days(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : null;
}

/** Flag access rows for a human reviewer. Suggestions only; nothing is revoked here. */
export function reviewAccess(rows, roster, opts = {}) {
  const asOf = opts.as_of || new Date().toISOString().slice(0, 10);
  const stale = Number(opts.stale_days ?? 90);
  const priv = opts.privileged_roles ? new RegExp(`\\b(${opts.privileged_roles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : DEFAULT_PRIV;
  const seen = new Map();
  const items = rows.filter((r) => r.status !== 'disabled' && r.status !== 'inactive' && r.status !== 'deleted').map((r) => {
    const flags = []; let score = 0;
    const isPriv = priv.test(r.role);
    const nonHuman = r.account_type === 'agent' || r.account_type === 'service' || r.account_type === 'bot';
    if (isPriv) { flags.push('privileged_role'); score += 20; }
    if (!nonHuman && roster) {
      const hr = r.email ? roster.get(r.email) : null;
      if (!hr) { flags.push('not_in_hr_roster'); score += 30; }
      else if (/terminat|left|inactive|leaver/.test(hr.status)) { flags.push('terminated_in_hr'); score += 60; }
    }
    if (nonHuman && !r.owner) { flags.push('non_human_without_owner'); score += 40; }
    if (!r.last_login || /^never$/i.test(r.last_login)) { flags.push('never_logged_in'); score += 15; }
    else { const d = days(r.last_login, asOf); if (d === null) { flags.push('last_login_unreadable'); score += 5; } else if (d > stale) { flags.push(`stale_${d}_days`); score += 20; } }
    if (isPriv && r.mfa && /^(no|false|0|off|disabled)$/.test(r.mfa)) { flags.push('privileged_without_mfa'); score += 30; }
    if (SHARED.test(r.email || r.user)) { flags.push('shared_or_generic_account'); score += 15; }
    const key = `${low(r.system)}|${r.email || low(r.user)}`;
    if (seen.has(key)) { flags.push(`duplicate_of_row_${seen.get(key)}`); score += 10; } else seen.set(key, r.row);
    const risk = score >= 60 ? 'high' : score >= 30 ? 'medium' : score > 0 ? 'low' : 'none';
    const suggested = flags.some((f) => f === 'terminated_in_hr') ? 'revoke candidate' : risk === 'high' || risk === 'medium' ? 'review closely' : 'confirm or keep';
    return { ...r, risk, score: Math.min(100, score), flags, suggested_action: suggested };
  });
  items.sort((a, b) => b.score - a.score || a.system.localeCompare(b.system));
  const count = (k) => items.filter((i) => i.risk === k).length;
  return {
    as_of: asOf, stale_days: stale, accounts: items.length, skipped_disabled: rows.length - items.length,
    by_risk: { high: count('high'), medium: count('medium'), low: count('low'), none: count('none') },
    agents_and_services: items.filter((i) => ['agent', 'service', 'bot'].includes(i.account_type)).length,
    roster_checked: !!roster, items,
    note: 'Suggestions only. A named reviewer decides keep / modify / revoke for every line.',
  };
}

export const SHEET_COLUMNS = ['system', 'user', 'email', 'account_type', 'role', 'owner', 'last_login', 'risk', 'flags', 'suggested_action', 'reviewer_decision', 'reviewer_name', 'review_date', 'notes'];

export function sheetCsv(review) {
  return toCsv(review.items.map((i) => ({ ...i, flags: i.flags.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '', notes: '' })), SHEET_COLUMNS);
}

export function summaryMarkdown(review, generatedAt) {
  const L = ['# Access recertification', '', `Generated ${generatedAt} by ladon-of-access. As of ${review.as_of}; stale after ${review.stale_days} days.`, ''];
  L.push(`- Active accounts reviewed: ${review.accounts} (${review.skipped_disabled} disabled rows skipped)`, `- Risk: high ${review.by_risk.high}, medium ${review.by_risk.medium}, low ${review.by_risk.low}, none ${review.by_risk.none}`, `- Agents and service accounts: ${review.agents_and_services}`, `- HR roster checked: ${review.roster_checked ? 'yes' : 'no (pass "roster" to find leavers)'}`, '');
  L.push('## How to use the sheet', '', 'Open `recertification.csv`. For every line, the owner or manager fills in `reviewer_decision` (keep / modify / revoke), `reviewer_name` and `review_date`. Ladon\'s `suggested_action` is a hint, not a decision. Revocations are carried out by an admin in each system.', '');
  L.push('## Highest risk', '', '| System | User | Role | Risk | Flags |', '|---|---|---|---|---|');
  for (const i of review.items.filter((x) => x.risk === 'high' || x.risk === 'medium').slice(0, 50)) L.push(`| ${i.system} | ${i.user || i.email} | ${i.role} | ${i.risk} | ${i.flags.join(', ')} |`);
  L.push('', 'This sheet supports a review; it is not, by itself, evidence that a review happened or that access is appropriate.', '');
  return L.join('\n');
}
