import { toCsv } from 'mythos-agent-core';

const SUFFIX = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|sas|bv|pty|the|and|&)\b/g;
export function normName(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
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

function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === want); if (k) return row[k]; }
  return '';
}

const FIELDS = {
  vendor: { id: ['internalid', 'id', 'vendorid', 'entityid', 'externalid'], name: ['companyname', 'vendorname', 'name', 'legalname', 'entityid'], tax: ['taxid', 'ein', 'vatnumber', 'tin', 'vat'], email: ['email'], phone: ['phone', 'telephone'], addr: ['address', 'address1', 'billaddress', 'street'] },
  item: { id: ['internalid', 'id', 'itemid', 'sku', 'externalid'], name: ['displayname', 'name', 'itemname', 'description', 'salesdescription'], tax: ['upc', 'upccode', 'gtin', 'ean', 'mpn', 'manufacturerpartnumber'], email: [], phone: [], addr: [] },
};

/** Find likely duplicate vendors or items. Returns clusters with reasons and a suggested survivor. */
export function findDuplicates(rows, opts = {}) {
  const kind = opts.kind === 'item' ? 'item' : 'vendor';
  const F = FIELDS[kind];
  const threshold = Number(opts.threshold ?? 0.88);
  const recs = rows.map((r, i) => {
    const id = String((opts.id_column ? r[opts.id_column] : col(r, F.id)) || `row-${i + 2}`).trim();
    const name = String((opts.name_column ? r[opts.name_column] : col(r, F.name)) || '').trim();
    const nn = normName(name);
    return { i, id, name, nn, ts: tokenSort(nn), tax: digits(col(r, F.tax)) || String(col(r, F.tax)).trim().toLowerCase(), email: domain(col(r, F.email)), phone: digits(col(r, F.phone)).slice(-10), addr: normName(col(r, F.addr)), inactive: /^(t|true|yes|1|inactive)$/i.test(String(col(r, ['isinactive', 'inactive']) || '')), raw: r };
  });
  const parent = recs.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const pairs = [];
  for (let a = 0; a < recs.length; a++) for (let b = a + 1; b < recs.length; b++) {
    const A = recs[a], B = recs[b]; const reasons = []; let score = 0;
    const sim = Math.max(dice(A.nn, B.nn), dice(A.ts, B.ts));
    if (A.nn && A.nn === B.nn) { reasons.push('same normalized name'); score = Math.max(score, 0.95); }
    else if (sim >= threshold) { reasons.push(`similar name (${sim.toFixed(2)})`); score = Math.max(score, sim); }
    if (A.tax && A.tax.length >= 5 && A.tax === B.tax) { reasons.push(kind === 'vendor' ? 'same tax id' : 'same UPC/part number'); score = Math.max(score, 0.99); }
    const support = [];
    if (A.email && A.email === B.email) support.push('same email domain');
    if (A.phone && A.phone.length >= 7 && A.phone === B.phone) support.push('same phone');
    if (A.addr && A.addr.length > 6 && dice(A.addr, B.addr) > 0.9) support.push('same address');
    if (!reasons.length && support.length >= 2 && sim >= 0.6) { reasons.push(`name partly similar (${sim.toFixed(2)})`); score = 0.8; }
    if (!reasons.length) continue;
    if (A.tax && B.tax && A.tax.length >= 5 && B.tax.length >= 5 && A.tax !== B.tax) { reasons.push('DIFFERENT tax ids — may be separate legal entities'); score = Math.min(score, 0.6); }
    reasons.push(...support);
    score = Math.min(1, score + 0.02 * support.length);
    pairs.push({ a: A.id, b: B.id, score: Math.round(score * 100) / 100, reasons });
    if (score >= 0.75) parent[find(a)] = find(b);
  }
  const groups = new Map();
  recs.forEach((r, i) => { const p = find(i); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(r); });
  const clusters = [...groups.values()].filter((g) => g.length > 1).map((g, n) => {
    const ids = new Set(g.map((x) => x.id));
    const ps = pairs.filter((p) => ids.has(p.a) && ids.has(p.b));
    const filled = (r) => Object.values(r.raw).filter((v) => String(v ?? '').trim()).length;
    const survivor = [...g].sort((x, y) => (x.inactive - y.inactive) || filled(y) - filled(x) || x.id.localeCompare(y.id))[0];
    return {
      cluster: `C${String(n + 1).padStart(3, '0')}`, confidence: Math.min(...ps.filter((p) => p.score >= 0.75).map((p) => p.score)),
      survivor: survivor.id, merge: g.filter((x) => x !== survivor).map((x) => x.id),
      records: g.map((x) => ({ id: x.id, name: x.name, inactive: x.inactive })),
      reasons: [...new Set(ps.flatMap((p) => p.reasons))],
    };
  }).sort((x, y) => y.confidence - x.confidence);
  return {
    kind, records: recs.length, clusters: clusters.length, records_in_clusters: clusters.reduce((s, c) => s + c.records.length, 0),
    proposals: clusters, weak_pairs: pairs.filter((p) => p.score < 0.75),
    note: 'Proposals only. Check open transactions, balances, bank details and 1099/tax status before merging anything in the ERP.',
  };
}

export function proposalsCsv(res) {
  return toCsv(res.proposals.map((c) => ({ cluster: c.cluster, confidence: c.confidence, survivor: c.survivor, merge_ids: c.merge.join(' '), names: c.records.map((r) => r.name).join(' | '), reasons: c.reasons.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '' })),
    ['cluster', 'confidence', 'survivor', 'merge_ids', 'names', 'reasons', 'reviewer_decision', 'reviewer_name', 'review_date']);
}

/** Apply ONE merge to a copy of the rows: duplicates get merged_into = survivor. Input is never modified. */
export function applyMerge(rows, { id_column, survivor, merge, kind }) {
  const F = FIELDS[kind === 'item' ? 'item' : 'vendor'];
  const idOf = (r, i) => String((id_column ? r[id_column] : col(r, F.id)) || `row-${i + 2}`).trim();
  const ids = rows.map(idOf);
  if (!ids.includes(survivor)) throw new Error(`survivor ${survivor} not found`);
  const want = new Set(merge);
  if (!want.size) throw new Error('merge must list at least one id');
  if (want.has(survivor)) throw new Error('survivor cannot also be merged');
  for (const m of want) if (!ids.includes(m)) throw new Error(`id ${m} not found`);
  let changed = 0;
  const out = rows.map((r, i) => { const o = { ...r, merged_into: r.merged_into || '' }; if (want.has(ids[i])) { o.merged_into = survivor; changed++; } return o; });
  return { rows: out, changed };
}
