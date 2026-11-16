import { toNumber, toCsv, toIcs, htmlPage, escapeHtml, slugify } from 'mythos-agent-core';

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
  const profile = reqs && !Array.isArray(reqs) ? reqs : null;
  const flat = normReqs(profile ? profile.default : reqs);
  const vendors = [];
  for (const [vendor, rows] of byVendor) {
    const gaps = []; let next = null;
    const category = profile ? (profile.vendors || {})[vendor] || pick(rows[0], 'category', 'vendor_category', 'trade') : pick(rows[0], 'category', 'vendor_category', 'trade');
    const set = profile && category && (profile.categories || {})[category] ? category : 'default';
    const req = set === 'default' ? flat : normReqs(profile.categories[category]);
    const covs = rows.map((r) => { const exp = parseDate(pick(r, 'expires', 'expiry', 'expiration')); const days = exp === null ? null : Math.round((exp - now) / DAY); if (exp !== null && (next === null || exp < next)) next = exp; return { coverage: pick(r, 'coverage', 'type').toLowerCase(), limit: toNumber(pick(r, 'limit', 'each_occurrence', 'amount')) || 0, ai: yes(pick(r, 'additional_insured', 'addl_insd')), wos: yes(pick(r, 'waiver_of_subrogation', 'subr_wvd')), days, status: expiryStatus(days, o), expires: exp === null ? '' : iso(exp) }; });
    const checkList = req.length ? req : [...new Set(covs.map((c) => c.coverage))].map((c) => ({ coverage: c, min_limit: 0, ai: false, wos: false }));
    for (const q of checkList) {
      const c = covs.find((x) => x.coverage === q.coverage);
      if (!c) { gaps.push({ coverage: q.coverage, issue: 'missing_coverage', detail: `No ${label(q.coverage).toLowerCase()} certificate on file.` }); continue; }
      if (q.min_limit && c.limit < q.min_limit) gaps.push({ coverage: q.coverage, issue: 'limit_below_required', detail: `${label(q.coverage)} limit ${fmt(c.limit)} is below the required ${fmt(q.min_limit)}.` });
      if (q.ai && !c.ai) gaps.push({ coverage: q.coverage, issue: 'additional_insured_missing', detail: `${label(q.coverage)} does not show us as additional insured.` });
      if (q.wos && !c.wos) gaps.push({ coverage: q.coverage, issue: 'waiver_of_subrogation_missing', detail: `${label(q.coverage)} does not show a waiver of subrogation.` });
      if (c.status === 'expired') gaps.push({ coverage: q.coverage, issue: 'expired', detail: `${label(q.coverage)} expired on ${c.expires}.` });
      else if (['critical', 'warning'].includes(c.status)) gaps.push({ coverage: q.coverage, issue: 'expiring', detail: `${label(q.coverage)} expires on ${c.expires} (${c.days} days).` });
      else if (c.status === 'no_expiry_date') gaps.push({ coverage: q.coverage, issue: 'no_expiry_date', detail: `${label(q.coverage)} has no expiry date recorded.` });
    }
    vendors.push({ vendor, requirement_set: req.length ? set : 'none', certificate_ids: [...new Set(rows.map((r) => pick(r, 'certificate_id', 'id')).filter(Boolean))], coverages: covs.length, next_expiry: next === null ? '' : iso(next), status: gaps.length ? 'gaps' : 'ok', gaps });
  }
  return vendors.sort((x, y) => y.gaps.length - x.gaps.length || x.vendor.localeCompare(y.vendor));
}
function normReqs(list) {
  return (list || []).map((r) => ({ coverage: pick(r, 'coverage', 'type').toLowerCase(), min_limit: toNumber(pick(r, 'min_limit', 'limit', 'minimum')) || 0, ai: r.additional_insured === true || yes(pick(r, 'additional_insured', 'additional_insured_required')), wos: r.waiver_of_subrogation === true || yes(pick(r, 'waiver_of_subrogation')) })).filter((r) => r.coverage);
}
const label = (c) => c.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase());
const fmt = (n) => Number(n).toLocaleString('en-US');

export function scan({ inventory = [], cois = [], requirements = [], ...a }) {
  if (requirements === null) requirements = [];
  const items = scanInventory(inventory, a); const vendors = checkCois(cois, requirements, a);
  const counts = Object.fromEntries(Object.keys(RANK).map((k) => [k, items.filter((i) => i.status === k).length]));
  return { as_of: iso(asOfMs(a.as_of)), thresholds: opts(a), items, counts, vendors, vendors_with_gaps: vendors.filter((v) => v.gaps.length).length, requirements_used: Array.isArray(requirements) ? requirements.length > 0 : !!requirements };
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

/** Reminder offsets in days before expiry: the given list, or warn and critical thresholds plus one day. */
export function reminderOffsets(r, list) {
  const src = Array.isArray(list) && list.length ? list : [r.thresholds.warn_days, r.thresholds.critical_days, 1];
  return [...new Set(src.map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => b - a);
}
export function calendarIcs(r, reminderDays) {
  const reminders = reminderOffsets(r, reminderDays); const ev = [];
  for (const i of r.items) if (i.expires) ev.push({ uid: `${slug(i.id)}@aegle-of-certificates`, date: i.expires, summary: `Expires: ${i.name} (${i.type})`, description: `Next step: ${i.next_step}`, reminders, categories: [i.type] });
  for (const v of r.vendors) if (v.next_expiry) ev.push({ uid: `coi-${slug(v.vendor)}@aegle-of-certificates`, date: v.next_expiry, summary: `COI expires: ${v.vendor}`, reminders, categories: ['coi'] });
  return toIcs(ev, { prodId: '-//Mythos Machine//aegle-of-certificates//EN', calName: 'Aegle renewals', stamp: r.as_of.replace(/-/g, '') + 'T000000Z' });
}

export function reportHtml(r) {
  const cls = { expired: 'bad', critical: 'bad', warning: 'warn', no_expiry_date: 'warn', upcoming: '', ok: 'ok' };
  const rows = r.items.map((i) => `<tr class="${cls[i.status] || ''}"><td>${escapeHtml(i.status)}</td><td>${escapeHtml(i.id)}</td><td>${escapeHtml(i.type)}</td><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.expires || '—')}</td><td class="n">${i.days_left ?? '—'}</td><td>${escapeHtml(i.flags.join(', ') || '—')}</td><td>${escapeHtml(i.next_step)}</td></tr>`).join('');
  const vend = r.vendors.map((v) => `<li><strong>${escapeHtml(v.vendor)}</strong> (${escapeHtml(v.status)}${v.next_expiry ? `, next expiry ${escapeHtml(v.next_expiry)}` : ''})${v.gaps.length ? `<ul>${v.gaps.map((g) => `<li>${escapeHtml(g.detail)}</li>`).join('')}</ul>` : ''}</li>`).join('');
  const c = r.counts;
  const body = `<h1>Expiry report</h1><p>As of ${escapeHtml(r.as_of)}. Expired ${c.expired} · critical ${c.critical} · warning ${c.warning} · upcoming ${c.upcoming} · ok ${c.ok} · no date ${c.no_expiry_date}.</p>` +
    `<table><thead><tr><th>Status</th><th>Id</th><th>Type</th><th>Name</th><th>Expires</th><th>Days</th><th>Flags</th><th>Next step</th></tr></thead><tbody>${rows}</tbody></table>` +
    (r.vendors.length ? `<h2>Vendor certificates of insurance</h2><ul>${vend}</ul>` : '');
  return htmlPage({ title: `Expiry report ${r.as_of}`, bodyHtml: body, footer: 'Possible gaps against your own records and requirements. Not insurance or legal advice; a person decides. Generated locally by aegle-of-certificates.' });
}

const SR = { expired: 0, critical: 1, no_expiry_date: 2, warning: 3, upcoming: 4, ok: 5 };
/** Compare two inventory snapshots (both scanned at the same as_of): what changed since the last review. */
export function diffInventory(prevRows, curRows, a = {}) {
  const prev = new Map(scanInventory(prevRows, a).map((i) => [i.id, i])); const cur = new Map(scanInventory(curRows, a).map((i) => [i.id, i]));
  const changes = [];
  for (const [id, c] of cur) {
    const p = prev.get(id);
    if (!p) { changes.push({ id, name: c.name, change: 'added', detail: `New item, ${c.status}${c.expires ? `, expires ${c.expires}` : ''}.` }); continue; }
    if (p.expires && c.expires && c.expires > p.expires) changes.push({ id, name: c.name, change: 'renewed', detail: `Expiry moved from ${p.expires} to ${c.expires}.` });
    if (p.expires && c.expires && c.expires < p.expires) changes.push({ id, name: c.name, change: 'expiry_moved_earlier', detail: `Expiry moved earlier, from ${p.expires} to ${c.expires}: check the record.` });
    if (p.expires && !c.expires) changes.push({ id, name: c.name, change: 'expiry_date_removed', detail: `Expiry date ${p.expires} was removed.` });
    if (p.auto_renew && !c.auto_renew) changes.push({ id, name: c.name, change: 'auto_renew_turned_off', detail: 'Auto-renew was on and is now off.' });
    if (p.owner !== c.owner) changes.push({ id, name: c.name, change: c.owner ? 'owner_changed' : 'owner_removed', detail: `Owner "${p.owner || '—'}" → "${c.owner || '—'}".` });
    const newFlags = c.flags.filter((f) => !p.flags.includes(f) && !['no_owner', 'no_expiry_date', 'auto_renew_off'].includes(f));
    if (newFlags.length) changes.push({ id, name: c.name, change: 'new_flags', detail: `New flag(s): ${newFlags.join(', ')}.` });
    if (SR[c.status] < SR[p.status] && !(c.expires > p.expires)) changes.push({ id, name: c.name, change: 'status_worse', detail: `Status ${p.status} → ${c.status}.` });
  }
  for (const [id, p] of prev) if (!cur.has(id)) changes.push({ id, name: p.name, change: 'removed', detail: `No longer in the inventory (was ${p.status}${p.expires ? `, expires ${p.expires}` : ''}): retired on purpose?` });
  const ORDER = ['expiry_moved_earlier', 'auto_renew_turned_off', 'removed', 'status_worse', 'new_flags', 'expiry_date_removed', 'owner_removed', 'owner_changed', 'added', 'renewed'];
  changes.sort((x, y) => ORDER.indexOf(x.change) - ORDER.indexOf(y.change) || x.id.localeCompare(y.id));
  const counts = Object.fromEntries(ORDER.map((k) => [k, changes.filter((c) => c.change === k).length]).filter(([, n]) => n));
  return { as_of: iso(asOfMs(a.as_of)), previous_items: prev.size, current_items: cur.size, counts, changes };
}

export function chaseDraft(v) {
  return [`DRAFT — not sent. A person reviews and sends this.`, '', `Subject: Updated certificate of insurance needed — ${v.vendor}`, '', `Hello ${v.vendor} team,`, '',
    'Our records show the following against our written insurance requirements:', ...v.gaps.map((g) => `- ${g.detail}`), '',
    'Could you send an updated certificate of insurance that covers these points?', '', 'Thank you,', '[Your name]', '',
    '(This lists possible gaps against our own requirement list. It is not insurance or legal advice.)', ''].join('\n');
}
// Any script: a Japanese or Korean vendor name used to become "vendor" for every vendor.
export const slug = (s) => slugify(s, 'vendor');
