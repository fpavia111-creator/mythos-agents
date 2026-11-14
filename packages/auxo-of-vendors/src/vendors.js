import { toNumber, round2, toCsv } from 'mythos-agent-core';

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
    if (foreign) { flags.push('foreign_vendor'); notes.push('Non-US vendor: a W-8 form may apply instead of a W-9. Ask your preparer.'); }
    else {
      if (rec === null) flags.push('w9_missing');
      else {
        if (!yes(pick(v, 'w9_signed', 'signed'))) flags.push('w9_unsigned');
        if ((now - rec) / DAY > refreshYears * 365) flags.push(`w9_older_than_${refreshYears}y`);
      }
      if (rec !== null && !tin) flags.push('tin_missing');
      if (tin && !tinFormatOk(tin)) flags.push('tin_format_invalid');
      if (rec !== null && entity === 'llc') flags.push('llc_classification_missing');
      if (/corp|c_corp|s_corp|corporation|inc/.test(entity)) notes.push('Shown as a corporation: ask your preparer whether reporting applies.');
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
    else if (flags.some((f) => ['w9_unsigned', 'tin_missing', 'tin_format_invalid', 'llc_classification_missing'].includes(f))) status = 'fix_details';
    else if (flags.some((f) => f.startsWith('w9_older_than'))) status = 'review';
    let request = 'none';
    const sinceReq = requested === null ? null : Math.round((now - requested) / DAY);
    if (['request_w9', 'fix_details', 'review'].includes(status)) request = sinceReq === null ? 'first_request' : sinceReq >= remindDays ? 'reminder' : 'requested_recently';
    const priority = status === 'ready' ? 'none' : over ? 'high' : t.reportable_methods > 0 ? 'medium' : 'low';
    return { vendor_id: id, name, country, entity_type: entity, tin_masked: maskTin(tin), w9_received: rec === null ? '' : iso(rec), email, status, flags, notes, paid_reportable_methods: t.reportable_methods, paid_card_or_third_party: t.card_or_third_party, over_threshold: over, priority, request, days_since_request: sinceReq };
  });
  const P = { high: 0, medium: 1, low: 2, none: 3 };
  items.sort((x, y) => P[x.priority] - P[y.priority] || y.paid_reportable_methods - x.paid_reportable_methods);
  const count = (s) => items.filter((i) => i.status === s).length;
  return { as_of: iso(now), year, threshold, threshold_confirmed: confirmed, vendors: items.length, ready: count('ready'), request_w9: count('request_w9'), fix_details: count('fix_details'), review: count('review'), ask_preparer: count('ask_preparer'), over_threshold_not_ready: items.filter((i) => i.over_threshold && i.status !== 'ready').length, items };
}

export const TRACKER_COLUMNS = ['vendor_id', 'name', 'status', 'priority', 'flags', 'tin_masked', 'w9_received', 'paid_reportable_methods', 'paid_card_or_third_party', 'over_threshold', 'request', 'notes', 'owner', 'followed_up_on', 'resolved'];
export const trackerCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), notes: i.notes.join(' '), over_threshold: i.over_threshold ? 'yes' : 'no', owner: '', followed_up_on: '', resolved: '' })), TRACKER_COLUMNS);

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
  if (i.flags.includes('tin_missing') || i.flags.includes('tin_format_invalid')) missing.push('your taxpayer identification number as shown on the W-9 (please check the format)');
  if (i.flags.includes('llc_classification_missing')) missing.push('the LLC tax classification box on the W-9');
  if (i.flags.some((f) => f.startsWith('w9_older_than'))) missing.push('an updated W-9 if your name, address or classification has changed');
  if (i.flags.includes('address_missing')) missing.push('your current mailing address');
  const reminder = i.request === 'reminder';
  return [`DRAFT — not sent. A person reviews and sends this.`, '', `To: ${i.email || '[add an email address]'}`,
    `Subject: ${reminder ? 'Reminder: ' : ''}W-9 needed for our vendor records — ${i.name || i.vendor_id}`, '', `Hello ${i.name || 'there'},`, '',
    reminder ? `Following up on our request from ${i.days_since_request} days ago: we still need the following for our vendor records:` : 'To keep our vendor records up to date, could you send us:', ...missing.map((m) => `- ${m}`), '',
    'Please do not email your taxpayer identification number in plain text. Use our secure upload link: [add your secure link].', '', 'Thank you,', '[Your name]', ''].join('\n');
}
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vendor';
