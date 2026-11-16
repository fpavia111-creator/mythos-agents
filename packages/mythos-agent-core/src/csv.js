// Minimal RFC 4180 CSV parser/writer. No dependencies.

/** Parse delimited text into rows of cells (no header handling). */
export function parseCsvRows(text, { delimiter = ',' } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Rows of cells -> objects keyed by the header row (cells and headers trimmed). */
export function rowsToRecords(rows, headerIndex = 0) {
  if (!rows.length || headerIndex >= rows.length) return [];
  const header = rows[headerIndex].map((h) => String(h ?? '').trim());
  return rows.slice(headerIndex + 1).map((r) => {
    const o = {};
    header.forEach((h, idx) => { o[h] = String(r[idx] ?? '').trim(); });
    return o;
  });
}

export function parseCsv(text, opts) { return rowsToRecords(parseCsvRows(text, opts)); }

/**
 * Guess the delimiter of a delimited text file from its first lines: comma
 * unless the header line has no comma outside quotes and a tab, semicolon or
 * pipe splits the first two lines into the same number (2 or more) of cells.
 */
export function sniffDelimiter(text) {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!lines.length) return ',';
  const count = (line, d) => { let n = 0, q = false; for (const c of line) { if (c === '"') q = !q; else if (c === d && !q) n++; } return n; };
  if (count(lines[0], ',') > 0) return ',';
  for (const d of ['\t', ';', '|']) {
    const n = count(lines[0], d);
    if (n >= 1 && lines.slice(1, 3).every((l) => count(l, d) === n)) return d;
  }
  return ',';
}

function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const PLAIN_NUMBER = /^[+-]?(\d[\d,]*)?(\.\d+)?(e[+-]?\d+)?%?$/i;
// A sign followed only by digits and phone punctuation: "+1 (555) 010-0100", "-12.50".
const SIGNED_DIGITS = /^[+-][\d\s().,\-]*%?$/;

/**
 * Stop a spreadsheet running a cell as a formula. Excel, Sheets and LibreOffice run
 * a cell that starts with = + - or @ as a formula, so text from an untrusted
 * source can call out to the network, start a program through DDE, or change
 * what the reader sees. Such a cell gets a leading apostrophe, which the
 * spreadsheet shows as plain text.
 *
 * Left alone, because they cannot call anything: plain numbers (-12.50, +3,
 * -1e5, -4%), phone-style values made only of a sign, digits and punctuation
 * (+1 555 010 0100), and @handles or @scope/package names with no "(", "|" or "!".
 */
export function neutraliseFormula(v) {
  if (typeof v !== 'string' || !v) return v;
  const c = v[0];
  if (c === '=' || c === '\t' || c === '\r') return "'" + v;
  if (c === '+' || c === '-') return PLAIN_NUMBER.test(v) || SIGNED_DIGITS.test(v) ? v : "'" + v;
  if (c === '@') return /[(|!]/.test(v) ? "'" + v : v;
  return v;
}

/**
 * Write CSV. Formula-looking cells are neutralised by default (see
 * neutraliseFormula); pass { formulas: 'keep' } (or { raw: true }) when the
 * file is read back by a program and must round-trip byte for byte.
 */
export function toCsv(rows, columns, { formulas = 'escape', raw = false } = {}) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = raw || formulas === 'keep' ? esc : (v) => esc(typeof v === 'string' ? neutraliseFormula(v) : v);
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
