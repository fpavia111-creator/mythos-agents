// Deterministic, fictional 1,000-row vendor master with known duplicates.
// Names are built from made-up syllables; domains are .example; phones are 555-01xx;
// tax ids start with "00-" (never issued). Ground truth is the entity column.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PRE = ['Vel', 'Mor', 'Tan', 'Quil', 'Bram', 'Cor', 'Dun', 'Fen', 'Gal', 'Hol', 'Jor', 'Kest', 'Lun', 'Mar', 'Nor', 'Osk', 'Pell', 'Rav', 'Sor', 'Tor', 'Ul', 'Var', 'Wyn', 'Yar', 'Zel', 'Brin', 'Cal', 'Dra', 'Eld', 'Thal'];
const SUF = ['ora', 'ith', 'ane', 'ex', 'wick', 'dale', 'mere', 'ton', 'ford', 'ley', 'vin', 'ast', 'wyn', 'gate', 'hollow'];
const IND = ['Logistics', 'Supply', 'Foods', 'Labs', 'Industrial', 'Textiles', 'Freight', 'Analytics', 'Ceramics', 'Metals', 'Paper', 'Electric', 'Plumbing', 'Print', 'Marine', 'Tooling'];
const ENT = ['Inc', 'LLC', 'Ltd', 'Co', 'Corp', ''];
const STREET = ['Main', 'Oak', 'Pine', 'Cedar', 'Harbor', 'Mill', 'Ridge', 'Lake', 'Quarry', 'Elm', 'Willow', 'Granite'];
const TYPE = [['Street', 'St'], ['Avenue', 'Ave'], ['Road', 'Rd'], ['Drive', 'Dr'], ['Lane', 'Ln'], ['Boulevard', 'Blvd']];
const CITY = ['Brookhollow', 'Marrowfield', 'Eastvale', 'Quarry Bend', 'Lindenport', 'Ashcombe'];

export function seededVendors({ seed = 20261115, rows = 1000, duplicates = 180, hardNegatives = 40 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const used = new Set(); const usedTax = new Set();
  const tax = () => { let t; do t = `00-${String(int(0, 9999999)).padStart(7, '0')}`; while (usedTax.has(t)); usedTax.add(t); return t; };
  const entities = [];
  const baseCount = rows - duplicates;
  const mk = (stem, ind) => ({ stem, ind, ent: pick(ENT), tax: tax(), area: int(201, 989), line: int(100, 199), no: int(1, 9999), street: pick(STREET), type: pick(TYPE), city: pick(CITY) });
  while (entities.length < baseCount - hardNegatives) {
    const stem = pick(PRE) + pick(SUF), ind = pick(IND), key = `${stem} ${ind}`;
    if (used.has(key)) continue; used.add(key); entities.push(mk(stem, ind));
  }
  // Hard negatives: a different business whose name differs by one letter or industry word.
  for (let k = 0; k < hardNegatives; k++) {
    const src = entities[k * 7];
    let stem = src.stem, ind = src.ind;
    if (k % 2) ind = IND[(IND.indexOf(ind) + 1) % IND.length];
    else stem = stem.slice(0, -1) + (stem.endsWith('a') ? 'o' : 'a');
    const key = `${stem} ${ind}`; if (used.has(key)) { ind = IND[(IND.indexOf(ind) + 3) % IND.length]; }
    used.add(`${stem} ${ind}`);
    const e = mk(stem, ind);
    if (k % 3 === 0) e.tax = ''; // some hard negatives have no tax id
    entities.push(e);
  }
  const fmtName = (e) => `${e.stem} ${e.ind}${e.ent ? (e.ent === 'Inc' ? ', Inc.' : ' ' + e.ent) : ''}`;
  const out = entities.map((e, i) => ({ entity: `E${i}`, e, name: fmtName(e), taxid: e.tax, email: `ap@${(e.stem + e.ind).toLowerCase()}.example`, phone: `(${e.area}) 555-0${e.line}`, address: `${e.no} ${e.street} ${e.type[0]} ${e.city}`, isinactive: 'F' }));
  // Duplicates: a variant of an earlier entity (never of a hard negative).
  const variants = [
    (n) => n.toUpperCase(),
    (n) => n.replace(/,? (Inc\.?|LLC|Ltd|Co|Corp)$/, '') + ' LLC',
    (n) => { const i = 2 + Math.floor(rnd() * 3); return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2); }, // swap two letters
    (n) => { const i = 3 + Math.floor(rnd() * 3); return n.slice(0, i) + n.slice(i + 1); }, // drop a letter
    (n) => { const [a, b, ...rest] = n.split(' '); return [b.replace(/,$/, ''), a, ...rest].join(' '); }, // word order
    (n) => n.replace(/ /, ' & ').replace(/ & (\S+)/, ' $1'), // noise that normalizes away
  ];
  for (let d = 0; d < duplicates; d++) {
    const base = out[Math.floor(rnd() * (baseCount - hardNegatives))];
    const e = base.e;
    const v = { entity: base.entity, e, name: pick(variants)(base.name), taxid: '', email: rnd() < 0.7 ? `billing@${(e.stem + e.ind).toLowerCase()}.example` : `${e.stem.toLowerCase()}.ap@mail.example`, phone: rnd() < 0.8 ? `${e.area}-555-0${e.line}` : '', address: rnd() < 0.85 ? `${e.no} ${e.street} ${e.type[1]}. ${e.city}` : `${int(1, 9999)} ${pick(STREET)} ${pick(TYPE)[0]} ${e.city}`, isinactive: rnd() < 0.3 ? 'T' : 'F' };
    const t = rnd(); v.taxid = t < 0.45 ? '' : t < 0.75 ? e.tax : e.tax.replace('-', '');
    out.push(v);
  }
  // Shuffle deterministically and assign ids.
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out.map((r, i) => ({ internalid: `S${String(i + 1).padStart(4, '0')}`, companyname: r.name, taxid: r.taxid, email: r.email, phone: r.phone, address: r.address, isinactive: r.isinactive, entity: r.entity }));
}

/** Pairwise precision and recall of predicted clusters against the entity column. */
export function pairMetrics(rows, proposals) {
  const truth = new Map(); for (const r of rows) { if (!truth.has(r.entity)) truth.set(r.entity, []); truth.get(r.entity).push(r.internalid); }
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const T = new Set(); for (const ids of truth.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) T.add(key(ids[i], ids[j]));
  const P = new Set(); for (const c of proposals) { const ids = c.records.map((r) => r.id); for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) P.add(key(ids[i], ids[j])); }
  let tp = 0; for (const k of P) if (T.has(k)) tp++;
  return { true_pairs: T.size, predicted_pairs: P.size, tp, precision: P.size ? tp / P.size : 1, recall: T.size ? tp / T.size : 1 };
}
