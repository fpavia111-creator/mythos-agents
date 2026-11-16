// Minimal XLSX reader (and a small writer) on top of the zip reader. No
// dependencies. Reads one worksheet into rows of text cells, the way a CSV
// export of the same sheet would look: shared and inline strings, numbers,
// booleans, and dates (cells with a date number format become ISO dates).
// Formulas are never evaluated: the cached value Excel saved is used.

import { readZip, writeZip } from './zip.js';

const MAX_CELLS = 5_000_000;
const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&')
  .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const attr = (tag, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag); return m ? unesc(m[1]) : null; };

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
/** True when an Excel number format code shows a date or time. */
export function isDateFormat(code) {
  const c = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
  if (/^general$/i.test(c.trim())) return false;
  return /[dmyhs]/i.test(c) && !/[#0?]/.test(c.replace(/[0#?]*\.?0+(?=\s*(am|a\/p))/i, '').replace(/s+\.0+/i, 's'));
}

/** Excel serial number -> ISO date ("2026-11-03") or date-time ("2026-11-03T14:30:00"). */
export function excelSerialToIso(serial, { date1904 = false } = {}) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n); let secs = Math.round((n - whole) * 86400);
  let days = whole; if (secs >= 86400) { secs -= 86400; days += 1; }
  // 1900 system: serial 1 = 1900-01-01, with the phantom 1900-02-29 at serial 60.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  if (!date1904 && days < 61) days += 1;
  const d = new Date(epoch + days * 86400000);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toISOString().slice(0, 10);
  if (!secs) return date;
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}`;
  return whole === 0 ? time : `${date}T${time}`;
}

const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };
const tidyNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : String(v); };

/** Sheet names of a workbook, in tab order. */
export function xlsxSheets(buf) { return workbook(readZip(buf, { only: (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(n) })).sheets.map((s) => s.name); }

function workbook(z) {
  const wb = z.get('xl/workbook.xml');
  if (!wb) throw new Error('not an Excel .xlsx file (xl/workbook.xml missing). Old .xls files are not supported: save as .xlsx or .csv.');
  const xml = wb.toString('utf8');
  const rels = new Map();
  const relXml = z.get('xl/_rels/workbook.xml.rels');
  if (relXml) for (const m of relXml.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [...xml.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => {
    const target = rels.get(attr(m[0], 'r:id')) || `worksheets/sheet${i + 1}.xml`;
    return { name: attr(m[0], 'name') || `Sheet${i + 1}`, hidden: !!attr(m[0], 'state') && attr(m[0], 'state') !== 'visible', path: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
  });
  return { sheets, date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(xml) };
}

/**
 * Read one sheet of an .xlsx workbook.
 * sheet: a sheet name or 0-based index (default: the first visible sheet).
 * Returns { sheet, sheets, rows } where rows is an array of arrays of strings.
 */
export function readXlsx(buf, { sheet = null } = {}) {
  const z = readZip(buf, { only: (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n) });
  const wb = workbook(z);
  if (!wb.sheets.length) throw new Error('the workbook has no sheets');
  let pick;
  if (sheet === null || sheet === undefined || sheet === '') pick = wb.sheets.find((s) => !s.hidden) || wb.sheets[0];
  else if (typeof sheet === 'number') pick = wb.sheets[sheet];
  else pick = wb.sheets.find((s) => s.name === sheet) || wb.sheets.find((s) => s.name.toLowerCase() === String(sheet).toLowerCase());
  if (!pick) throw new Error(`sheet "${sheet}" not found; the workbook has: ${wb.sheets.map((s) => s.name).join(', ')}`);
  const data = z.get(pick.path);
  if (!data) throw new Error(`sheet "${pick.name}" has no data part (${pick.path})`);

  const shared = [];
  const ss = z.get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    shared.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(''));
  }
  const dateStyle = [];
  const st = z.get('xl/styles.xml');
  if (st) {
    const sx = st.toString('utf8'); const custom = new Map();
    for (const m of sx.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode'));
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(sx);
    if (xfs) for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) { const id = Number(attr(m[0], 'numFmtId') || 0); dateStyle.push(custom.has(id) ? isDateFormat(custom.get(id)) : BUILTIN_DATE.has(id)); }
  }

  const rows = []; let cells = 0;
  const xml = data.toString('utf8');
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const rIdx = rm[1] && attr(rm[1], 'r') ? Number(attr(rm[1], 'r')) - 1 : rows.length;
    const row = []; let next = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r'); const idx = ref ? colIndex(ref) : next; next = idx + 1;
      if (idx < 0 || idx > 16383) continue;
      if (++cells > MAX_CELLS) throw new Error(`the sheet has more than ${MAX_CELLS} cells; export a smaller range or use CSV`);
      const t = attr(cm[1], 't'); const body = cm[2] || '';
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body); const raw = vm ? unesc(vm[1]) : '';
      let val = '';
      if (t === 's') val = shared[Number(raw)] ?? '';
      else if (t === 'inlineStr') val = [...body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join('');
      else if (t === 'str' || t === 'e') val = raw;
      else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'd') val = raw;
      else if (raw !== '') { const s = Number(attr(cm[1], 's') || 0); val = dateStyle[s] ? (excelSerialToIso(raw, wb) ?? tidyNumber(raw)) : tidyNumber(raw); }
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    while (rows.length < rIdx && rows.length < 2_000_000) rows.push([]);
    rows[rIdx] = row;
  }
  // Blank rows are dropped, as the CSV reader drops blank lines.
  return { sheet: pick.name, sheets: wb.sheets.map((s) => s.name), rows: rows.filter((r) => r && r.some((c) => String(c).trim() !== '')) };
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/**
 * Write a small .xlsx workbook. sheets: { "Sheet name": rows } where rows is an
 * array of arrays. Numbers become numeric cells, Date values become date cells
 * (UTC), everything else is text. Text is never written as a formula.
 */
export function writeXlsx(sheets) {
  const names = Object.keys(sheets);
  if (!names.length) throw new Error('writeXlsx needs at least one sheet');
  const files = new Map();
  files.set('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  files.set('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files.set('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files.set('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files.set('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>');
  names.forEach((n, i) => {
    const body = (sheets[n] || []).map((row, r) => `<row r="${r + 1}">${(row || []).map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (v === null || v === undefined || v === '') return '';
      if (v instanceof Date) { const serial = (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000; return `<c r="${ref}" s="${Number.isInteger(serial) ? 1 : 2}"><v>${serial}</v></c>`; }
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    files.set(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`);
  });
  return writeZip(files);
}
