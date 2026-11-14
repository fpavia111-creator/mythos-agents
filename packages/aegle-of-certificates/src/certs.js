import { toNumber, toCsv } from 'mythos-agent-core';

const DAY = 86400000;
export const DEFAULTS = Object.freeze({ critical_days: 14, warn_days: 30, upcoming_days: 90 });
const RANK = { expired: 0, critical: 1, no_expiry_date: 2, warning: 3, upcoming: 4, ok: 5 };
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export const yes = (v) => /^(y|yes|true|1|on)$/i.test(String(v ?? '').trim());
export const no = (v) => /^(n|no|false|0|off)$/i.test(String(v ?? '').trim());
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
export function asOfMs(as_of) {
  const t = as_of ? parseDate(as_of) : null;
  if (as_of && t === null) throw new Error(`as_of must be YYYY-MM-DD, got "${as_of}"`);
  if (t !== null) return t;
  const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const opts = (o = {}) => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k, v]) => k in DEFAULTS && Number.isFinite(Number(v)) && v !== null && v !== '').map(([k, v]) => [k, Number(v)])) });

export function expiryStatus(days, o = DEFAULTS) {
  if (days === null) return 'no_expiry_date';
  if (days < 0) return 'expired';
  if (days <= o.critical_days) return 'critical';
  if (days <= o.warn_days) return 'warning';
  if (days <= o.upcoming_days) return 'upcoming';
  return 'ok';
}

/** Inventory rows: id, type (tls|domain|license|other), name, holder, issuer, expires, auto_renew, renewal_cost, owner, key_type, key_bits, signature, registrar_lock */
export function scanInventory(rows, a = {}) {
  const o = opts(a); const now = asOfMs(a.as_of);
  return rows.map((r, i) => {
    const type = (pick(r, 'type', 'kind', 'category') || 'other').toLowerCase();
    const name = pick(r, 'name', 'common_name', 'cn', 'domain', 'host', 'title');
    const exp = parseDate(pick(r, 'expires', 'expiry', 'expiration', 'not_after', 'valid_to', 'expires_on'));
    const days = exp === null ? null : Math.round((exp - now) / DAY);
    const st = expiryStatus(days, o);
    const autoRenew = yes(pick(r, 'auto_renew', 'autorenew'));
    const cost = toNumber(pick(r, 'renewal_cost', 'cost', 'price')) || 0;
    const owner = pick(r, 'owner', 'contact', 'responsible');
    const flags = [];
    if (!owner) flags.push('no_owner');
    if (st === 'no_expiry_date') flags.push('no_expiry_date');
    if (type === 'tls') {
      const kt = pick(r, 'key_type', 'algorithm').toUpperCase(); const bits = toNumber(pick(r, 'key_bits', 'key_size', 'bits'));
      if (bits && ((kt.startsWith('RSA') || !kt) && bits < 2048 || (kt.startsWith('EC') && bits < 256))) flags.push(`weak_key_${kt || 'RSA'}_${bits}`);
      if (/sha1|md5/i.test(pick(r, 'signature', 'signature_algorithm'))) flags.push('weak_signature');
      const issuer = pick(r, 'issuer').toLowerCase();
      if (issuer && (issuer === name.toLowerCase() || issuer === pick(r, 'holder', 'subject').toLowerCase() || /self[-\s]?signed/.test(issuer))) flags.push('self_signed');
    }
    if (type === 'domain') {
      if (no(pick(r, 'registrar_lock', 'transfer_lock', 'locked'))) flags.push('registrar_lock_off');
      if (!autoRenew) flags.push('auto_renew_off');
    }
    const soon = ['expired', 'critical', 'warning', 'upcoming'].includes(st);
    const weak = flags.some((f) => f.startsWith('weak_') || f === 'self_signed');
    const needs = [];
    if (soon && !autoRenew && cost > 0) needs.push('paid_renewal');
    if (type === 'tls' && (st === 'expired' || (['critical', 'warning'].includes(st) && !autoRenew) || weak)) needs.push('production_change');
    let next = 'none';
    if (st === 'expired') next = type === 'tls' ? 'Expired: replace now (production change, one click).' : 'Expired: renew or retire now.';
    else if (needs.includes('paid_renewal')) next = `Renew before ${iso(exp)} (costs ${cost.toFixed(2)}; one click).`;
    else if (needs.includes('production_change')) next = weak && !soon ? 'Reissue: self-signed, or weak key or signature (production change, one click).' : 'Install the renewed certificate (production change, one click).';
    else if (soon && autoRenew) next = 'Auto-renew is on: confirm it actually renewed.';
    else if (soon) next = `Renew before ${iso(exp)}.`;
    else if (st === 'no_expiry_date') next = 'Add the expiry date.';
    return { id: pick(r, 'id', 'certificate_id') || `row${i + 1}`, type, name, holder: pick(r, 'holder', 'subject', 'vendor'), issuer: pick(r, 'issuer', 'registrar'), expires: exp === null ? '' : iso(exp), days_left: days, status: st, auto_renew: autoRenew, renewal_cost: cost, owner, flags, needs, next_step: next };
  }).sort((x, y) => RANK[x.status] - RANK[y.status] || (x.days_left ?? 1e9) - (y.days_left ?? 1e9));
}

/** COI rows: vendor, coverage, limit, expires, additional_insured, certificate_id. Requirement rows: coverage, min_limit, additional_insured */
export function checkCois(cois, reqs, a = {}) {
  const o = opts(a); const now = asOfMs(a.as_of);
  const byVendor = new Map();
  for (const r of cois) { const v = pick(r, 'vendor', 'vendor_name', 'insured'); if (!v) continue; if (!byVendor.has(v)) byVendor.set(v, []); byVendor.get(v).push(r); }
  const req = (reqs || []).map((r) => ({ coverage: pick(r, 'coverage', 'type').toLowerCase(), min_limit: toNumber(pick(r, 'min_limit', 'limit', 'minimum')) || 0, ai: yes(pick(r, 'additional_insured', 'additional_insured_required')) })).filter((r) => r.coverage);
  const vendors = [];
  for (const [vendor, rows] of byVendor) {
    const gaps = []; let next = null;
    const covs = rows.map((r) => { const exp = parseDate(pick(r, 'expires', 'expiry', 'expiration')); const days = exp === null ? null : Math.round((exp - now) / DAY); if (exp !== null && (next === null || exp < next)) next = exp; return { coverage: pick(r, 'coverage', 'type').toLowerCase(), limit: toNumber(pick(r, 'limit', 'each_occurrence', 'amount')) || 0, ai: yes(pick(r, 'additional_insured')), days, status: expiryStatus(days, o), expires: exp === null ? '' : iso(exp) }; });
    const checkList = req.length ? req : [...new Set(covs.map((c) => c.coverage))].map((c) => ({ coverage: c, min_limit: 0, ai: false }));
    for (const q of checkList) {
      const c = covs.find((x) => x.coverage === q.coverage);
      if (!c) { gaps.push({ coverage: q.coverage, issue: 'missing_coverage', detail: `No ${label(q.coverage).toLowerCase()} certificate on file.` }); continue; }
      if (q.min_limit && c.limit < q.min_limit) gaps.push({ coverage: q.coverage, issue: 'limit_below_required', detail: `${label(q.coverage)} limit ${fmt(c.limit)} is below the required ${fmt(q.min_limit)}.` });
      if (q.ai && !c.ai) gaps.push({ coverage: q.coverage, issue: 'additional_insured_missing', detail: `${label(q.coverage)} does not show us as additional insured.` });
      if (c.status === 'expired') gaps.push({ coverage: q.coverage, issue: 'expired', detail: `${label(q.coverage)} expired on ${c.expires}.` });
      else if (['critical', 'warning'].includes(c.status)) gaps.push({ coverage: q.coverage, issue: 'expiring', detail: `${label(q.coverage)} expires on ${c.expires} (${c.days} days).` });
      else if (c.status === 'no_expiry_date') gaps.push({ coverage: q.coverage, issue: 'no_expiry_date', detail: `${label(q.coverage)} has no expiry date recorded.` });
    }
    vendors.push({ vendor, certificate_ids: [...new Set(rows.map((r) => pick(r, 'certificate_id', 'id')).filter(Boolean))], coverages: covs.length, next_expiry: next === null ? '' : iso(next), status: gaps.length ? 'gaps' : 'ok', gaps });
  }
  return vendors.sort((x, y) => y.gaps.length - x.gaps.length || x.vendor.localeCompare(y.vendor));
}
const label = (c) => c.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase());
const fmt = (n) => Number(n).toLocaleString('en-US');

export function scan({ inventory = [], cois = [], requirements = [], ...a }) {
  const items = scanInventory(inventory, a); const vendors = checkCois(cois, requirements, a);
  const counts = Object.fromEntries(Object.keys(RANK).map((k) => [k, items.filter((i) => i.status === k).length]));
  return { as_of: iso(asOfMs(a.as_of)), thresholds: opts(a), items, counts, vendors, vendors_with_gaps: vendors.filter((v) => v.gaps.length).length, requirements_used: requirements.length > 0 };
}

export const EXPIRY_COLUMNS = ['id', 'type', 'name', 'expires', 'days_left', 'status', 'auto_renew', 'renewal_cost', 'owner', 'flags', 'next_step', 'reviewed_by', 'action_taken'];
export const expiryCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), reviewed_by: '', action_taken: '' })), EXPIRY_COLUMNS);

export function reportMarkdown(r) {
  const L = [`# Expiry report (as of ${r.as_of})`, '', `Thresholds: critical ≤ ${r.thresholds.critical_days} days, warning ≤ ${r.thresholds.warn_days}, upcoming ≤ ${r.thresholds.upcoming_days}.`, ''];
  L.push('| Status | Id | Type | Name | Expires | Days | Flags | Next step |', '|---|---|---|---|---|---:|---|---|');
  for (const i of r.items) L.push(`| ${i.status} | ${i.id} | ${i.type} | ${i.name} | ${i.expires || '—'} | ${i.days_left ?? '—'} | ${i.flags.join(', ') || '—'} | ${i.next_step} |`);
  if (r.vendors.length) {
    L.push('', '## Vendor certificates of insurance', '', r.requirements_used ? 'Checked against your written requirement list.' : 'No requirement list given: only expiry is checked.', '');
    for (const v of r.vendors) { L.push(`- **${v.vendor}** (${v.status}${v.next_expiry ? `, next expiry ${v.next_expiry}` : ''})`); for (const g of v.gaps) L.push(`  - ${g.detail}`); }
  }
  L.push('', '_Possible gaps against your own records and requirements. Not insurance or legal advice; a person decides._', '');
  return L.join('\n');
}

export function calendarIcs(r) {
  const stamp = r.as_of.replace(/-/g, '') + 'T000000Z';
  const ev = [];
  const add = (uid, date, summary, lead) => {
    const d = date.replace(/-/g, '');
    const next = new Date(parseDate(date) + DAY).toISOString().slice(0, 10).replace(/-/g, '');
    ev.push('BEGIN:VEVENT', `UID:${uid}@aegle-of-certificates`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${summary.replace(/[,;\\]/g, (c) => '\\' + c)}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${summary.replace(/[,;\\]/g, (c) => '\\' + c)}`, `TRIGGER:-P${lead}D`, 'END:VALARM', 'END:VEVENT');
  };
  for (const i of r.items) if (i.expires) add(i.id, i.expires, `Expires: ${i.name} (${i.type})`, r.thresholds.warn_days);
  for (const v of r.vendors) if (v.next_expiry) add(`coi-${v.vendor.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, v.next_expiry, `COI expires: ${v.vendor}`, r.thresholds.warn_days);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mythos Machine//aegle-of-certificates//EN', ...ev, 'END:VCALENDAR', ''].join('\r\n');
}

export function chaseDraft(v) {
  return [`DRAFT — not sent. A person reviews and sends this.`, '', `Subject: Updated certificate of insurance needed — ${v.vendor}`, '', `Hello ${v.vendor} team,`, '',
    'Our records show the following against our written insurance requirements:', ...v.gaps.map((g) => `- ${g.detail}`), '',
    'Could you send an updated certificate of insurance that covers these points?', '', 'Thank you,', '[Your name]', '',
    '(This lists possible gaps against our own requirement list. It is not insurance or legal advice.)', ''].join('\n');
}
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vendor';
