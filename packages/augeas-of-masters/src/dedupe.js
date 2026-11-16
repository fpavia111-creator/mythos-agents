import { toCsv, jaroWinkler, normalizeAddress, tokenSetSimilarity, stripLegalForms, stripLegalTail, normHeader, namesFor, COLUMN_LANGUAGES } from 'mythos-agent-core';

// Legal forms and filler words: English plus the common European forms (GmbH, AG, KG,
// SARL, SRL, S.p.A., Ltda, Oy, ApS...). Punctuation is already spaces here, so dotted
// forms appear as single letters ("s p a").
const SUFFIX = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|mbh|ag|kg|ohg|kgaa|sa|sas|sasu|sarl|s a r l|srl|s r l|s p a|ltda|eireli|bv|nv|bvba|sprl|oy|oyj|aps|pty|the|and|&)\b/g;
const NON_ASCII = /[^\x00-\x7f]/;
/**
 * Normalized name for matching. Letters of every script are kept, and Japanese, Chinese
 * and Korean legal forms (株式会社, (株), 有限公司, 주식회사, (주), カ) in bank names) are
 * removed, so 株式会社架空商事 and 架空商事(株) are the same name. Such names used to
 * normalize to nothing, so their duplicates were never found.
 */
export function normName(s) {
  const raw = String(s ?? '');
  // Forms that only count at the end (S.L., S.A. de C.V., SE, ME, EPP...) go first, while
  // the name still ends with them.
  if (!NON_ASCII.test(raw)) return stripLegalTail(raw.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  const t = stripLegalForms(raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/ß/g, 'ss'));
  return stripLegalTail(t.replace(/&/g, ' and ').replace(/[^\p{L}\p{N} ]/gu, ' ')).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const domain = (e) => { const m = String(e ?? '').toLowerCase().match(/@([a-z0-9.-]+)$/); return m && !/^(gmail|yahoo|outlook|hotmail|icloud|aol)\./.test(m[1]) ? m[1] : ''; };

function bigrams(s) { const t = s.replace(/ /g, ''); const out = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; }
/** Sørensen–Dice similarity on character bigrams, 0..1. */
export function dice(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) || 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
const tokenSort = (s) => s.split(' ').sort().join(' ');

// Column lookup: the English names first (as before), then the same columns as they are
// named in German, French, Spanish, Portuguese, Italian, Japanese, Chinese and Korean exports.
const translated = (...concepts) => [...new Set(concepts.flatMap((c) => COLUMN_LANGUAGES.flatMap((l) => namesFor(c, l) || [])).map(normHeader).filter(Boolean))];
const INTL = {
  vendor: { id: translated('vendor_id', 'external_id', 'id'), name: translated('legal_name', 'vendor', 'company', 'name'), tax: translated('tax_id'), email: translated('email'), phone: translated('phone'), addr: translated('address') },
  item: { id: translated('sku', 'external_id', 'id'), name: translated('item', 'description', 'name'), tax: [], email: [], phone: [], addr: [] },
};
const STATUS_INTL = translated('status');
// "Inactive" in a status column, in the nine languages (folded: lowercase, no accents).
const INACTIVE_WORD = /^(inactive|disabled|inaktiv|deaktiviert|gesperrt|inactif|desactive|inactivo|desactivado|inativo|desativado|inattivo|disattivato|無効|休止|停止|取引停止|停用|禁用|无效|無效|비활성|사용 중지|사용중지|거래중지)$/u;
function col(row, names, intl = null) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === want); if (k) return row[k]; }
  if (intl) for (const want of intl) { const k = keys.find((x) => normHeader(x) === want); if (k) return row[k]; }
  return '';
}

const FIELDS = {
  vendor: { id: ['internalid', 'id', 'vendorid', 'entityid', 'externalid'], name: ['companyname', 'vendorname', 'name', 'legalname', 'entityid'], tax: ['taxid', 'ein', 'vatnumber', 'tin', 'vat'], email: ['email'], phone: ['phone', 'telephone'], addr: ['address', 'address1', 'billaddress', 'street'] },
  item: { id: ['internalid', 'id', 'itemid', 'sku', 'externalid'], name: ['displayname', 'name', 'itemname', 'description', 'salesdescription'], tax: ['upc', 'upccode', 'gtin', 'ean', 'mpn', 'manufacturerpartnumber'], email: [], phone: [], addr: [] },
};
export const DEFAULT_THRESHOLD = 0.92;

/**
 * Tax id / UPC key: digits only when there are enough digits (so "DE 123-456-789" and
 * "123456789" match), else lowercase letters and digits. Ids with letters after the first
 * digit keep their letters: a Chinese unified credit code (…0001X), an Italian codice
 * fiscale or a Spanish NIE differ only there, and dropping them could join two companies.
 */
// Tax ids that many unrelated parties share on purpose: Mexico's generic RFCs for the
// general public and for foreign parties. They never make two records the same vendor.
const GENERIC_TAX = new Set(['xaxx010101000', 'xexx010101000']);
/** True when a tax id is a generic or placeholder value (XAXX010101000, XEXX010101000, 000000000, 999-99-9999). */
export function isPlaceholderTax(v) {
  const alnum = String(v ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  const d = alnum.replace(/\D/g, '');
  return GENERIC_TAX.has(alnum) || (d.length >= 5 && d === alnum.replace(/^[a-z]{2}/, '') && /^(\d)\1+$/.test(d));
}
export function normTax(v) {
  const s = String(v ?? '').normalize('NFKC').trim();
  const alnum = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (isPlaceholderTax(alnum)) return '';
  const d = alnum.replace(/\D/g, '');
  if (d.length < 5) return alnum;
  // A Mexican RFC starts with three or four letters from the name: they count.
  if (/^[a-z]{3,4}\d{6}[a-z0-9]{3}$/.test(alnum)) return alnum;
  return /\d[^a-z]*[a-z]/.test(alnum) ? alnum : d;
}

/**
 * Symmetric soft-token match (Monge-Elkan): each token's best Jaro-Winkler match on the
 * other side, weighted by how rare the token is in the file (common words such as
 * "supply" or "logistics" count less), taking the lower of the two directions.
 */
export function mongeElkan(a, b, weight = () => 1) {
  const A = a.split(' ').filter(Boolean), B = b.split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const one = (X, Y) => { let s = 0, w = 0; for (const x of X) { const wx = weight(x); w += wx; s += wx * Math.max(...Y.map((y) => jaroWinkler(x, y))); } return w ? s / w : 0; };
  return Math.min(one(A, B), one(B, A));
}

/** Token weights for a file: log(1 + N / document frequency). */
export function tokenWeights(names) {
  const df = new Map();
  for (const nn of names) for (const t of new Set(nn.split(' ').filter(Boolean))) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, names.length);
  return (t) => Math.log(1 + N / (df.get(t) || 1));
}

/**
 * Name similarity in [0, 1]. Equal normalized names (or equal once spaces are removed) score 1;
 * otherwise the rarity-weighted soft-token score.
 */
export function nameScore(nnA, nnB, weight) {
  if (!nnA || !nnB) return 0;
  if (nnA === nnB || nnA.replace(/ /g, '') === nnB.replace(/ /g, '')) return 1;
  return mongeElkan(nnA, nnB, weight);
}

function isInactive(r) {
  const flag = col(r, ['isinactive', 'inactive']);
  if (flag) return /^(t|true|yes|1|inactive)$/i.test(String(flag));
  const st = col(r, [], STATUS_INTL);
  return !!st && INACTIVE_WORD.test(String(st).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().trim());
}

const houseNo = (a) => (a.match(/^\d+/) || [''])[0];
export function sameAddress(a, b) {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  if (a === b) return true;
  const ha = houseNo(a), hb = houseNo(b);
  if (ha && hb && ha !== hb) return false;
  return jaroWinkler(a, b) >= 0.93 || tokenSetSimilarity(a, b) >= 0.8;
}

export function prepare(rows, opts = {}) {
  const kind = opts.kind === 'item' ? 'item' : 'vendor';
  const F = FIELDS[kind]; const I = INTL[kind];
  return rows.map((r, i) => {
    const id = String((opts.id_column ? r[opts.id_column] : col(r, F.id, I.id)) || `row-${i + 2}`).trim();
    const name = String((opts.name_column ? r[opts.name_column] : col(r, F.name, I.name)) || '').trim();
    const nn = normName(name);
    return { i, id, name, nn, ts: tokenSort(nn), tax: normTax(col(r, F.tax, I.tax)), taxRaw: col(r, F.tax, I.tax), email: domain(col(r, F.email, I.email)), phone: digits(col(r, F.phone, I.phone)).slice(-10), addr: normalizeAddress(col(r, F.addr, I.addr)), inactive: isInactive(r), raw: r };
  });
}

/**
 * Candidate pairs. Small files compare every pair. Larger files use blocking keys
 * (name-token prefixes, tax id, phone, house number + street, email domain); very
 * common name tokens are skipped as keys so blocks stay small. Deterministic.
 */
export function candidatePairs(recs, { full_compare_below = 400 } = {}) {
  const n = recs.length; const out = [];
  if (n <= full_compare_below) { for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) out.push([a, b]); return { pairs: out, blocking: false }; }
  const blocks = new Map();
  const add = (k, i) => { if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(i); };
  for (const r of recs) {
    for (const t of new Set(r.nn.split(' '))) if (t.length >= 3) { add('n:' + t.slice(0, 4), r.i); add('s:' + t.slice(-4), r.i); }
    if (r.nn) add('j:' + r.nn.replace(/ /g, '').slice(0, 6), r.i);
    if (r.tax && r.tax.length >= 5) add('t:' + r.tax, r.i);
    if (r.phone && r.phone.length >= 7) add('p:' + r.phone, r.i);
    const h = houseNo(r.addr); if (h) add('a:' + h + ':' + (r.addr.split(' ')[1] || ''), r.i);
    if (r.email) add('e:' + r.email, r.i);
  }
  const cap = Math.max(60, Math.ceil(n * 0.03));
  // A tax id or phone shared by very many rows is usually a placeholder (000-000-0000,
  // the head office number). Pairing all of them would need millions of comparisons,
  // so such keys are skipped and reported instead.
  const hardCap = Math.max(500, cap);
  const seen = new Set(); const skipped = [];
  for (const [k, ids] of [...blocks.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (ids.length < 2) continue;
    if (ids.length > cap && !/^[tp]:/.test(k)) continue;
    if (ids.length > hardCap) { skipped.push({ key: k[0] === 't' ? 'tax id' : 'phone', records: ids.length }); continue; }
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
      const a = Math.min(ids[x], ids[y]), b = Math.max(ids[x], ids[y]); const key = a * n + b;
      if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
    }
  }
  out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { pairs: out, blocking: true, skipped };
}

/** Score one pair. Returns null when there is no reason to link them. */
export function scorePair(A, B, { kind = 'vendor', threshold = DEFAULT_THRESHOLD, weight } = {}) {
  const reasons = []; let score = 0;
  const sim = nameScore(A.nn, B.nn, weight);
  const sameName = !!A.nn && (A.nn === B.nn || A.ts === B.ts);
  const sameTax = A.tax.length >= 5 && A.tax === B.tax;
  const diffTax = A.tax.length >= 5 && B.tax.length >= 5 && A.tax !== B.tax;
  const addr = sameAddress(A.addr, B.addr), phone = !!A.phone && A.phone.length >= 7 && A.phone === B.phone, email = !!A.email && A.email === B.email;
  const signals = { name: Math.round(sim * 100) / 100, tax: sameTax ? 'same' : diffTax ? 'different' : 'missing', address: A.addr && B.addr ? (addr ? 'same' : 'different') : 'missing', phone: A.phone && B.phone ? (phone ? 'same' : 'different') : 'missing', email_domain: A.email && B.email ? (email ? 'same' : 'different') : 'missing' };
  if (sameName) { reasons.push('same normalized name'); score = 0.95; }
  else if (sim >= threshold) { reasons.push(`similar name (${sim.toFixed(2)})`); score = Math.min(0.94, sim); }
  if (sameTax) { reasons.push(kind === 'vendor' ? 'same tax id' : 'same UPC/part number'); score = Math.max(score, 0.99); }
  const support = [];
  if (email) support.push('same email domain');
  if (phone) support.push('same phone');
  if (addr) support.push('same address');
  if (!reasons.length && sim >= 0.8 && (addr || phone)) { reasons.push(`name partly similar (${sim.toFixed(2)}) with same ${addr ? 'address' : 'phone'}`); score = 0.85; }
  if (!reasons.length && support.length >= 2 && sim >= 0.6) { reasons.push(`name partly similar (${sim.toFixed(2)})`); score = 0.8; }
  if (!reasons.length) return null;
  if (diffTax) { reasons.push('DIFFERENT tax ids — may be separate legal entities'); score = Math.min(score, 0.6); }
  else if (!sameTax && signals.address === 'different' && signals.phone === 'different') { reasons.push('different address and phone — may be a different business with a similar name'); score = Math.min(score, 0.7); }
  reasons.push(...support);
  score = Math.min(1, score + 0.02 * support.length);
  return { score: Math.round(score * 100) / 100, reasons, signals };
}

/** Find likely duplicate vendors or items. Returns clusters with reasons and a suggested survivor. */
export function findDuplicates(rows, opts = {}) {
  const kind = opts.kind === 'item' ? 'item' : 'vendor';
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  const recs = prepare(rows, { ...opts, kind });
  const parent = recs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const cand = candidatePairs(recs, opts);
  const weight = tokenWeights(recs.map((r) => r.nn));
  const pairs = [];
  for (const [a, b] of cand.pairs) {
    const A = recs[a], B = recs[b];
    const s = scorePair(A, B, { kind, threshold, weight });
    if (!s) continue;
    pairs.push({ a: A.id, b: B.id, ia: a, ib: b, ...s });
  }
  // Strongest links first; never join two groups whose records carry different tax ids / UPCs.
  const taxes = recs.map((r) => (r.tax.length >= 5 ? new Set([r.tax]) : new Set()));
  const blocked = [];
  for (const p of [...pairs].sort((x, y) => y.score - x.score || x.ia - y.ia || x.ib - y.ib)) {
    if (p.score < 0.75) continue;
    const ra = find(p.ia), rb = find(p.ib);
    if (ra === rb) continue;
    const union = new Set([...taxes[ra], ...taxes[rb]]);
    if (union.size > 1) { blocked.push(p); continue; }
    parent[ra] = rb; taxes[rb] = union;
  }
  for (const p of pairs) { delete p.ia; delete p.ib; }
  const groups = new Map();
  recs.forEach((r, i) => { const p = find(i); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(r); });
  const order = opts.survivor_rules || {};
  const multi = [...groups.values()].filter((g) => g.length > 1);
  // Each cluster's pairs (both ids in the cluster, score >= 0.75), in pair order, found
  // through an id index instead of scanning every pair once per cluster.
  const idIn = new Map();
  multi.forEach((g, ci) => { for (const id of new Set(g.map((x) => x.id))) { if (!idIn.has(id)) idIn.set(id, []); idIn.get(id).push(ci); } });
  const psOf = multi.map(() => []);
  for (const p of pairs) {
    if (!(p.score >= 0.75)) continue;
    const ca = idIn.get(p.a), cb = idIn.get(p.b); if (!ca || !cb) continue;
    for (const ci of ca) if (cb.includes(ci)) psOf[ci].push(p);
  }
  const clusters = multi.map((g, ci) => {
    const ps = psOf[ci];
    const survivor = pickSurvivor(g, order);
    return {
      confidence: ps.reduce((m, p) => Math.min(m, p.score), Infinity),
      survivor: survivor.id, merge: g.filter((x) => x !== survivor).map((x) => x.id),
      records: g.map((x) => ({ id: x.id, name: x.name, inactive: x.inactive })),
      reasons: [...new Set(ps.flatMap((p) => p.reasons))],
      pairs: ps.map((p) => ({ a: p.a, b: p.b, score: p.score, signals: p.signals })),
    };
  }).sort((x, y) => y.confidence - x.confidence || x.survivor.localeCompare(y.survivor)).map((c, n) => ({ cluster: `C${String(n + 1).padStart(3, '0')}`, ...c }));
  const generic = recs.filter((r) => !r.tax && isPlaceholderTax(r.taxRaw)).length;
  const notCompared = [
    ...(cand.skipped || []).map((x) => `${x.records} records share one ${x.key}; it looks like a placeholder, so they were not paired on it (they are still compared on name, address and email)`),
    ...(generic ? [`${generic} record${generic === 1 ? ' has' : 's have'} a generic or placeholder tax id (such as XAXX010101000 or 000000000), so it was not used to pair them`] : []),
  ];
  return {
    kind, threshold, records: recs.length, compared_pairs: cand.pairs.length, blocking: cand.blocking,
    ...(notCompared.length ? { not_compared: notCompared } : {}), clusters: clusters.length, records_in_clusters: clusters.reduce((s, c) => s + c.records.length, 0),
    proposals: clusters, weak_pairs: pairs.filter((p) => p.score < 0.75),
    kept_apart: blocked.map((p) => ({ a: p.a, b: p.b, score: p.score, reason: 'linking them would put two different tax ids in one cluster' })),
    note: 'Proposals only. Check open transactions, balances, bank details and 1099/tax status before merging anything in the ERP.',
  };
}

const filledCount = (r) => Object.values(r.raw).filter((v) => String(v ?? '').trim()).length;
/** Survivor: active first, then most complete (default), most recent (date_column) or lowest id; id breaks ties. */
export function pickSurvivor(group, rules = {}) {
  const preferActive = rules.prefer_active !== false;
  const by = rules.order || 'most_complete';
  const dateOf = (r) => { const t = Date.parse(String(r.raw[rules.date_column] ?? '')); return Number.isFinite(t) ? t : -Infinity; };
  return [...group].sort((x, y) => (preferActive ? x.inactive - y.inactive : 0)
    || (by === 'most_recent' && rules.date_column ? dateOf(y) - dateOf(x) : 0)
    || (by !== 'lowest_id' ? filledCount(y) - filledCount(x) : 0)
    || x.id.localeCompare(y.id))[0];
}

export function proposalsCsv(res) {
  return toCsv(res.proposals.map((c) => ({ cluster: c.cluster, confidence: c.confidence, survivor: c.survivor, merge_ids: c.merge.join(' '), names: c.records.map((r) => r.name).join(' | '), reasons: c.reasons.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '' })),
    ['cluster', 'confidence', 'survivor', 'merge_ids', 'names', 'reasons', 'reviewer_decision', 'reviewer_name', 'review_date']);
}

/** Apply ONE merge to a copy of the rows: duplicates get merged_into = survivor. Input is never modified. */
export function applyMerge(rows, { id_column, survivor, merge, kind, golden = null }) {
  const F = FIELDS[kind === 'item' ? 'item' : 'vendor'];
  const idOf = (r, i) => String((id_column ? r[id_column] : col(r, F.id, INTL[kind === 'item' ? 'item' : 'vendor'].id)) || `row-${i + 2}`).trim();
  const ids = rows.map(idOf);
  if (!ids.includes(survivor)) throw new Error(`survivor ${survivor} not found`);
  const want = new Set(merge);
  if (!want.size) throw new Error('merge must list at least one id');
  if (want.has(survivor)) throw new Error('survivor cannot also be merged');
  for (const m of want) if (!ids.includes(m)) throw new Error(`id ${m} not found`);
  let changed = 0;
  const out = rows.map((r, i) => { const o = { ...r, merged_into: r.merged_into || '' }; if (want.has(ids[i])) { o.merged_into = survivor; changed++; } return o; });
  // Optional: write the previewed field winners into the survivor row (existing columns only).
  let filled = 0;
  if (golden) { const si = ids.indexOf(survivor); for (const [k, v] of Object.entries(golden)) if (k in out[si] && k !== 'merged_into' && out[si][k] !== v) { out[si][k] = v; filled++; } }
  return { rows: out, changed, filled };
}

/** Self-contained HTML page for reviewers: every cluster with its signals. */
export function proposalsHtml(res, { htmlPage, escapeHtml }) {
  const e = escapeHtml;
  const sig = (s) => Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const rows = res.proposals.map((c) => `<h2>${e(c.cluster)} · confidence ${c.confidence}</h2>
<p>Keep <b>${e(c.survivor)}</b>, merge ${c.merge.map(e).join(', ')}. ${e(c.reasons.join('; '))}</p>
<div class="wrap"><table><tr><th>Id</th><th>Name</th><th>Inactive</th></tr>${c.records.map((r) => `<tr><td>${e(r.id)}</td><td>${e(r.name)}</td><td>${r.inactive ? 'yes' : ''}</td></tr>`).join('')}</table></div>
<p class="mut">${c.pairs.map((p) => `${e(p.a)}–${e(p.b)} ${p.score}: ${e(sig(p.signals))}`).join('<br>')}</p>`).join('\n');
  const body = `<h1>Merge proposals (${e(res.kind)})</h1><p class="mut">${res.records} records · ${res.compared_pairs} pairs compared${res.blocking ? ' (blocking on)' : ''} · threshold ${res.threshold}</p>
<div class="tiles"><div class="tile">Clusters<b>${res.clusters}</b></div><div class="tile">Records in clusters<b>${res.records_in_clusters}</b></div><div class="tile">Weak pairs<b>${res.weak_pairs.length}</b></div><div class="tile">Kept apart<b>${res.kept_apart.length}</b></div></div>
${rows || '<p>No clusters.</p>'}
<p class="mut">${e(res.note)}</p>`;
  return htmlPage({ title: `Merge proposals (${res.kind})`, bodyHtml: body, footer: 'augeas-of-masters · proposals only; nothing was merged' });
}
