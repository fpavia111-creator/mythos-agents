import { toNumber, round2, toCsv, normalizeAddress, normalizeName, jaroWinkler, tokenSetSimilarity, slugify } from 'mythos-agent-core';

const DAY = 86400000;
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
const yes = (v) => /^(y|yes|true|1|signed)$/i.test(String(v ?? '').trim());
export function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
function asOfMs(as_of) {
  if (as_of) { const t = parseDate(as_of); if (t === null) throw new Error(`as_of must be YYYY-MM-DD, got "${as_of}"`); return t; }
  const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** Default payment threshold by year. Before 2026: 600. 2026: 2000. Later years are inflation-adjusted, so a figure must be confirmed. */
export function defaultThreshold(year) {
  if (year < 2026) return { threshold: 600, confirmed: true };
  if (year === 2026) return { threshold: 2000, confirmed: true };
  return { threshold: 2000, confirmed: false };
}
export const CARD_METHODS = /^(card|credit_?card|debit_?card|paypal|venmo|stripe|square|payment_?app|third_?party)$/i;

/** Mask a TIN: never return the full number. */
export function maskTin(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!t) return '';
  return d.length === 9 ? `•••••${d.slice(-4)}` : '(not 9 digits)';
}
export function tinFormatOk(t) {
  const s = String(t || '').trim();
  return /^\d{2}-\d{7}$/.test(s) || /^\d{3}-\d{2}-\d{4}$/.test(s) || /^\d{9}$/.test(s);
}

// ---- TIN pattern rules (structure only; no IRS TIN matching) --------------------
// EIN prefixes the IRS has never assigned. SSN: area 000, 666 and 900-999 are not
// issued; group 00 and serial 0000 are not issued. ITIN: starts with 9, digits 4-5
// in 50-65, 70-88, 90-92 or 94-99. Sources: IRS EIN prefix list, SSA SSN rules, IRS ITIN rules.
const EIN_BAD_PREFIX = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']);
const EIN_ENTITIES = /^(corp|corporation|c_?corp|s_?corp|inc|partnership|llc[-_ ]?[cp]|trust|estate|company|nonprofit|exempt|government)$/;
const PERSON_ENTITIES = /^(individual|sole_?proprietor|sole_?prop|person)$/;

export function einPatternOk(d) { return d.length === 9 && !EIN_BAD_PREFIX.has(d.slice(0, 2)); }
export function itinPatternOk(d) {
  if (d.length !== 9 || d[0] !== '9') return false;
  const g = Number(d.slice(3, 5));
  return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99);
}
export function ssnPatternOk(d) {
  if (d.length !== 9) return false;
  const area = d.slice(0, 3);
  return area !== '000' && area !== '666' && d[0] !== '9' && d.slice(3, 5) !== '00' && d.slice(5) !== '0000';
}
const placeholder = (d) => /^(\d)\1{8}$/.test(d) || d === '123456789' || d === '987654321';

/** What kind of TIN the entity type expects: 'ein', 'person' (SSN or ITIN; EIN allowed for sole proprietors) or 'any'. */
export function expectedTin(entity) {
  const e = String(entity || '').toLowerCase().trim().replace(/\s+/g, '_');
  if (PERSON_ENTITIES.test(e)) return 'person';
  if (EIN_ENTITIES.test(e)) return 'ein';
  return 'any';
}

/**
 * Structure checks per entity type. Never returns the number.
 * { shape: 'ein'|'ssn_or_itin'|'digits'|'invalid', kind: 'ein'|'ssn'|'itin'|'unknown', flags: [...] }
 */
export function tinCheck(tin, entity) {
  const s = String(tin || '').trim(); const d = s.replace(/\D/g, ''); const flags = [];
  if (!s) return { shape: 'none', kind: 'unknown', flags };
  if (!tinFormatOk(s)) return { shape: 'invalid', kind: 'unknown', flags: ['tin_format_invalid'] };
  const shape = /^\d{2}-\d{7}$/.test(s) ? 'ein' : /^\d{3}-\d{2}-\d{4}$/.test(s) ? 'ssn_or_itin' : 'digits';
  const exp = expectedTin(entity);
  const asEin = einPatternOk(d); const asItin = itinPatternOk(d); const asSsn = ssnPatternOk(d);
  let kind = 'unknown'; let ok;
  if (shape === 'ein') { kind = 'ein'; ok = asEin; }
  else if (shape === 'ssn_or_itin') { kind = d[0] === '9' ? 'itin' : 'ssn'; ok = kind === 'itin' ? asItin : asSsn; }
  else if (exp === 'ein') { kind = 'ein'; ok = asEin; }
  else if (exp === 'person') { kind = d[0] === '9' ? 'itin' : 'ssn'; ok = asItin || asSsn || (asEin && /sole/.test(String(entity))); }
  else { ok = asEin || asSsn || asItin; kind = 'unknown'; }
  if (placeholder(d)) ok = false;
  if (!ok) flags.push('tin_pattern_invalid');
  if (exp === 'ein' && shape === 'ssn_or_itin') flags.push('tin_type_mismatch');
  if (exp === 'person' && shape === 'ein' && !/sole/.test(String(entity).toLowerCase())) flags.push('tin_type_mismatch');
  return { shape, kind, flags };
}

// ---- W-8 (foreign vendors) ----------------------------------------------------
const W8_TYPES = ['W-8BEN', 'W-8BEN-E', 'W-8ECI', 'W-8EXP', 'W-8IMY'];
export function suggestedW8(entity) { return expectedTin(entity) === 'person' ? 'W-8BEN' : 'W-8BEN-E'; }
/** A W-8BEN/W-8BEN-E generally stays valid until the last day of the third calendar year after signing (exceptions exist). */
export function w8ValidUntil(signedMs) { const y = new Date(signedMs).getUTCFullYear() + 3; return Date.UTC(y, 11, 31); }
export const normW8 = (t) => { const u = String(t || '').toUpperCase().replace(/\s+/g, '').replace(/^W8/, 'W-8').replace(/^(W-8)(BEN)E$/, '$1$2-E'); return W8_TYPES.includes(u) ? u : u ? 'other' : ''; };

export function paymentTotals(payments, year) {
  const m = new Map();
  for (const p of payments) {
    const id = pick(p, 'vendor_id', 'vendor', 'id'); const d = parseDate(pick(p, 'date', 'paid_on', 'payment_date'));
    if (!id || d === null || new Date(d).getUTCFullYear() !== year) continue;
    const amt = toNumber(pick(p, 'amount', 'paid', 'total')) || 0;
    const card = CARD_METHODS.test(pick(p, 'method', 'payment_method', 'type').replace(/\s+/g, '_'));
    const t = m.get(id) || { reportable_methods: 0, card_or_third_party: 0 };
    if (card) t.card_or_third_party = round2(t.card_or_third_party + amt); else t.reportable_methods = round2(t.reportable_methods + amt);
    m.set(id, t);
  }
  return m;
}

export function check(vendors, payments = [], a = {}) {
  const now = asOfMs(a.as_of); const year = Number(a.year) || new Date(now).getUTCFullYear();
  const def = defaultThreshold(year);
  const threshold = a.threshold !== undefined && a.threshold !== null && a.threshold !== '' ? Number(a.threshold) : def.threshold;
  const confirmed = a.threshold !== undefined && a.threshold !== null && a.threshold !== '' ? true : def.confirmed;
  const refreshYears = Number(a.refresh_years) || 3; const remindDays = Number(a.remind_days) || 7;
  const totals = paymentTotals(payments, year);
  const items = vendors.map((v, i) => {
    const id = pick(v, 'vendor_id', 'id') || `row${i + 1}`;
    const name = pick(v, 'legal_name', 'name', 'vendor_name'); const country = (pick(v, 'country') || 'US').toUpperCase();
    const entity = pick(v, 'entity_type', 'tax_classification', 'entity').toLowerCase();
    const tin = pick(v, 'tin', 'ein', 'ssn', 'tax_id'); const rec = parseDate(pick(v, 'w9_received', 'w9_date', 'w9_received_date'));
    const requested = parseDate(pick(v, 'requested_date', 'last_requested', 'requested'));
    const email = pick(v, 'email', 'ap_email', 'contact_email');
    const flags = []; const notes = [];
    const foreign = !['US', 'USA', 'UNITED STATES'].includes(country);
    const w8rec = parseDate(pick(v, 'w8_received', 'w8_date')); const w8type = normW8(pick(v, 'w8_type', 'w8_form'));
    let form = 'W-9'; let checklist;
    if (foreign) {
      flags.push('foreign_vendor'); form = suggestedW8(entity);
      notes.push(`Non-US vendor: a W-8 form usually applies instead of a W-9 (often ${form}). Your preparer confirms which form applies.`);
      let validUntil = null;
      if (w8rec === null) flags.push('w8_missing');
      else {
        if (!yes(pick(v, 'w8_signed', 'signed'))) flags.push('w8_unsigned');
        if (['W-8BEN', 'W-8BEN-E', 'W-8ECI'].includes(w8type) || !w8type) { validUntil = w8ValidUntil(w8rec); if (now > validUntil) flags.push('w8_expired'); }
        if (w8type && w8type !== form) notes.push(`W-8 on file is ${w8type === 'other' ? 'an unrecognised form' : w8type}; ${form} is the usual form for this entity type. Ask your preparer.`);
      }
      if (rec !== null) notes.push('A W-9 is on file for a non-US vendor: check with your preparer whether it should be a W-8.');
      checklist = [
        { item: `Form W-8 received (often ${form}; preparer confirms)`, done: w8rec !== null },
        { item: 'W-8 signed and dated', done: w8rec !== null && !flags.includes('w8_unsigned') },
        { item: `W-8 still in its validity period${validUntil ? ` (generally to ${iso(validUntil)})` : ''}`, done: w8rec !== null && !flags.includes('w8_expired') },
        { item: 'Legal name and country match the form', done: !!name },
        { item: 'Permanent address on the form', done: !!pick(v, 'address', 'street', 'address_line1') },
      ];
    } else {
      if (rec === null) flags.push('w9_missing');
      else {
        if (!yes(pick(v, 'w9_signed', 'signed'))) flags.push('w9_unsigned');
        if ((now - rec) / DAY > refreshYears * 365) flags.push(`w9_older_than_${refreshYears}y`);
      }
      if (rec !== null && !tin) flags.push('tin_missing');
      if (tin) for (const f of tinCheck(tin, entity).flags) flags.push(f);
      if (rec !== null && entity === 'llc') flags.push('llc_classification_missing');
      if (/corp|c_corp|s_corp|corporation|inc/.test(entity)) notes.push('Shown as a corporation: ask your preparer whether reporting applies.');
      checklist = [
        { item: 'Form W-9 received', done: rec !== null },
        { item: 'W-9 signed', done: rec !== null && !flags.includes('w9_unsigned') },
        { item: 'TIN present, format and pattern plausible for the entity type (not IRS-verified)', done: !!tin && !flags.some((f) => f.startsWith('tin_')) },
        { item: 'LLC tax classification ticked (if an LLC)', done: !flags.includes('llc_classification_missing') },
        { item: `W-9 newer than ${refreshYears} years`, done: rec !== null && !flags.some((f) => f.startsWith('w9_older_than')) },
      ];
    }
    if (!name) flags.push('name_missing');
    if (!pick(v, 'address', 'street', 'address_line1')) flags.push('address_missing');
    if (!email) flags.push('email_missing');
    const t = totals.get(id) || { reportable_methods: 0, card_or_third_party: 0 };
    const over = t.reportable_methods >= threshold;
    if (t.card_or_third_party > 0) notes.push(`${t.card_or_third_party.toFixed(2)} paid by card or payment app is listed separately; your preparer decides how it is treated.`);
    let status = 'ready';
    if (foreign) status = 'ask_preparer';
    else if (flags.includes('w9_missing')) status = 'request_w9';
    else if (flags.some((f) => ['w9_unsigned', 'tin_missing', 'tin_format_invalid', 'tin_pattern_invalid', 'tin_type_mismatch', 'llc_classification_missing'].includes(f))) status = 'fix_details';
    else if (flags.some((f) => f.startsWith('w9_older_than'))) status = 'review';
    let request = 'none';
    const sinceReq = requested === null ? null : Math.round((now - requested) / DAY);
    const w8todo = foreign && flags.some((f) => ['w8_missing', 'w8_unsigned', 'w8_expired'].includes(f));
    if (['request_w9', 'fix_details', 'review'].includes(status) || w8todo) request = sinceReq === null ? 'first_request' : sinceReq >= remindDays ? 'reminder' : 'requested_recently';
    const priority = status === 'ready' ? 'none' : over ? 'high' : t.reportable_methods > 0 ? 'medium' : 'low';
    return { vendor_id: id, name, country, entity_type: entity, form_expected: form, checklist, tin_masked: maskTin(tin), tin_kind: tin && !foreign ? tinCheck(tin, entity).kind : '', address: pick(v, 'address', 'street', 'address_line1'), w9_received: rec === null ? '' : iso(rec), w8_received: w8rec === null ? '' : iso(w8rec), w8_type: w8type, email, status, flags, notes, paid_reportable_methods: t.reportable_methods, paid_card_or_third_party: t.card_or_third_party, over_threshold: over, priority, request, days_since_request: sinceReq };
  });
  const P = { high: 0, medium: 1, low: 2, none: 3 };
  items.sort((x, y) => P[x.priority] - P[y.priority] || y.paid_reportable_methods - x.paid_reportable_methods);
  const count = (s) => items.filter((i) => i.status === s).length;
  return { as_of: iso(now), year, threshold, threshold_confirmed: confirmed, vendors: items.length, ready: count('ready'), request_w9: count('request_w9'), fix_details: count('fix_details'), review: count('review'), ask_preparer: count('ask_preparer'), over_threshold_not_ready: items.filter((i) => i.over_threshold && i.status !== 'ready').length, items };
}

export const TRACKER_COLUMNS = ['vendor_id', 'name', 'status', 'form_expected', 'priority', 'flags', 'checklist_open', 'tin_masked', 'w9_received', 'paid_reportable_methods', 'paid_card_or_third_party', 'over_threshold', 'request', 'notes', 'owner', 'followed_up_on', 'resolved'];
export const trackerCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), checklist_open: i.checklist.filter((c) => !c.done).map((c) => c.item).join('; '), notes: i.notes.join(' '), over_threshold: i.over_threshold ? 'yes' : 'no', owner: '', followed_up_on: '', resolved: '' })), TRACKER_COLUMNS);

export function readinessMarkdown(r) {
  const L = [`# W-9 readiness (${r.year} payments, as of ${r.as_of})`, '', `Threshold used: ${r.threshold.toFixed(2)}${r.threshold_confirmed ? '' : ' — not confirmed for this year; set `threshold` to the figure your preparer gives you'}.`, '',
    `Ready ${r.ready} · request W-9 ${r.request_w9} · fix details ${r.fix_details} · review ${r.review} · ask preparer ${r.ask_preparer}. Over threshold and not ready: **${r.over_threshold_not_ready}**.`, '',
    '| Priority | Vendor | Status | Paid (non-card) | Flags | Next |', '|---|---|---|---:|---|---|'];
  for (const i of r.items) L.push(`| ${i.priority} | ${i.name || i.vendor_id} | ${i.status} | ${i.paid_reportable_methods.toFixed(2)} | ${i.flags.join(', ') || '—'} | ${i.request === 'none' ? '—' : i.request.replace('_', ' ')} |`);
  L.push('', '_A readiness tracker built from your records. Not tax advice and not a filing: your preparer decides what is reportable and files._', '');
  return L.join('\n');
}

export function requestDraft(i) {
  const missing = [];
  if (i.flags.includes('w9_missing')) missing.push('a completed and signed Form W-9');
  if (i.flags.includes('w9_unsigned')) missing.push('a signature on the W-9 you sent');
  if (i.flags.includes('w8_missing')) missing.push(`a completed and signed Form W-8 (usually ${i.form_expected} for your situation; please use the W-8 form that applies to you — we cannot advise which)`);
  if (i.flags.includes('w8_unsigned')) missing.push('a signature and date on the W-8 you sent');
  if (i.flags.includes('w8_expired')) missing.push('a new Form W-8, as the one on file is past its usual validity period');
  if (['tin_missing', 'tin_format_invalid', 'tin_pattern_invalid', 'tin_type_mismatch'].some((f) => i.flags.includes(f))) missing.push('your taxpayer identification number as shown on the W-9 (the number on file does not look right for your entity type; please check it)');
  if (i.flags.includes('llc_classification_missing')) missing.push('the LLC tax classification box on the W-9');
  if (i.flags.some((f) => f.startsWith('w9_older_than'))) missing.push('an updated W-9 if your name, address or classification has changed');
  if (i.flags.includes('address_missing')) missing.push('your current mailing address');
  const reminder = i.request === 'reminder';
  return [`DRAFT — not sent. A person reviews and sends this.`, '', `To: ${i.email || '[add an email address]'}`,
    `Subject: ${reminder ? 'Reminder: ' : ''}${i.form_expected === 'W-9' ? 'W-9' : 'W-8'} needed for our vendor records — ${i.name || i.vendor_id}`, '', `Hello ${i.name || 'there'},`, '',
    reminder ? `Following up on our request from ${i.days_since_request} days ago: we still need the following for our vendor records:` : 'To keep our vendor records up to date, could you send us:', ...missing.map((m) => `- ${m}`), '',
    'Please do not email your taxpayer identification number in plain text. Use our secure upload link: [add your secure link].', '', 'Thank you,', '[Your name]', ''].join('\n');
}
export const slug = (s) => slugify(s, 'vendor');

// ---- 1099 readiness summary ---------------------------------------------------
/** Vendors at or over the threshold (non-card methods) and what is still missing. Not a filing. */
export function readiness1099(r, vendorIds = null, payments = []) {
  const MISSING = { w9_missing: 'W-9', w9_unsigned: 'W-9 signature', tin_missing: 'TIN', tin_format_invalid: 'valid TIN format', tin_pattern_invalid: 'plausible TIN', tin_type_mismatch: 'TIN type matching the entity', llc_classification_missing: 'LLC classification', name_missing: 'legal name', address_missing: 'mailing address' };
  const over = r.items.filter((i) => i.over_threshold);
  const us = over.filter((i) => i.country === 'US' || i.form_expected === 'W-9');
  const rows = us.map((i) => ({ vendor_id: i.vendor_id, name: i.name, tin_masked: i.tin_masked, paid_reportable_methods: i.paid_reportable_methods, missing: i.flags.filter((f) => MISSING[f]).map((f) => MISSING[f]), w9_age_review: i.flags.some((f) => f.startsWith('w9_older_than')), notes: i.notes }))
    .map((x) => ({ ...x, ready: x.missing.length === 0 }));
  rows.sort((a, b) => Number(a.ready) - Number(b.ready) || b.paid_reportable_methods - a.paid_reportable_methods);
  const foreign = over.filter((i) => !us.includes(i)).map((i) => ({ vendor_id: i.vendor_id, name: i.name, paid_reportable_methods: i.paid_reportable_methods, form_expected: i.form_expected, flags: i.flags.filter((f) => f.startsWith('w8_')) }));
  const cardOnly = r.items.filter((i) => !i.over_threshold && i.paid_card_or_third_party >= r.threshold).map((i) => ({ vendor_id: i.vendor_id, name: i.name, paid_card_or_third_party: i.paid_card_or_third_party }));
  const known = new Set(vendorIds || r.items.map((i) => i.vendor_id));
  const unknown = new Map();
  for (const p of payments) { const id = pick(p, 'vendor_id', 'vendor', 'id'); const d = parseDate(pick(p, 'date', 'paid_on', 'payment_date')); if (!id || known.has(id) || d === null || new Date(d).getUTCFullYear() !== r.year) continue; unknown.set(id, round2((unknown.get(id) || 0) + (toNumber(pick(p, 'amount', 'paid', 'total')) || 0))); }
  return {
    year: r.year, threshold: r.threshold, threshold_confirmed: r.threshold_confirmed, as_of: r.as_of,
    over_threshold: rows.length, ready: rows.filter((x) => x.ready).length, missing_data: rows.filter((x) => !x.ready).length,
    rows, foreign_over_threshold: foreign, card_or_app_only: cardOnly,
    payments_without_vendor_record: [...unknown].map(([vendor_id, amount]) => ({ vendor_id, amount })),
    filing: 'none — Auxo never files with the IRS; your preparer decides what is reportable and files.',
  };
}
export const READINESS_COLUMNS = ['vendor_id', 'name', 'tin_masked', 'paid_reportable_methods', 'ready', 'missing', 'w9_age_review', 'owner', 'resolved'];
export const readinessCsv = (x) => toCsv(x.rows.map((r) => ({ ...r, ready: r.ready ? 'yes' : 'no', missing: r.missing.join('; '), w9_age_review: r.w9_age_review ? 'yes' : 'no', owner: '', resolved: '' })), READINESS_COLUMNS);
export function readiness1099Markdown(x) {
  const m = (n) => Number(n).toFixed(2);
  const L = [`# 1099 readiness summary (${x.year} payments, as of ${x.as_of})`, '', `Threshold used: ${m(x.threshold)}${x.threshold_confirmed ? '' : ' — not confirmed for this year; set `threshold` to the figure your preparer gives you'}. Payments by card or payment app are not counted here.`, '',
    `At or over the threshold: **${x.over_threshold}** US vendor(s): ${x.ready} ready, **${x.missing_data} missing data**.`, '',
    '| Vendor | TIN (masked) | Paid (non-card) | Missing |', '|---|---|---:|---|'];
  for (const r of x.rows) L.push(`| ${r.name || r.vendor_id} | ${r.tin_masked || '—'} | ${m(r.paid_reportable_methods)} | ${r.missing.join(', ') || (r.w9_age_review ? 'nothing (W-9 is old: review)' : 'nothing')} |`);
  if (x.foreign_over_threshold.length) { L.push('', '## Non-US vendors over the threshold (W-8; ask your preparer)', ''); for (const f of x.foreign_over_threshold) L.push(`- ${f.name || f.vendor_id}: ${m(f.paid_reportable_methods)}; ${f.flags.join(', ') || 'W-8 on file'} (usually ${f.form_expected})`); }
  if (x.card_or_app_only.length) { L.push('', '## Paid by card or payment app at or over the threshold', '', 'Listed for your preparer; how these are treated is their call.', ''); for (const c of x.card_or_app_only) L.push(`- ${c.name || c.vendor_id}: ${m(c.paid_card_or_third_party)}`); }
  if (x.payments_without_vendor_record.length) { L.push('', '## Payments with no vendor record', ''); for (const u of x.payments_without_vendor_record) L.push(`- ${u.vendor_id}: ${m(u.amount)} — add a vendor record`); }
  L.push('', '_A readiness summary from your own records. Not tax advice and not a filing: Auxo never e-files. TINs are checked for format and pattern only, not matched with the IRS._', '');
  return L.join('\n');
}

// ---- Duplicate vendor records ---------------------------------------------------
/**
 * Pairs of vendor records that may be the same payee: same TIN (compared in memory,
 * never output), very similar names, or same address/email with similar names.
 * Flags split_under_threshold when the combined total reaches the threshold but each record alone does not.
 */
export function findDuplicates(vendors, payments = [], a = {}) {
  const r = check(vendors, payments, a);
  const byId = new Map(r.items.map((i) => [i.vendor_id, i]));
  const recs = vendors.map((v, i) => ({ id: pick(v, 'vendor_id', 'id') || `row${i + 1}`, name: pick(v, 'legal_name', 'name', 'vendor_name'), alt: pick(v, 'name'), tin: pick(v, 'tin', 'ein', 'ssn', 'tax_id').replace(/\D/g, ''), addr: normalizeAddress(pick(v, 'address', 'street', 'address_line1')), email: pick(v, 'email', 'ap_email', 'contact_email').toLowerCase() }));
  const min = Number.isFinite(Number(a.name_threshold)) && a.name_threshold !== undefined ? Number(a.name_threshold) : 0.92;
  // Only pairs that can produce a reason are scored. Same TIN and same email come from
  // indexes; a similar name needs nameSimilarity >= min, which is ruled out exactly with
  // a bound on Jaro-Winkler (shared characters) and on token overlap. Same results as
  // comparing every pair, in the same order.
  const forms = recs.map((x) => [prep(x.name), prep(x.alt)]);
  const cand = recs.map(() => new Set());
  const link = (idx) => { for (const ids of idx.values()) for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) cand[ids[p]].add(ids[q]); };
  const index = (key) => { const m = new Map(); recs.forEach((x, i) => { const k = key(x); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(i); } }); return m; };
  link(index((x) => (x.tin.length === 9 ? x.tin : '')));
  link(index((x) => x.email));
  if (!(min > 0)) for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) cand[i].add(j);
  else for (const k of [0, 1]) {
    const tok = new Map();
    forms.forEach((f, i) => { if (f[k]) for (const t of f[k].tokens) { if (!tok.has(t)) tok.set(t, []); tok.get(t).push(i); } });
    for (const ids of tok.values()) for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) cand[ids[p]].add(ids[q]);
    // Names that share no word. Their score is a Jaro-Winkler score, of the names or of
    // their sorted words. When the first letters differ there is no Winkler bonus, so
    // the score is plain Jaro, and Jaro >= min needs at least need * length shared
    // characters (need = 3 * min - 2): two such names must share one of the rarest
    // (length - need * length + 1) characters of each (prefix filtering). Names with
    // the same first letter are bounded pair by pair. With a threshold of 2/3 or
    // lower that tells us nothing, and every pair is bounded.
    const live = forms.map((f, i) => i).filter((i) => forms[i][k]);
    const need = 3 * min - 2;
    const floor = min - 1e-12;
    const test = (i, j) => { const lo = i < j ? i : j, hi = i < j ? j : i; if (jwBound(forms[lo][k], forms[hi][k], floor) && !cand[lo].has(hi)) cand[lo].add(hi); };
    if (!(need > 0)) { for (let p = 0; p < live.length; p++) for (let q = p + 1; q < live.length; q++) test(live[p], live[q]); continue; }
    const first = new Map();
    for (const i of live) for (const key of new Set(['n' + forms[i][k].n[0], 's' + forms[i][k].sorted[0]])) { if (!first.has(key)) first.set(key, []); first.get(key).push(i); }
    for (const ids of first.values()) for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) test(ids[p], ids[q]);
    const elems = new Map(); const freq = new Map();
    for (const i of live) { const occ = new Map(); const e = []; for (const ch of forms[i][k].n) { const o = (occ.get(ch) || 0) + 1; occ.set(ch, o); const code = ch + o; e.push(code); freq.set(code, (freq.get(code) || 0) + 1); } elems.set(i, e); }
    const post = new Map(); const stamp = new Int32Array(recs.length).fill(-1);
    for (const i of live) {
      const e = elems.get(i).sort((x, y) => freq.get(x) - freq.get(y) || (x < y ? -1 : x > y ? 1 : 0));
      const l = e.length, keep = Math.min(l, Math.max(1, l - Math.ceil(need * l - 1e-9) + 1));
      for (let t = 0; t < keep; t++) {
        const list = post.get(e[t]);
        if (list) for (const j of list) if (stamp[j] !== i) { stamp[j] = i; test(j, i); }
      }
      for (let t = 0; t < keep; t++) { if (!post.has(e[t])) post.set(e[t], []); post.get(e[t]).push(i); }
    }
  }
  const pairs = [];
  for (let i = 0; i < recs.length; i++) for (const j of [...cand[i]].sort((p, q) => p - q)) {
    const x = recs[i], y = recs[j]; const reasons = [];
    const sim = Math.max(simPrepped(forms[i][0], forms[j][0]), simPrepped(forms[i][1], forms[j][1]));
    if (x.tin.length === 9 && x.tin === y.tin) reasons.push('same_tin');
    if (sim >= min && forms[i][0] && forms[j][0]) reasons.push('similar_name');
    if (x.addr && x.addr === y.addr && sim >= 0.75) reasons.push('same_address');
    if (x.email && x.email === y.email) reasons.push('same_email');
    if (!reasons.length || (reasons.length === 1 && reasons[0] === 'same_address')) continue;
    const A = byId.get(x.id), B = byId.get(y.id);
    const combined = round2((A ? A.paid_reportable_methods : 0) + (B ? B.paid_reportable_methods : 0));
    const split = combined >= r.threshold && !(A && A.over_threshold) && !(B && B.over_threshold);
    pairs.push({ a: x.id, b: y.id, a_name: x.name, b_name: y.name, name_similarity: Math.round(sim * 100) / 100, reasons, combined_reportable: combined, split_under_threshold: split, confidence: reasons.includes('same_tin') ? 'high' : reasons.length > 1 ? 'medium' : 'low' });
  }
  const C = { high: 0, medium: 1, low: 2 };
  pairs.sort((p, q) => Number(q.split_under_threshold) - Number(p.split_under_threshold) || C[p.confidence] - C[q.confidence] || q.combined_reportable - p.combined_reportable);
  return { year: r.year, threshold: r.threshold, vendors: recs.length, pairs, split_under_threshold: pairs.filter((p) => p.split_under_threshold).length };
}

// Name forms computed once per record, so a pair costs no regex work.
function prep(s) {
  const n = normalizeName(s); if (!n) return null;
  const counts = new Uint32Array(37);
  for (let i = 0; i < n.length; i++) { const c = n.charCodeAt(i); counts[c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : 36]++; }
  const chars = Uint8Array.from(counts.keys()).filter((c) => counts[c]);
  return { n, sorted: n.split(' ').sort().join(' '), tokens: new Set(n.split(/\s+/).filter(Boolean)), counts, chars };
}
/** Same value as nameSimilarity on the original strings. */
function simPrepped(A, B) {
  if (!A || !B) return 0;
  return Math.max(jaroWinkler(A.n, B.n), jaroWinkler(A.sorted, B.sorted), tokenSetSimilarity(A.n, B.n));
}
/**
 * Upper bound of both Jaro-Winkler scores of two names: Jaro matches cannot exceed the
 * characters the names share, and the Winkler prefix adds at most 0.4 of the gap.
 */
const jwFromMatches = (m, l1, l2) => (m ? (m / l1 + m / l2 + 1) / 3 * 0.6 + 0.4 : 0);
/** True when the bound reaches `floor`. Stops as soon as too few characters can be shared. */
function jwBound(A, B, floor) {
  const l1 = A.n.length, l2 = B.n.length;
  if (jwFromMatches(Math.min(l1, l2), l1, l2) < floor) return false;
  // Smallest number of shared characters that can still reach floor.
  const need = Math.max(1, Math.ceil(((floor - 0.4) / 0.6 * 3 - 1) / (1 / l1 + 1 / l2) - 1e-9));
  let m = l1; const ca = A.counts, cb = B.counts;
  for (const c of A.chars) { const d = ca[c] - cb[c]; if (d > 0) { m -= d; if (m < need) return false; } }
  return jwFromMatches(m, l1, l2) >= floor;
}
