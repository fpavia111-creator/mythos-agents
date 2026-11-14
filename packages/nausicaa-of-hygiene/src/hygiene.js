import { toCsv } from 'mythos-agent-core';

const s = (v) => String(v ?? '').trim();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}
const yes = (v) => /^(yes|true|1|y|opted.?in|granted|subscribed)$/i.test(s(v));
const no = (v) => /^(no|false|0|n|opted.?out|withdrawn|unsubscribed|none)$/i.test(s(v));
export const ROLE = ['admin', 'administrator', 'info', 'sales', 'support', 'help', 'contact', 'office', 'billing', 'accounts', 'hr', 'jobs', 'careers', 'marketing', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster', 'abuse', 'team', 'hello', 'enquiries', 'inquiries'];
export const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com'];
const EMAIL = /^[^\s@"(),:;<>[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const TYPO = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'hotmial.com': 'hotmail.com', 'yaho.com': 'yahoo.com', 'outlok.com': 'outlook.com' };

/** Canonical form for duplicate checks: lower-case; for Gmail, dots and +tags in the local part are ignored. */
export function canonical(email) {
  const e = s(email).toLowerCase(); const [u, d] = e.split('@'); if (!d) return e;
  const dom = d === 'googlemail.com' ? 'gmail.com' : d;
  let local = u.split('+')[0]; if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${dom}`;
}
export const normContacts = (rows) => rows.map((r, i) => ({ row: i + 2, id: s(col(r, ['id', 'contactid', 'recordid'])) || `row-${i + 2}`, email: s(col(r, ['email', 'emailaddress', 'mail'])), name: s(col(r, ['name', 'fullname', 'contactname', 'firstname'])), company: s(col(r, ['company', 'account', 'organization'])), last_activity: s(col(r, ['lastactivity', 'lastactive', 'lastengaged', 'lastopened', 'lastcontacted', 'updatedat'])), bounce: s(col(r, ['bounce', 'bounced', 'bouncestatus', 'bouncetype'])).toLowerCase(), consent: s(col(r, ['consent', 'marketingconsent', 'optin', 'emailoptin'])), consent_date: s(col(r, ['consentdate', 'optindate'])), unsubscribed: s(col(r, ['unsubscribed', 'optedout', 'unsubscribe'])), status: s(col(r, ['status', 'subscriptionstatus', 'emailstatus'])).toLowerCase() }));

const days = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.floor((y - x) / 86400000) : null; };

/** Audit a contact list. Suggestions only: suppress, fix, merge, re-permission, review, or delete candidate. */
export function audit(contacts, opts = {}) {
  const asOf = opts.as_of || new Date().toISOString().slice(0, 10);
  const stale = Number(opts.stale_days ?? 365); const reconsent = Number(opts.reconsent_days ?? 730); const supp = new Set((opts.suppression || []).map((x) => x.toLowerCase()));
  const first = new Map();
  const items = contacts.map((c) => {
    const flags = []; const e = c.email.toLowerCase(); const [local, dom] = e.split('@');
    if (!e) flags.push('missing_email');
    else if (!EMAIL.test(c.email)) flags.push('invalid_email');
    else {
      if (TYPO[dom]) flags.push(`domain_typo_${TYPO[dom]}`);
      if (ROLE.includes(local.split('+')[0])) flags.push('role_address');
      if (DISPOSABLE.includes(dom)) flags.push('disposable_domain');
      const k = canonical(e); if (first.has(k)) flags.push(`duplicate_of_${first.get(k)}`); else first.set(k, c.id);
    }
    if (/hard|permanent|invalid|5\d\d/.test(c.bounce) || c.status === 'bounced') flags.push('hard_bounce');
    else if (/soft|temporary|4\d\d/.test(c.bounce)) flags.push('soft_bounce');
    if (supp.has(e) || (dom && supp.has(dom))) flags.push('on_suppression_list');
    const unsub = yes(c.unsubscribed) || c.status === 'unsubscribed';
    const subscribed = c.status === 'subscribed' || c.status === 'active';
    if (unsub && (subscribed || yes(c.consent))) flags.push('consent_conflict_unsubscribed');
    if (!c.consent) flags.push('consent_unknown'); else if (no(c.consent)) flags.push('no_consent');
    if (yes(c.consent) && c.consent_date && days(c.consent_date, asOf) > reconsent) flags.push('consent_older_than_' + reconsent + 'd');
    const d = c.last_activity ? days(c.last_activity, asOf) : null;
    if (d !== null && d > stale) flags.push(`stale_${d}_days`); else if (!c.last_activity) flags.push('no_activity_date');
    if (!c.name) flags.push('missing_name');
    const has = (p) => flags.some((f) => f.startsWith(p));
    let action = 'keep';
    if (has('hard_bounce') || has('invalid_email') || has('on_suppression_list') || has('consent_conflict') || unsub || has('no_consent')) action = 'suppress';
    if (has('duplicate')) action = 'merge';
    if (action === 'suppress' && has('stale') && (has('hard_bounce') || has('invalid_email'))) action = 'delete_candidate';
    if (action === 'keep') { if (has('domain_typo')) action = 'fix'; else if (has('consent_unknown') || has('consent_older')) action = 're_permission'; else if (has('role_address') || has('disposable') || has('stale') || has('soft_bounce')) action = 'review'; }
    return { ...c, canonical: e ? canonical(e) : '', flags, suggested_action: action };
  });
  const count = (a) => items.filter((i) => i.suggested_action === a).length;
  const flagCounts = {}; for (const i of items) for (const f of i.flags) { const k = f.replace(/_\d+.*$|_of_.*$|_[a-z]+\.[a-z.]+$/, ''); flagCounts[k] = (flagCounts[k] || 0) + 1; }
  return { as_of: asOf, contacts: items.length, keep: count('keep'), suppress: count('suppress'), merge: count('merge'), fix: count('fix'), re_permission: count('re_permission'), review: count('review'), delete_candidates: count('delete_candidate'), flag_counts: flagCounts, items,
    note: 'Suggestions only. A person decides; Nausicaa never deletes or edits your CRM. Role and disposable lists are short built-in lists, not a verification service.' };
}

export const CLEANUP_COLUMNS = ['id', 'email', 'name', 'company', 'flags', 'suggested_action', 'reviewer_decision', 'reviewer_name', 'review_date'];
export const cleanupCsv = (r) => toCsv(r.items.filter((i) => i.suggested_action !== 'keep').map((i) => ({ ...i, flags: i.flags.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '' })), CLEANUP_COLUMNS);
