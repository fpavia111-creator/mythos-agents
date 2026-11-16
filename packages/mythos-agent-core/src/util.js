import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { rowsToRecords } from './csv.js';
import { readTable } from './tables.js';
import { readNumber } from './intl.js';

export function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

/** Stable JSON (sorted keys) so the same args always hash the same. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function within(root, abs) {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Real path of p, or of its nearest existing ancestor joined with the rest. */
function realish(p) {
  let cur = p; const rest = [];
  for (let i = 0; i < 4096; i++) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* keep walking up */ }
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.push(basename(cur)); cur = parent;
  }
  return p;
}

/**
 * Resolve a user path and refuse anything outside root: "..", absolute paths
 * elsewhere, NUL bytes, symlinks (at any level) that point outside root, and
 * paths longer than real file systems allow (on Windows, Node's recursive mkdir
 * never returns for a path past about 32,767 characters, so this check runs first).
 */
export const MAX_PATH_CHARS = 4096;
export const MAX_NAME_CHARS = 255;
export function safePath(root, p) {
  if (typeof p !== 'string' || !p) throw new Error('path is required');
  if (p.includes('\0')) throw new Error('path contains a NUL byte');
  if (p.length > MAX_PATH_CHARS) throw new Error(`path is too long (${p.length} characters; the limit is ${MAX_PATH_CHARS})`);
  if (p.split(/[\\/]/).some((s) => s.length > MAX_NAME_CHARS)) throw new Error(`a folder or file name in the path is longer than ${MAX_NAME_CHARS} characters`);
  const r = resolve(root);
  const abs = resolve(r, p);
  if (!within(r, abs)) throw new Error(`path "${p}" is outside the allowed root`);
  const realRoot = realish(r);
  if (!within(realRoot, realish(abs))) throw new Error(`path "${p}" leaves the allowed root through a symlink`);
  return abs;
}

/**
 * Read a CSV, TSV, Excel .xlsx, JSON array or JSONL file into an array of plain
 * objects (the first row is the header). No column mapping: see adaptRecords.
 */
export function readRecords(file, opts) {
  const t = readTable(file, opts);
  return t.records || rowsToRecords(t.matrix);
}

/**
 * A number from a cell, or null. Plain numbers are read as they are; anything
 * else goes through cleanAmount, so "$1,200.00", "(45)", "1.234,56 €", "12,5"
 * and "1,200円" all read. decimal: the column's decimal mark when known
 * (',' makes "1.234" a thousand and more); see numberReader.
 */
export function toNumber(v, opts) { return readNumber(v, opts || undefined); }

export const round2 = (n) => Math.round(n * 100) / 100;

/** sha256 of a file's bytes. */
export function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
