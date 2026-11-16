import { toCsv, readYesNo, foldText } from 'mythos-agent-core';

const s = (v) => String(v ?? '').trim();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}
// Consent and status words as CRMs in Germany, France, Spain, Brazil, Italy, Japan, China
// and Korea write them; matched on folded text (lowercase, no accents).
const YES_WORDS = /^(eingewilligt|erteilt|zugestimmt|abonniert|consenti|accepte|abonne|inscrit|aceptado|acepta|consentido|suscrito|aceito|consentiu|inscrito|assinante|accettato|consenso dato|iscritto|同意|同意済|同意済み|同意あり|購読中|已同意|同意订阅|동의|수신 ?동의|구독)$/;
const NO_WORDS = /^(widerrufen|abgemeldet|abbestellt|abgelehnt|keine einwilligung|refuse|retire|desabonne|desinscrit|rechazado|retirado|baja|dado de baja|recusado|descadastrado|revogado|revocato|rifiutato|disiscritto|拒否|配信停止|撤回|未同意|同意なし|不同意|拒绝|拒絕|退订|退訂|已退订|거부|미동의|수신 ?거부|철회)$/;
const yes = (v) => /^(yes|true|1|y|opted.?in|granted|subscribed)$/i.test(s(v)) || YES_WORDS.test(foldText(v)) || readYesNo(v) === true;
const no = (v) => /^(no|false|0|n|opted.?out|withdrawn|unsubscribed|none)$/i.test(s(v)) || NO_WORDS.test(foldText(v)) || readYesNo(v) === false;
const STATUS_WORDS = [
  ['unsubscribed', /^(abgemeldet|abbestellt|desabonne|desinscrit|dado de baja|baja|descadastrado|disiscritto|配信停止|配信解除|退订|已退订|退訂|수신 ?거부|구독 ?취소)$/],
  ['bounced', /^(unzustellbar|rebondi|rebotado|devolvido|rimbalzato|不達|退信|반송)$/],
  ['subscribed', /^(abonniert|angemeldet|abonne|inscrit|suscrito|inscrito|assinante|iscritto|配信中|購読中|已订阅|訂閱中|구독 ?중|수신 ?동의)$/],
  ['active', /^(aktiv|actif|activo|ativo|attivo|有効|启用|啟用|활성)$/],
];
/** Subscription status in any of the nine languages, as the English word Nausicaa uses; other values are kept lowercased. */
export function statusOf(v) {
  const t = s(v).toLowerCase(); if (!t) return t;
  const f = foldText(t); const hit = STATUS_WORDS.find(([, re]) => re.test(f));
  return hit ? hit[0] : t;
}
const HARD_INTL = /\b(hart|dauerhaft|definitif|dur|permanente|duro|rigido|definitivo)\b|ハード|恒久|永続|硬退回|硬退信|永久|하드|영구/;
const SOFT_INTL = /\b(weich|vorubergehend|temporaire|temporal|temporario|temporaneo)\b|ソフト|一時|软退回|软退信|暂时|暫時|소프트|일시/;
export const ROLE = ['admin', 'administrator', 'info', 'sales', 'support', 'help', 'contact', 'office', 'billing', 'accounts', 'hr', 'jobs', 'careers', 'marketing', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster', 'abuse', 'team', 'hello', 'enquiries', 'inquiries',
  // The same mailboxes in German, French, Spanish, Portuguese and Italian, and romanized Japanese, Chinese and Korean ones.
  'kontakt', 'vertrieb', 'verkauf', 'buchhaltung', 'rechnung', 'rechnungen', 'bewerbung', 'bewerbungen', 'karriere', 'empfang', 'zentrale', 'kundenservice', 'presse', 'datenschutz', 'einkauf',
  'compta', 'comptabilite', 'facturation', 'commercial', 'recrutement', 'emploi', 'accueil', 'rh', 'secretariat',
  'contacto', 'ventas', 'comercial', 'administracion', 'facturacion', 'contabilidad', 'rrhh', 'empleo', 'atencion', 'compras',
  'contato', 'vendas', 'financeiro', 'faturamento', 'contabilidade', 'atendimento', 'sac', 'suporte',
  'contatti', 'commerciale', 'amministrazione', 'fatturazione', 'contabilita', 'vendite', 'segreteria', 'ufficio', 'assistenza', 'acquisti',
  'soumu', 'somu', 'jinji', 'eigyo', 'keiri', 'otoiawase', 'kefu', 'kf'];
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
export const normContacts = (rows) => rows.map((r, i) => ({ row: i + 2, id: s(col(r, ['id', 'contactid', 'recordid'])) || `row-${i + 2}`, email: s(col(r, ['email', 'emailaddress', 'mail'])), name: s(col(r, ['name', 'fullname', 'contactname', 'firstname'])), company: s(col(r, ['company', 'account', 'organization'])), last_activity: s(col(r, ['lastactivity', 'lastactive', 'lastengaged', 'lastopened', 'lastcontacted', 'updatedat'])), bounce: s(col(r, ['bounce', 'bounced', 'bouncestatus', 'bouncetype'])).toLowerCase(), consent: s(col(r, ['consent', 'marketingconsent', 'optin', 'emailoptin'])), consent_date: s(col(r, ['consentdate', 'optindate'])), consent_source: s(col(r, ['consentsource', 'optinsource', 'consentmethod', 'optinmethod', 'consentorigin'])), unsubscribed: s(col(r, ['unsubscribed', 'optedout', 'unsubscribe'])), status: statusOf(col(r, ['status', 'subscriptionstatus', 'emailstatus'])) }));

const days = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.floor((y - x) / 86400000) : null; };

/** Audit a contact list. Suggestions only: suppress, fix, merge, re-permission, review, or delete candidate. */
export function audit(contacts, opts = {}) {
  const asOf = opts.as_of || new Date().toISOString().slice(0, 10);
  const rules = opts.rules || {};
  const stale = Number(opts.stale_days ?? rules.stale_days ?? 365); const reconsent = Number(opts.reconsent_days ?? rules.reconsent_days ?? 730); const supp = new Set((opts.suppression || []).map((x) => x.toLowerCase()));
  const role = new Set([...ROLE, ...(rules.extra_role_locals || []).map((x) => x.toLowerCase())]);
  const disposable = new Set([...DISPOSABLE, ...(rules.extra_disposable_domains || []).map((x) => x.toLowerCase())]);
  const typo = { ...TYPO, ...Object.fromEntries(Object.entries(rules.typo_domains || {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()])) };
  const first = new Map();
  const items = contacts.map((c) => {
    const flags = []; const e = c.email.toLowerCase(); const [local, dom] = e.split('@');
    if (!e) flags.push('missing_email');
    else if (!EMAIL.test(c.email)) flags.push('invalid_email');
    else {
      if (typo[dom]) flags.push(`domain_typo_${typo[dom]}`);
      if (role.has(local.split('+')[0])) flags.push('role_address');
      if (disposable.has(dom)) flags.push('disposable_domain');
      const k = canonical(e); if (first.has(k)) flags.push(`duplicate_of_${first.get(k)}`); else first.set(k, c.id);
    }
    const fb = foldText(c.bounce);
    if (/hard|permanent|invalid|5\d\d/.test(c.bounce) || c.status === 'bounced' || (fb && HARD_INTL.test(fb))) flags.push('hard_bounce');
    else if (/soft|temporary|4\d\d/.test(c.bounce) || (fb && SOFT_INTL.test(fb))) flags.push('soft_bounce');
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
  return { as_of: asOf, contacts: items.length, health: healthScore(items, flagCounts), keep: count('keep'), suppress: count('suppress'), merge: count('merge'), fix: count('fix'), re_permission: count('re_permission'), review: count('review'), delete_candidates: count('delete_candidate'), flag_counts: flagCounts, items,
    note: 'Suggestions only. A person decides; Nausicaa never deletes or edits your CRM. Role and disposable lists are short built-in lists, not a verification service.' };
}

export const CLEANUP_COLUMNS = ['id', 'email', 'name', 'company', 'flags', 'suggested_action', 'reviewer_decision', 'reviewer_name', 'review_date'];
export const cleanupCsv = (r) => toCsv(r.items.filter((i) => i.suggested_action !== 'keep').map((i) => ({ ...i, flags: i.flags.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '' })), CLEANUP_COLUMNS);

// Explainable list-health score: 100 minus weighted shares of contacts with each issue.
export const HEALTH_WEIGHTS = Object.freeze([
  ['deliverability', 1.0, ['invalid_email', 'missing_email', 'hard_bounce', 'domain_typo', 'disposable_domain', 'on_suppression_list'], 'invalid, typo, disposable, suppressed or hard-bounced addresses'],
  ['consent', 0.5, ['no_consent', 'consent_conflict_unsubscribed', 'consent_unknown', 'consent_older_than'], 'missing, refused, old or conflicting consent'],
  ['duplicates', 0.5, ['duplicate'], 'duplicate records'],
  ['engagement', 0.25, ['stale', 'soft_bounce'], 'stale records and soft bounces'],
  ['role_addresses', 0.25, ['role_address'], 'role addresses (info@, sales@ ...)'],
]);
export function healthScore(items) {
  const n = items.length || 1;
  const deductions = HEALTH_WEIGHTS.map(([area, weight, prefixes, what]) => {
    const count = items.filter((i) => i.flags.some((f) => prefixes.some((p) => f.startsWith(p)))).length;
    const pct = (100 * count) / n; const points = Math.round(weight * pct * 10) / 10;
    return { area, contacts: count, share_pct: Math.round(pct * 10) / 10, weight, points, explain: `${count} of ${items.length} contact(s) with ${what} × weight ${weight} = ${points} point(s)` };
  });
  const score = Math.max(0, Math.round(100 - deductions.reduce((t, d) => t + d.points, 0)));
  return { score, deductions: deductions.filter((d) => d.contacts), method: '100 minus, for each area, weight × percent of contacts affected. A summary of this export, not a deliverability prediction.' };
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));
/**
 * Consent provenance: for contacts that count as opted in (or are subscribed), is there a
 * consent source and a usable date? Flags: consent_source_missing, consent_date_missing,
 * consent_date_invalid, consent_date_in_future, consent_source_not_allowed (when you list
 * allowed sources), consent_status_missing (subscribed with no consent value).
 */
export function consentProvenance(contacts, { as_of: asOf = new Date().toISOString().slice(0, 10), allowed_sources: allowed = null } = {}) {
  const ok = allowed && allowed.length ? new Set(allowed.map((x) => x.toLowerCase())) : null;
  const items = contacts.map((c) => {
    const subscribed = c.status === 'subscribed' || c.status === 'active';
    const optedIn = yes(c.consent); const flags = [];
    if (yes(c.unsubscribed) || c.status === 'unsubscribed' || no(c.consent)) return { id: c.id, row: c.row, email: c.email, in_scope: false, flags };
    if (!optedIn && !subscribed) return { id: c.id, row: c.row, email: c.email, in_scope: false, flags };
    if (!c.consent) flags.push('consent_status_missing');
    if (!c.consent_source) flags.push('consent_source_missing');
    else if (ok && !ok.has(c.consent_source.toLowerCase())) flags.push('consent_source_not_allowed');
    if (!c.consent_date) flags.push('consent_date_missing');
    else if (!isDate(c.consent_date)) flags.push('consent_date_invalid');
    else if (c.consent_date > asOf) flags.push('consent_date_in_future');
    return { id: c.id, row: c.row, email: c.email, consent: c.consent, consent_source: c.consent_source, consent_date: c.consent_date, in_scope: true, flags };
  });
  const scope = items.filter((i) => i.in_scope);
  const count = (f) => scope.filter((i) => i.flags.includes(f)).length;
  return { as_of: asOf, contacts: items.length, in_scope: scope.length, complete: scope.filter((i) => !i.flags.length).length, source_missing: count('consent_source_missing'), date_missing: count('consent_date_missing'), date_invalid: count('consent_date_invalid'), date_in_future: count('consent_date_in_future'), source_not_allowed: count('consent_source_not_allowed'), status_missing: count('consent_status_missing'),
    items: scope.filter((i) => i.flags.length), note: 'Checks that the consent record you exported has a source and a date. It does not judge whether that consent is valid for your purpose. Not legal advice.' };
}
