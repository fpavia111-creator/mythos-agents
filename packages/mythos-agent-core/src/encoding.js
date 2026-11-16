// Decode a text export whatever encoding it was saved in.
//
// Most systems write UTF-8, but Excel and older accounting software in Japan,
// China, Korea, Taiwan and Europe still save CSV files as Shift_JIS, GBK,
// EUC-KR, Big5 or Windows-1252, and Excel's "Unicode text" is UTF-16. Reading
// those as UTF-8 turns every non-English header and name into replacement
// characters. Order of decisions:
//   1. an encoding the user set (mythos-sources.json "encoding", --encoding);
//   2. a byte-order mark (UTF-8, UTF-16 LE/BE);
//   3. valid UTF-8 (every plain-ASCII file is valid UTF-8);
//   4. otherwise a guess among the legacy encodings, scored by how many header
//      cells become known column names and how plausible the characters are.
// A guess is always reported, with how to set the encoding if it is wrong.

import { normHeader } from './intl.js';
import { KNOWN_HEADER_WORDS } from './i18n/columns.js';

export const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'shift_jis', 'euc-jp', 'euc-kr', 'gb18030', 'gbk', 'big5', 'windows-1252', 'iso-8859-1', 'iso-8859-15'];
const ALIASES = { utf8: 'utf-8', 'utf-16': 'utf-16le', sjis: 'shift_jis', 'shift-jis': 'shift_jis', cp932: 'shift_jis', 'windows-31j': 'shift_jis', cp949: 'euc-kr', 'ks_c_5601-1987': 'euc-kr', uhc: 'euc-kr', gb2312: 'gbk', cp936: 'gbk', cp950: 'big5', cp1252: 'windows-1252', latin1: 'iso-8859-1', 'latin-1': 'iso-8859-1', latin9: 'iso-8859-15' };
// Legacy encodings tried for a file that is not UTF-8, and the language each one suggests.
const LEGACY = ['shift_jis', 'euc-kr', 'gb18030', 'big5', 'windows-1252'];
const FOR_LANG = { ja: 'shift_jis', ko: 'euc-kr', zh: 'gb18030', 'zh-tw': 'big5', 'zh-hk': 'big5', de: 'windows-1252', fr: 'windows-1252', es: 'windows-1252', pt: 'windows-1252', it: 'windows-1252', en: 'windows-1252', nl: 'windows-1252' };

/** The canonical name of an encoding label, or null when it is not one we read. */
export function encodingName(label) {
  if (!label) return null;
  const l = String(label).trim().toLowerCase();
  const n = ALIASES[l] || l;
  return ENCODINGS.includes(n) ? n : null;
}

const strict = (enc) => new TextDecoder(enc, { fatal: true });

// Windows-1252 is decoded here rather than by TextDecoder: Node 20 decodes bytes
// 0x80-0x9F as control characters, so "1.234,56 €" lost its euro sign and quotes
// and dashes from Word turned into invisible characters. ISO-8859-1 is read the same
// way, as browsers do.
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
function decode1252(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    const end = Math.min(buf.length, i + 8192); const codes = new Array(end - i);
    for (let k = i; k < end; k++) { const b = buf[k]; codes[k - i] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b; }
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}
const SINGLE_BYTE = new Set(['windows-1252', 'iso-8859-1']);
/** Decode a whole buffer in one encoding (replacement characters for bad bytes). */
function decodeAs(buf, enc) {
  return SINGLE_BYTE.has(enc) ? decode1252(buf) : new TextDecoder(enc).decode(buf);
}

/** Decode or null on a byte sequence the encoding does not allow. partial: the bytes stop mid-file, so a cut character at the end is not an error. */
function tryDecode(buf, enc, partial = false) {
  if (SINGLE_BYTE.has(enc)) return decode1252(buf);
  try { return strict(enc).decode(buf, { stream: partial }); } catch { return null; }
}

const asciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isLatin = (c) => c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7;
/** 0..1: how much the non-ASCII text of a decoding looks like real text in that encoding's languages. */
function plausibility(text, enc) {
  let good = 0, bad = 0, hangul = 0, open = 0;
  const n = Math.min(text.length, 20000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    const prev = i ? text.charCodeAt(i - 1) : 32, next = i + 1 < n ? text.charCodeAt(i + 1) : 32;
    if (c === 0xfffd || (c >= 0x80 && c < 0xa0) || (c >= 0xe000 && c <= 0xf8ff)) { bad += 2; continue; }
    const han = (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf), kana = c >= 0x3040 && c <= 0x30ff;
    const gul = c >= 0xac00 && c <= 0xd7a3, halfKana = c >= 0xff61 && c <= 0xff9f;
    if (isLatin(c)) { if (enc === 'windows-1252' && (asciiLetter(prev) || asciiLetter(next) || isLatin(prev) || isLatin(next))) good++; else bad++; continue; }
    if (han || kana || gul || halfKana) {
      // One East Asian character inside a Latin word is an accented letter read with the wrong table.
      if (asciiLetter(prev) && asciiLetter(next)) { bad += 2; continue; }
      if (enc === 'windows-1252') { bad++; continue; }
      if (halfKana) { if (enc === 'shift_jis') { good += 0.5; bad += 0.5; } else bad++; continue; }
      if (kana) { if (enc === 'shift_jis') good++; else bad++; continue; }
      if (gul) { hangul++; if ((c - 0xac00) % 28 === 0) open++; if (enc === 'euc-kr') good++; else bad++; continue; }
      if (enc === 'euc-kr') { good += 0.3; bad += 0.7; } else good++;
      continue;
    }
    if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff01 && c <= 0xff60)) { if (enc === 'windows-1252') bad++; else good++; continue; }
    if (enc === 'windows-1252' && [0x20ac, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0xa0, 0xb0, 0xa3, 0xa7, 0xaa, 0xba, 0xb4, 0xa9, 0xae].includes(c)) good++;
    else bad += 0.5;
  }
  // Korean text has many syllables without a final consonant; bytes from another
  // East Asian encoding read as Korean give far fewer.
  if (enc === 'euc-kr' && hangul >= 12 && open / hangul < 0.3) { bad += good * 0.5; good *= 0.5; }
  return good + bad ? good / (good + bad) : 1;
}

/** Header cells in the first lines of a decoding that are known column names in some language. */
function headerHits(text, extraWords) {
  let hits = 0;
  for (const line of text.slice(0, 8000).split(/\r?\n/).slice(0, 40)) {
    for (const cell of line.split(/[,;\t|]/)) {
      const k = normHeader(cell.replace(/^\s*"|"\s*$/g, ''));
      if (k && k.length > 1 && (KNOWN_HEADER_WORDS.has(k) || (extraWords && extraWords.has(k)))) hits++;
    }
  }
  return hits;
}

/**
 * Decode the bytes of a text export.
 * options: encoding (set by the user), lang (a hint such as 'ja' or 'ko'),
 * words (a Set of normalised header names the caller expects).
 * Returns { text, encoding, how } where how is 'set', 'bom', 'utf-8' or 'guessed',
 * plus { candidates } when guessed.
 */
export function decodeText(buf, { encoding = null, lang = null, words = null } = {}) {
  const set = encodingName(encoding);
  if (encoding && !set) throw new Error(`unknown encoding "${encoding}"; use one of: ${ENCODINGS.join(', ')}`);
  if (set) {
    const skip = set === 'utf-8' && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : (set.startsWith('utf-16') && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) ? 2 : 0;
    return { text: decodeAs(buf.subarray(skip), set), encoding: set, how: 'set' };
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8', how: 'bom' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', how: 'bom' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', how: 'bom' };
  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', how: 'utf-8' };
  // UTF-16 without a mark: every other byte of an ASCII-heavy header is zero.
  const sample = buf.subarray(0, 4000);
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) { if (sample[i] === 0) evenZero++; if (sample[i + 1] === 0) oddZero++; }
  const pairs = Math.floor(sample.length / 2) || 1;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le', how: 'guessed', candidates: [] };
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be', how: 'guessed', candidates: [] };
  const hint = FOR_LANG[String(lang || '').toLowerCase()] || FOR_LANG[String(lang || '').toLowerCase().slice(0, 2)] || null;
  const head = buf.subarray(0, 65536);
  const scored = [];
  for (const enc of LEGACY) {
    const t = tryDecode(head, enc, head.length < buf.length);
    if (t === null) continue;
    const p = plausibility(t, enc), h = headerHits(t, words);
    scored.push({ encoding: enc, score: h * 2 + p + (enc === hint ? 0.25 : 0), header_words: h, plausibility: Math.round(p * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score || LEGACY.indexOf(a.encoding) - LEGACY.indexOf(b.encoding));
  const best = scored[0] ? scored[0].encoding : 'windows-1252';
  return { text: decodeAs(buf, best), encoding: best, how: 'guessed', candidates: scored.slice(0, 3).map(({ encoding: e, header_words, plausibility: p }) => ({ encoding: e, header_words, plausibility: p })) };
}
