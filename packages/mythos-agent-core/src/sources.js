// Source adapters: read the export a real system produces and hand the agent
// rows in its own column layout.
//
// A manifest declares its tabular inputs under `sources`:
//
//   sources: {
//     vendors: {                      // kind; also the argument name by default
//       label: 'Vendor master',
//       args: ['vendors'],            // arguments that carry this kind of file
//       fields: {                     // the agent's own columns
//         vendor_id: { aliases: ['Vendor ID', 'Supplier No'], required: true },
//         amount:    { type: 'money' },
//         paid_on:   { type: 'date' },
//       },
//       profiles: [{                  // one per real export
//         id: 'netsuite_vendors', system: 'NetSuite', label: 'Vendor saved search',
//         signature: ['Internal ID', 'Tax ID'],
//         map: { vendor_id: 'Internal ID', tin: 'Tax ID', status: { from: 'Inactive', values: { yes: 'inactive', no: 'active' } } },
//       }],
//     },
//   }
//
// A file that already uses the agent's own column names is returned untouched.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowsToRecords } from './csv.js';
import { assertValid } from './schema.js';
import { normHeader, parseAnyDate, inferDateOrder, cleanAmount, inferDecimal } from './intl.js';
import { translatedNames } from './i18n/columns.js';
import { encodingName, ENCODINGS } from './encoding.js';

export { normHeader, parseAnyDate, inferDateOrder, cleanAmount, inferDecimal };

export const FIELD_TYPES = ['text', 'date', 'datetime', 'money', 'number', 'bool', 'email'];
export const SOURCES_FILE = 'mythos-sources.json';

// Yes and no in the nine report languages too (ja, si, sim, oui, はい, 是, 예...), and the
// ○ / × marks Japanese and Korean forms use.
const TRUE = /^(y|yes|true|t|1|on|enabled|active|checked|x|✓|✔|ja|wahr|aktiv|aktiviert|oui|vrai|activé|actif|s[iíì]|sim|verdadero|verdadeiro|activo|ativo|attivo|abilitato|はい|有効|あり|済|○|◯|是|有|启用|已启用|啟用|已啟用|예|네|사용|활성|활성화)$/iu;
const FALSE = /^(n|no|false|f|0|off|disabled|inactive|unchecked|nein|falsch|inaktiv|deaktiviert|non|faux|désactivé|inactif|falso|n[aã]o|inactivo|desactivado|desativado|inativo|disattivato|disabilitato|inattivo|いいえ|無効|なし|未|×|✕|✗|否|无|無|未启用|未啟用|关闭|關閉|停用|아니요|아니오|미사용|비활성|비활성화)$/iu;
/** Read a yes/no cell in any of the nine languages (ja, oui, sí, sim, sì, はい, 是, 예, ○...). Returns true, false or null. */
export function readYesNo(v) {
  const t = String(v ?? '').trim();
  return t === '' ? null : TRUE.test(t) ? true : FALSE.test(t) ? false : null;
}

/** Read a value by header name (tolerant of case and punctuation) or by dot path into nested JSON. */
function getter(row, index) {
  return (name) => {
    if (name === undefined || name === null) return undefined;
    const k = index.get(normHeader(name));
    if (k === undefined) return undefined;
    if (row[k] !== undefined) return row[k];
    if (k.includes('.')) { let v = row; for (const part of k.split('.')) { if (v === null || typeof v !== 'object') return undefined; v = v[part]; } return v; }
    return undefined;
  };
}

/** Header list of a record set: top-level keys plus dot paths into nested objects (two levels). */
function headersOf(records) {
  const seen = new Set(); const out = [];
  const add = (k) => { if (!seen.has(k)) { seen.add(k); out.push(k); } };
  for (const r of records.slice(0, 200)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const [k, v] of Object.entries(r)) {
      add(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) {
        add(`${k}.${k2}`);
        if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) for (const k3 of Object.keys(v2)) add(`${k}.${k2}.${k3}`);
      }
    }
  }
  return out;
}

/** Which entry of the column dictionary a field reads: its own name, another concept (fd.translate: 'ledger_debit'), or none (fd.translate: false). */
export const conceptOf = (f, fd) => (fd && fd.translate === false ? null : fd && typeof fd.translate === 'string' ? fd.translate : f);

const specFrom = (spec) => (typeof spec === 'string' ? [spec] : Array.isArray(spec) ? spec : spec && spec.from !== undefined ? [].concat(spec.from) : []);
function wordsOf(def) {
  const w = new Set();
  for (const [f, fd] of Object.entries(def.fields || {})) { w.add(normHeader(f)); for (const a of (fd && fd.aliases) || []) w.add(normHeader(a)); for (const x of translatedNames(conceptOf(f, fd))) w.add(normHeader(x.word)); }
  for (const p of def.profiles || []) { for (const s of p.signature || []) w.add(normHeader(s)); for (const spec of Object.values(p.map || {})) for (const h of specFrom(spec)) w.add(normHeader(h)); }
  w.delete('');
  return w;
}

/** Index of the header row in a matrix: report exports put a title block above it. */
export function findHeaderRow(matrix, def, { skipRows = null } = {}) {
  if (skipRows !== null && skipRows !== undefined) return Math.max(0, Math.min(Number(skipRows) || 0, Math.max(0, matrix.length - 1)));
  const words = wordsOf(def);
  const score = (row) => (row || []).reduce((n, c) => n + (words.has(normHeader(c)) ? 1 : 0), 0);
  let best = 0, bestScore = score(matrix[0]);
  if (bestScore >= 2) return 0;
  for (let i = 1; i < Math.min(matrix.length, 40); i++) { const s = score(matrix[i]); if (s > bestScore && s >= 2) { best = i; bestScore = s; } }
  return best;
}

function matchProfile(def, has, headerCount, forced) {
  const profiles = def.profiles || [];
  if (forced) { const p = profiles.find((x) => x.id === forced); if (!p) throw new Error(`profile "${forced}" is not one of: ${profiles.map((x) => x.id).join(', ') || '(none)'}`); return p; }
  let best = null, bestN = 0;
  for (const p of profiles) {
    const sig = p.signature || [];
    if (!sig.length || !sig.every((h) => (Array.isArray(h) ? h.some(has) : has(h)))) continue;
    if ((p.absent || []).some(has)) continue;
    if (p.columns && headerCount !== p.columns) continue;
    if (sig.length > bestN) { best = p; bestN = sig.length; }
  }
  return best;
}

const ENC_LABEL = { 'shift_jis': 'Shift_JIS (Japanese)', 'euc-jp': 'EUC-JP (Japanese)', 'euc-kr': 'EUC-KR (Korean)', gb18030: 'GB18030 (Chinese)', gbk: 'GBK (Chinese)', big5: 'Big5 (Chinese, traditional)', 'windows-1252': 'Windows-1252 (Western European)', 'iso-8859-1': 'ISO-8859-1', 'iso-8859-15': 'ISO-8859-15', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16 (big-endian)' };
/** A warning when the text encoding of a file was guessed (never when it was UTF-8, marked or set). */
export function encodingWarning(table) {
  const e = table && table.encoding;
  if (!e || e.how !== 'guessed') return null;
  return `The file is not UTF-8; it was read as ${ENC_LABEL[e.name] || e.name} (a guess). If names look wrong, set "encoding" for this file in ${SOURCES_FILE}, for example "shift_jis", "gbk", "euc-kr", "big5" or "windows-1252".`;
}

const clipName = (s) => { const t = String(s); return t.length > 80 ? t.slice(0, 77) + '…' : t; };

/**
 * Adapt a table to an agent's column layout.
 * table: { format, matrix } or { format, records } from readTable.
 * def: one entry of manifest.sources. override: { profile, columns, date_order, decimal, skip_rows }.
 * Returns { rows, report }. report.adapted is false when the file was already in
 * the agent's own layout and came back untouched.
 */
export function adaptRecords(table, def, { override = null, kind = '', arg = '', file = '' } = {}) {
  const ov = override || {};
  const fields = def.fields || {};
  let records, headerRow = 0, headerless = null;
  if (table.matrix) {
    const first = table.matrix[0] || [];
    headerless = (def.profiles || []).find((p) => p.headerless && (ov.profile ? ov.profile === p.id : p.detect && p.detect(first, table.matrix)));
    if (headerless) records = rowsToRecords([headerless.headerless, ...table.matrix]);
    else { headerRow = findHeaderRow(table.matrix, def, { skipRows: ov.skip_rows }); records = rowsToRecords(table.matrix, headerRow); }
  } else records = table.records;
  const headers = table.matrix ? Object.keys(records[0] || (table.matrix[headerRow] ? Object.fromEntries(table.matrix[headerRow].map((h) => [String(h).trim(), ''])) : {})) : headersOf(records);
  const index = new Map(); for (const h of headers) { const k = normHeader(h); if (k && !index.has(k)) index.set(k, h); }
  const has = (h) => index.has(normHeader(h));
  const profile = headerless || matchProfile(def, has, headers.length, ov.profile);
  const warnings = [];
  const nested = new Set(); if (!table.matrix) for (const r of records.slice(0, 50)) if (r && typeof r === 'object') for (const [k, v] of Object.entries(r)) if (v && typeof v === 'object') nested.add(k);

  // Resolve every field of the agent's layout to a source column (or a rule).
  const plan = []; const mapped = {}; const consumed = new Set(); let renamed = 0;
  for (const [f, fd0] of Object.entries(fields)) {
    const fd = fd0 || {};
    if (ov.set && ov.set[f] !== undefined) { plan.push({ f, fd, spec: { value: String(ov.set[f]) }, from: [] }); mapped[f] = `(set to "${ov.set[f]}" in ${SOURCES_FILE})`; renamed++; continue; }
    const ovCol = ov.columns && ov.columns[f];
    if (ovCol !== undefined && ovCol !== null && ovCol !== '') {
      if (!has(ovCol)) throw new Error(`${SOURCES_FILE} maps "${f}" to the column "${ovCol}", which ${file || 'the file'} does not have. Its columns are: ${headers.slice(0, 40).map(clipName).join(', ')}`);
      plan.push({ f, fd, from: [ovCol], spec: {} }); mapped[f] = index.get(normHeader(ovCol)); consumed.add(mapped[f]); renamed++; continue;
    }
    const spec = profile && profile.map ? profile.map[f] : undefined;
    if (spec !== undefined) {
      if (spec && typeof spec === 'object' && !Array.isArray(spec) && ('value' in spec || spec.compute)) {
        const used = specFrom(spec).filter(has).map((h) => index.get(normHeader(h)));
        if ('value' in spec || used.length || !specFrom(spec).length) {
          plan.push({ f, fd, spec, from: [] }); mapped[f] = 'value' in spec ? `(set to "${spec.value}")` : `(from ${used.join(' + ') || 'the row'})`; renamed++;
          if (spec.consume !== false) for (const u of used) consumed.add(u);
          continue;
        }
      } else {
        const hit = specFrom(spec).find(has);
        if (hit !== undefined) { const k = index.get(normHeader(hit)); plan.push({ f, fd, spec: typeof spec === 'object' && !Array.isArray(spec) ? spec : {}, from: [hit] }); if (k !== f) mapped[f] = k; consumed.add(k); renamed++; continue; }
        if (spec && typeof spec === 'object' && !Array.isArray(spec) && spec.default !== undefined) { plan.push({ f, fd, spec, from: [] }); mapped[f] = `(set to "${spec.default}")`; renamed++; continue; }
      }
    }
    // The agent's own name (any letter case or punctuation) is not a rename.
    if (has(f)) { const k = index.get(normHeader(f)); plan.push({ f, fd, spec: {}, from: [f] }); if (k !== f) consumed.add(k); continue; }
    // A nested JSON object is never taken for a column by its name alone.
    const alias = (fd.aliases || []).find((a) => has(a) && !nested.has(index.get(normHeader(a))));
    if (alias !== undefined) { const k = index.get(normHeader(alias)); plan.push({ f, fd, spec: {}, from: [alias] }); mapped[f] = k; consumed.add(k); renamed++; }
  }
  // Fields still without a column: try their names in German, French, Spanish,
  // Portuguese, Italian, Japanese, Chinese and Korean, never taking a column that
  // another field already uses. Files that read before read exactly the same.
  const translated = {};
  const usedCols = new Set(plan.flatMap((p) => p.from.map((h) => index.get(normHeader(h)))).filter(Boolean));
  for (const [f, fd0] of Object.entries(fields)) {
    if (plan.some((p) => p.f === f)) continue;
    const fd = fd0 || {};
    const hit = translatedNames(conceptOf(f, fd)).find((x) => { const k = index.get(normHeader(x.word)); return k !== undefined && !usedCols.has(k) && !nested.has(k); });
    if (!hit) continue;
    const k = index.get(normHeader(hit.word));
    plan.push({ f, fd, spec: {}, from: [k] }); mapped[f] = k; consumed.add(k); usedCols.add(k); renamed++; translated[f] = { column: clipName(k), language: hit.lang };
  }
  const forced = !!(ov.columns || ov.set || ov.date_order || ov.decimal || ov.profile || ov.encoding || ov.skip_rows !== undefined && ov.skip_rows !== null);
  const adapted = !!(profile || renamed || forced || headerRow > 0);
  const base = { arg, kind, file, format: table.format, ...(table.sheet ? { sheet: table.sheet } : {}), ...(table.encoding && table.encoding.name !== 'utf-8' ? { encoding: table.encoding.name } : {}), profile: profile ? profile.id : null, system: profile ? profile.system : null, export: profile ? profile.label || null : null };
  const encWarn = encodingWarning(table);
  if (!adapted) {
    // Untouched, but say so when a column the agent needs is nowhere in the file:
    // otherwise the agent would quietly read every row as blank.
    const absent = records.length ? Object.entries(fields).filter(([f, fd]) => fd && fd.required && !has(f)).map(([f]) => f) : [];
    return { rows: records, report: { ...base, adapted: false, rows: records.length, mapped: {}, unmapped: [], missing: absent, skipped_rows: 0, warnings: [...(encWarn ? [encWarn] : []), ...(absent.length ? [`None of this file's columns was recognised as: ${absent.join(', ')}. Name the columns in ${SOURCES_FILE} (see "inspect").`] : [])] } };
  }

  // Column-wide decisions: date order and decimal mark.
  const colValues = (p) => records.slice(0, 5000).map((r) => getter(r, index)(p.from[0]));
  let dateOrder = ov.date_order || (profile && profile.dateOrder) || null; const orderSeen = new Set();
  if (!dateOrder) for (const p of plan) if ((p.fd.type === 'date' || p.fd.type === 'datetime') && p.from.length) { const o = inferDateOrder(colValues(p)); if (o) orderSeen.add(o); }
  if (!dateOrder) dateOrder = orderSeen.has('mixed') || (orderSeen.has('mdy') && orderSeen.has('dmy')) ? 'mixed' : orderSeen.has('dmy') ? 'dmy' : orderSeen.has('mdy') ? 'mdy' : null;
  // Soft guess: with nothing else to go on, dates written with dots (03.04.2026)
  // are read day-first, and the warning below says so.
  let softDmy = false;
  if (!dateOrder) {
    const numeric = plan.filter((p) => (p.fd.type === 'date' || p.fd.type === 'datetime') && p.from.length).flatMap(colValues).map((v) => /^\d{1,2}([/.-])\d{1,2}\1(\d{4}|\d{2})(?!\d)/.exec(String(v ?? '').trim())).filter(Boolean);
    if (numeric.length && numeric.every((m) => m[1] === '.')) { softDmy = true; dateOrder = 'dmy'; }
  }
  const decimals = new Map();
  for (const p of plan) if ((p.fd.type === 'money' || p.fd.type === 'number') && p.from.length) decimals.set(p.f, ov.decimal || (profile && profile.decimal) || inferDecimal(colValues(p)));

  let ambiguousDates = 0, badDates = 0, badAmounts = 0, convertedDates = 0, numericDates = 0, skipped = 0;
  // A value set by a profile's "values" table or "default" is final: it is the
  // agent's own word ("never", "active") and is not parsed as a date or amount.
  const convert = (p, v, final = false) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return v;
    let s = typeof v === 'string' ? v.trim() : String(v);
    const vals = p.spec.values || p.fd.values;
    if (vals && s !== '') { const hit = Object.keys(vals).find((k) => k.toLowerCase() === s.toLowerCase()); if (hit !== undefined) return String(vals[hit]); }
    if (s === '' || final) return s;
    const type = p.fd.type || 'text';
    if (type === 'date' || type === 'datetime') {
      const d = parseAnyDate(s, { order: dateOrder === 'dmy' ? 'dmy' : 'mdy', compact: !!(profile && profile.compactDates) });
      if (!d) { badDates++; return s; }
      if (d.already) return s;
      if (d.ambiguous && (!dateOrder || dateOrder === 'mixed' || softDmy)) ambiguousDates++;
      convertedDates++; if (d.numeric) numericDates++;
      return type === 'date' ? d.date : d.iso;
    }
    if (type === 'money' || type === 'number') {
      if (/^-?\d+(\.\d+)?$/.test(s)) return s;
      const a = cleanAmount(s, { decimal: decimals.get(p.f) || '.' });
      if (a === null) { badAmounts++; return s; }
      return a;
    }
    if (type === 'bool') { const [y, n] = p.fd.bool || ['yes', 'no']; return TRUE.test(s) ? y : FALSE.test(s) ? n : s; }
    if (type === 'email') return s.toLowerCase();
    return s;
  };

  const planFields = new Set(plan.map((p) => p.f));
  const byKey = new Map();
  for (const p of plan) if (p.from.length && !('value' in p.spec) && !p.spec.compute) { const k = index.get(normHeader(p.from[0])); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
  // A nested JSON object whose parts were mapped is not passed on whole.
  const consumedParents = new Set([...consumed].filter((k) => k.includes('.')).map((k) => k.split('.')[0]));
  let rows = [];
  const planNorm = new Set([...planFields].map(normHeader));
  const helpers = { date: (v, o) => { const d = parseAnyDate(v, { order: o || (dateOrder === 'dmy' ? 'dmy' : 'mdy') }); return d ? d.date : ''; }, amount: (v, o) => cleanAmount(v, o) ?? '', norm: normHeader };
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { skipped++; continue; }
    const get = getter(r, index);
    if (profile && profile.skipRow && profile.skipRow(r, get)) { skipped++; continue; }
    if (profile && profile.dropTotals) { const firstCell = String(Object.values(r).find((v) => String(v ?? '').trim() !== '') ?? '').trim(); if (/^(grand\s+)?(sub)?totals?\b/i.test(firstCell) || /^net (income|total)\b/i.test(firstCell)) { skipped++; continue; } }
    const out = {}; const done = new Set();
    const put = (p) => {
      if (done.has(p.f)) return; done.add(p.f);
      let v; let final = false;
      if ('value' in p.spec) { v = p.spec.value; final = true; }
      else if (p.spec.compute) { v = p.spec.compute(r, get, helpers); if ((v === undefined || v === null || String(v).trim() === '') && p.spec.default !== undefined) { v = p.spec.default; final = true; } }
      else {
        v = get(p.from[0]);
        const blank = v === undefined || v === null || String(v).trim() === '';
        if (blank && p.spec.default !== undefined) { v = p.spec.default; final = true; }
        else if (!blank && p.spec.transform) v = p.spec.transform(v, r, get, helpers);
      }
      out[p.f] = convert(p, v, final);
    };
    // Keep the file's column order: a mapped column appears under the agent's name in its old place.
    for (const k of Object.keys(r)) {
      if (byKey.has(k)) for (const p of byKey.get(k)) put(p);
      if (planFields.has(k) || consumed.has(k) || consumedParents.has(k)) continue;
      // A file column that only differs from one of the agent's names by letter case
      // ("Type" beside the agent's "type") must not shadow the mapped value.
      if (planNorm.has(normHeader(k))) continue;
      out[k] = r[k];
    }
    for (const p of plan) put(p);
    rows.push(out);
  }
  const rowsIn = rows.length;
  if (profile && profile.rows) rows = profile.rows(rows, helpers) || rows;

  // Columns a profile's row hook fills in (the group name of a grouped report).
  const provided = new Set((profile && profile.provides) || []);
  for (const f of provided) if (!(f in mapped)) mapped[f] = '(from the report layout)';
  const missing = Object.entries(fields).filter(([f, fd]) => fd && fd.required && !planFields.has(f) && !provided.has(f)).map(([f]) => f);
  const unmapped = headers.filter((h) => table.matrix || !h.includes('.')).filter((h) => !consumed.has(h) && !consumedParents.has(h) && !planFields.has(h) && !planNorm.has(normHeader(h))).map(clipName);
  if (encWarn) warnings.push(encWarn);
  if (missing.length) warnings.push(`No column found for: ${missing.join(', ')}. Name the columns in ${SOURCES_FILE} (see "inspect").`);
  if (ambiguousDates && softDmy) warnings.push(`${ambiguousDates} date(s) such as 03.04.2026 could be day-first or month-first; read as day/month/year because the file writes dates with dots. Set "date_order": "mdy" in ${SOURCES_FILE} if the file is month-first.`);
  else if (ambiguousDates) warnings.push(`${ambiguousDates} date(s) such as 03/04/2026 could be month-first or day-first; read as month/day/year. Set "date_order": "dmy" in ${SOURCES_FILE} if the file is day-first.`);
  if (dateOrder === 'mixed') warnings.push(`The date columns mix month-first and day-first values; each was read by its own digits where possible. Check the dates.`);
  if (badDates) warnings.push(`${badDates} date value(s) could not be read and were left as they are.`);
  if (badAmounts) warnings.push(`${badAmounts} amount value(s) could not be read and were left as they are.`);
  return {
    rows,
    report: {
      ...base, adapted: true, rows: rows.length,
      mapped: Object.fromEntries(Object.entries(mapped).map(([k, v]) => [k, clipName(v)])),
      unmapped: unmapped.slice(0, 60), missing,
      skipped_rows: skipped + headerRow, ...(headerRow ? { header_row: headerRow + 1 } : {}), ...(rowsIn !== rows.length ? { rows_before_grouping: rowsIn } : {}),
      ...(numericDates ? { dates_read_as: dateOrder === 'dmy' ? 'day/month/year' : dateOrder === 'mixed' ? 'mixed' : 'month/day/year' } : {}), ...(convertedDates ? { dates_converted: convertedDates } : {}),
      ...([...decimals.values()].includes(',') ? { decimal_mark: ',' } : {}),
      ...(Object.keys(translated).length ? { translated_columns: translated } : {}),
      ...(profile && profile.note ? { note: profile.note } : {}),
      warnings,
    },
  };
}

/** JSON Schema for mythos-sources.json. */
const OVERRIDE = {
  type: 'object', additionalProperties: false,
  properties: {
    profile: { type: 'string', minLength: 1, description: 'Force one export profile by id' },
    columns: { type: 'object', additionalProperties: { type: 'string', minLength: 1 }, description: 'Agent column -> the column name in your file' },
    set: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'Agent column -> one value for every row (for a column the export does not have, such as the app name or the seat price)' },
    date_order: { type: 'string', enum: ['mdy', 'dmy'] },
    decimal: { type: 'string', enum: ['.', ','] },
    sheet: { type: ['string', 'integer'], description: 'Excel sheet name or 0-based index' },
    skip_rows: { type: 'integer', minimum: 0, maximum: 1000, description: 'Rows above the header row' },
    delimiter: { type: 'string', enum: [',', ';', '\t', '|'] },
    encoding: { type: 'string', minLength: 3, maxLength: 40, description: `Text encoding of the file when it is not UTF-8: ${ENCODINGS.join(', ')} (also sjis, cp932, cp949, cp936, cp1252)` },
  },
};
export const SOURCES_CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    $schema: { type: 'string' }, note: { type: 'string' },
    sources: { type: 'object', additionalProperties: OVERRIDE, description: 'Keyed by source kind (see "<agent> sources")' },
    files: { type: 'object', additionalProperties: OVERRIDE, description: 'Keyed by file path relative to the root; wins over "sources"' },
  },
};

/** Read and check <root>/mythos-sources.json. Returns null when there is none. */
export function loadSourceOverrides(root) {
  const f = join(root, SOURCES_FILE);
  if (!existsSync(f)) return null;
  let data;
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${SOURCES_FILE} is not valid JSON: ${e.message}`); }
  assertValid(SOURCES_CONFIG_SCHEMA, data, `${SOURCES_FILE} is not valid`);
  for (const group of ['sources', 'files']) for (const [k, v] of Object.entries(data[group] || {})) if (v.encoding && !encodingName(v.encoding)) throw new Error(`${SOURCES_FILE}: ${group}.${k}.encoding "${v.encoding}" is not one of: ${ENCODINGS.join(', ')}`);
  return data;
}

/** The override that applies to one file of one kind. */
export function overrideFor(config, kind, relPath) {
  if (!config) return null;
  const rel = String(relPath || '').split('\\').join('/').replace(/^\.\//, '');
  const a = (config.sources && config.sources[kind]) || null; const b = (config.files && config.files[rel]) || null;
  return a || b ? { ...(a || {}), ...(b || {}), ...(a && b && (a.columns || b.columns) ? { columns: { ...(a.columns || {}), ...(b.columns || {}) } } : {}) } : null;
}

/** Map of argument name -> source kind for one tool. */
export function kindsByArg(manifest, toolName) {
  const out = new Map();
  for (const [kind, def] of Object.entries(manifest.sources || {})) {
    for (const a of (def && def.args) || [kind]) {
      const [t, name] = a.includes('.') ? a.split('.', 2) : [null, a];
      if (t && t !== toolName) continue;
      if (t || !out.has(name)) out.set(name, kind);
    }
  }
  return out;
}

/** Plain list of what a manifest can read, for docs, the CLI and the inspect tool. */
export function describeSources(manifest) {
  return Object.entries(manifest.sources || {}).map(([kind, def]) => ({
    kind, label: def.label || kind, args: (def.args || [kind]).map((a) => a.split('.').pop()).filter((a, i, arr) => arr.indexOf(a) === i),
    columns: Object.entries(def.fields || {}).map(([name, fd]) => ({ name, type: (fd && fd.type) || 'text', required: !!(fd && fd.required), also_called: (fd && fd.aliases) || [] })),
    exports: (def.profiles || []).map((p) => ({ id: p.id, system: p.system, label: p.label || '', layout_checked: p.basis === 'documented' ? `against ${p.source || 'vendor documentation'} on ${p.checked || 'an unrecorded date'}` : 'no', recognised_by: (p.signature || []).map((s) => (Array.isArray(s) ? s.join(' or ') : s)), ...(p.headerless ? { headerless: true } : {}), ...(p.howTo ? { how_to_export: p.howTo } : {}) })),
  }));
}

/** What a column's values look like, without quoting any value. */
export function columnShape(values) {
  const vals = values.map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? '[object]' : String(v).trim())).filter((v) => v !== '');
  if (!vals.length) return 'empty';
  const share = (re) => vals.filter((v) => re.test(v)).length / vals.length;
  if (share(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) >= 0.8) return 'email addresses';
  if (share(/^\d{4}-\d{2}-\d{2}([T ]|$)/) >= 0.8) return 'dates (ISO)';
  if (vals.filter((v) => parseAnyDate(v)).length / vals.length >= 0.8) {
    const o = inferDateOrder(vals); const unclear = vals.some((v) => { const d = parseAnyDate(v); return d && d.ambiguous; });
    return o === 'dmy' ? 'dates (day first)' : o === 'mdy' ? 'dates (month first)' : o === 'mixed' ? 'dates (mixed order)' : unclear ? 'dates (month or day first: unclear)' : 'dates';
  }
  if (share(/^(y|n|yes|no|true|false|t|f)$/i) >= 0.9) return 'yes/no';
  if (share(/^-?\d+(\.\d+)?$/) >= 0.9) return 'numbers';
  if (vals.filter((v) => cleanAmount(v) !== null).length / vals.length >= 0.9) return 'amounts';
  const distinct = new Set(vals.map((v) => v.toLowerCase()));
  if (distinct.size <= 8 && vals.length >= distinct.size * 2) return `text (${distinct.size} distinct value${distinct.size === 1 ? '' : 's'})`;
  return 'text';
}
