// Read a tabular file (CSV, TSV, semicolon or pipe delimited text, Excel
// .xlsx, JSON array, JSONL) into either rows of cells or records.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { parseCsvRows, sniffDelimiter } from './csv.js';
import { readXlsx } from './xlsx.js';
import { decodeText } from './encoding.js';

const DELIMITER_NAME = { ',': 'csv', '\t': 'tsv', ';': 'semicolon-delimited', '|': 'pipe-delimited' };
export const TABLE_EXTENSIONS = ['.csv', '.tsv', '.tab', '.txt', '.xlsx', '.xlsm', '.json', '.jsonl', '.ndjson'];

/**
 * Read a table file.
 * Returns { format, matrix } for delimited text and Excel (matrix: rows of
 * string cells, header row not yet chosen) or { format, records } for JSON.
 * Excel results also carry { sheet, sheets }. Text results carry
 * { encoding: { name, how } }: how is 'set', 'bom', 'utf-8' or 'guessed'
 * (see encoding.js). encoding: force one; lang: a hint for the guess.
 */
export function readTable(file, { sheet = null, delimiter = null, encoding = null, lang = null, words = null } = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`file not found: ${file}`);
  const ext = extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const x = readXlsx(readFileSync(file), { sheet });
    return { format: 'xlsx', matrix: x.rows, sheet: x.sheet, sheets: x.sheets };
  }
  if (ext === '.xls') throw new Error(`${file}: old Excel .xls files are not supported; save the file as .xlsx or .csv`);
  const decode = () => { const d = decodeText(readFileSync(file), { encoding, lang, words }); return { text: d.text, enc: { name: d.encoding, how: d.how, ...(d.candidates && d.candidates.length ? { candidates: d.candidates } : {}) } }; };
  if (ext === '.csv' || ext === '.tsv' || ext === '.tab' || ext === '.txt') {
    const { text, enc } = decode();
    const d = delimiter || (ext === '.tsv' || ext === '.tab' ? '\t' : sniffDelimiter(text));
    return { format: DELIMITER_NAME[d] || 'delimited', delimiter: d, matrix: parseCsvRows(text, { delimiter: d }), encoding: enc };
  }
  if (ext === '.jsonl' || ext === '.ndjson') {
    const { text, enc } = decode();
    return { format: 'jsonl', encoding: enc, records: text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch { throw new Error(`${file}: line ${i + 1} is not valid JSON`); }
    }) };
  }
  if (ext === '.json') {
    const { text, enc } = decode();
    const data = JSON.parse(text);
    if (Array.isArray(data)) return { format: 'json', records: data, encoding: enc };
    for (const k of ['records', 'rows', 'data', 'items']) if (data && Array.isArray(data[k])) return { format: 'json', records: data[k], envelope: k, encoding: enc };
    // An API response that wraps the list under one name of its own ({"seats": [...]}).
    const arrays = data && typeof data === 'object' ? Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) : [];
    if (arrays.length === 1) return { format: 'json', records: arrays[0][1], envelope: arrays[0][0], encoding: enc };
    throw new Error(`${file}: expected a JSON array (or {records: [...]})`);
  }
  throw new Error(`${file}: unsupported file type ${ext || '(none)'}; use .csv, .tsv, .xlsx, .json or .jsonl`);
}
