// Small, zero-dependency readers for bank statement files: ISO 20022 CAMT.053 (XML),
// SWIFT MT940 (common in Germany and across Europe), BAI2 and OFX (1.x SGML or 2.x XML). Each returns rows with date, description,
// reference, amount (deposits positive) plus opening/closing balances when the file has them.
// They read the common fields only; they are not full implementations of these standards.

import { extname } from 'node:path';
import { round2 } from 'mythos-agent-core';

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e] ?? m)).trim();
const tagRe = (t, flags = '') => new RegExp(`<(?:[\\w.-]+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${t}>`, flags);
const blocks = (xml, t) => [...xml.matchAll(tagRe(t, 'g'))].map((m) => m[1]);
const first = (xml, ...path) => { let cur = xml; for (const t of path) { const m = tagRe(t).exec(cur); if (!m) return ''; cur = m[1]; } return unxml(cur); };

/** ISO 20022 camt.053 bank-to-customer statement. Reads Stmt/Bal (OPBD, CLBD) and Stmt/Ntry. */
export function parseCamt053(xml) {
  if (!/BkToCstmrStmt/.test(xml)) throw new Error('not a camt.053 file (no BkToCstmrStmt element)');
  const stmts = blocks(xml, 'Stmt'); if (!stmts.length) throw new Error('camt.053: no Stmt element');
  const rows = []; let opening = null, closing = null, currency = '', account = '';
  for (const st of stmts) {
    account = account || first(st, 'Acct', 'IBAN') || first(st, 'Acct', 'Othr', 'Id');
    for (const b of blocks(st, 'Bal')) {
      const code = first(b, 'Tp', 'CdOrPrtry', 'Cd'); const amt = Number(first(b, 'Amt')); const sign = first(b, 'CdtDbtInd') === 'DBIT' ? -1 : 1;
      if (code === 'OPBD' && opening === null) opening = round2(sign * amt);
      if (code === 'CLBD') closing = round2(sign * amt);
    }
    for (const n of blocks(st, 'Ntry')) {
      const amtM = /<(?:[\w.-]+:)?Amt\b([^>]*)>([^<]*)</.exec(n);
      if (!amtM) throw new Error('camt.053: an Ntry has no Amt');
      currency = currency || (/Ccy="([A-Z]{3})"/.exec(amtM[1]) || [])[1] || '';
      const sign = first(n, 'CdtDbtInd') === 'DBIT' ? -1 : 1;
      const date = first(n, 'BookgDt', 'Dt') || first(n, 'BookgDt', 'DtTm').slice(0, 10) || first(n, 'ValDt', 'Dt');
      const reference = first(n, 'NtryRef') || first(n, 'NtryDtls', 'TxDtls', 'Refs', 'EndToEndId').replace(/^NOTPROVIDED$/, '');
      const description = first(n, 'AddtlNtryInf') || first(n, 'NtryDtls', 'TxDtls', 'RmtInf', 'Ustrd');
      rows.push({ date, description, reference, amount: round2(sign * Number(unxml(amtM[2]))) });
    }
  }
  return { format: 'camt053', account_hint: mask(account), currency, opening_balance: opening, closing_balance: closing, rows };
}

const yymmdd = (s) => (/^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : '');
/** BAI2 cash-management file. Amounts are in cents; type codes 100-399 are credits, 400-699 debits. */
export function parseBai2(text) {
  // Join 88 continuation records onto the record before, then split on record ends.
  const raw = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const recs = [];
  for (const l of raw) { if (l.startsWith('88,')) { if (!recs.length) throw new Error('BAI2: continuation record with nothing before it'); const prev = recs[recs.length - 1]; recs[recs.length - 1] = prev.replace(/\/$/, '') + (prev.startsWith('16,') ? ' ' : ',') + l.slice(3); } else recs.push(l); }
  if (!recs.length || !recs[0].startsWith('01,')) throw new Error('not a BAI2 file (first record is not 01)');
  const rows = []; let asOf = '', opening = null, closing = null, currency = '', account = '';
  for (const r of recs) {
    const code = r.slice(0, 2);
    if (code === '02') { const f = r.replace(/\/$/, '').split(','); asOf = yymmdd(f[4]); currency = currency || f[6] || ''; }
    else if (code === '03') {
      const f = r.replace(/\/$/, '').split(','); account = account || f[1]; currency = f[2] || currency;
      for (let i = 3; i + 1 < f.length; i += 4) { // type, amount, item count, funds type
        const tc = f[i], amt = f[i + 1];
        if (tc === '010' && amt !== '') opening = round2(Number(amt) / 100);
        if (tc === '015' && amt !== '') closing = round2(Number(amt) / 100);
        if (f[i + 3] === 'S') i += 3; else if (f[i + 3] === 'V') i += 2;
      }
    } else if (code === '16') {
      const body = r.replace(/\/$/, ''); const f = body.split(',');
      const tc = Number(f[1]); const cents = Number(f[2] || 0); let i = 4; let date = asOf;
      const funds = f[3];
      if (funds === 'S') i += 3; else if (funds === 'V') { date = yymmdd(f[4]) || asOf; i += 2; } else if (funds === 'D') { const n = Number(f[4] || 0); i += 1 + 2 * n; }
      const bankRef = f[i] || '', custRef = f[i + 1] || ''; const description = f.slice(i + 2).join(',').trim();
      if (!Number.isFinite(tc) || !Number.isFinite(cents)) throw new Error(`BAI2: bad 16 record "${r.slice(0, 40)}"`);
      const sign = tc >= 400 && tc < 700 ? -1 : 1;
      rows.push({ date, description, reference: custRef || '', bank_reference: bankRef, amount: round2(sign * cents / 100), type_code: String(f[1]) });
    }
  }
  return { format: 'bai2', account_hint: mask(account), currency, opening_balance: opening, closing_balance: closing, rows };
}

const ofxDate = (s) => (/^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');
/** OFX 1.x (SGML, leaf tags may be unclosed) or 2.x (XML) bank statement. */
export function parseOfx(text) {
  if (!/<OFX>/i.test(text)) throw new Error('not an OFX file (no <OFX> element)');
  const leaf = (s, t) => { const m = new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(s); return m ? unxml(m[1]) : ''; };
  const rows = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)) {
    const t = m[1]; const amt = Number(leaf(t, 'TRNAMT'));
    if (!Number.isFinite(amt)) throw new Error('OFX: a STMTTRN has no TRNAMT');
    rows.push({ date: ofxDate(leaf(t, 'DTPOSTED')), description: leaf(t, 'NAME') || leaf(t, 'MEMO'), reference: leaf(t, 'CHECKNUM') || leaf(t, 'REFNUM'), amount: round2(amt), fitid: leaf(t, 'FITID') });
  }
  const lb = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>)/i.exec(text);
  return { format: 'ofx', account_hint: mask(leaf(text, 'ACCTID')), currency: leaf(text, 'CURDEF'), opening_balance: null, closing_balance: lb && leaf(lb[1], 'BALAMT') !== '' ? round2(Number(leaf(lb[1], 'BALAMT'))) : null, rows };
}

/**
 * SWIFT MT940 customer statement (.sta, .mt940), as German and other European banks
 * send it. Reads :25: (account), :60F:/:60M: and :62F:/:62M: (balances), :61: (lines)
 * and the :86: text after each line, including the German structured form
 * (?20-?29 purpose, ?32-?33 name). Amounts use a decimal comma.
 */
export function parseMt940(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!/^:20:/m.test(t) || !/^:(?:60[FM]|61):/m.test(t)) throw new Error('not an MT940 file (no :20: and :60F:/:61: fields)');
  const fields = [];
  for (const line of t.split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1], value: m[2] });
    else if (fields.length && line.trim() && !/^[-{}]|^\$/.test(line.trim())) fields[fields.length - 1].value += '\n' + line;
  }
  const num = (s) => Number(String(s).replace(',', '.'));
  const bal = (v) => { const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.trim()); return m ? { amount: round2((m[1] === 'D' ? -1 : 1) * num(m[4])), currency: m[3] } : null; };
  const rows = []; let opening = null, closing = null, currency = '', account = '';
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.tag === '25') account = account || f.value.trim();
    else if (f.tag === '60F' || f.tag === '60M') { const b = bal(f.value); if (b && opening === null) { opening = b.amount; currency = currency || b.currency; } }
    else if (f.tag === '62F' || f.tag === '62M') { const b = bal(f.value); if (b) { closing = b.amount; currency = currency || b.currency; } }
    else if (f.tag === '61') {
      const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NSF][A-Z0-9]{3})([^\n]*)/.exec(f.value);
      if (!m) throw new Error(`MT940: bad :61: line "${f.value.slice(0, 40)}"`);
      // RC (reversal of a credit) takes money out; RD (reversal of a debit) puts it back.
      const sign = m[3] === 'D' || m[3] === 'RC' ? -1 : 1;
      const value = yymmdd(m[1]);
      let date = value;
      if (m[2] && value) { let y = Number(value.slice(0, 4)); const vm = Number(value.slice(5, 7)), em = Number(m[2].slice(0, 2)); if (em - vm > 6) y--; else if (vm - em > 6) y++; date = `${y}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`; }
      const [custRef = '', bankRef = ''] = m[7].split('//');
      const next = fields[i + 1];
      const info = mt86(next && next.tag === '86' ? next.value : '');
      rows.push({ date, value_date: value, description: info.text, reference: custRef.trim().replace(/^NONREF$/i, '') || info.eref, bank_reference: bankRef.trim(), amount: round2(sign * num(m[5])), type_code: m[6] });
    }
  }
  if (!rows.length && opening === null) throw new Error('MT940: no statement lines or balances');
  return { format: 'mt940', account_hint: mask(account), currency, opening_balance: opening, closing_balance: closing, rows };
}
/**
 * :86: text. The German structured form "166?00SEPA-UEBERWEISUNG?20...?32Name" becomes
 * "Name: purpose"; SEPA keys in the purpose (EREF+, SVWZ+...) are split out, so the
 * end-to-end reference (EREF+) can serve as the line's reference.
 */
function mt86(v) {
  const s = String(v || '').replace(/\n/g, '');
  if (!/^\d{3}\?/.test(s)) return { text: String(v || '').replace(/\s*\n\s*/g, ' ').trim(), eref: '' };
  const parts = {}; for (const m of s.matchAll(/\?(\d{2})([^?]*)/g)) parts[m[1]] = (parts[m[1]] || '') + m[2];
  let purpose = Object.keys(parts).filter((k) => (k >= '20' && k <= '29') || (k >= '60' && k <= '63')).sort().map((k) => parts[k]).join('').trim();
  const keys = {}; const SEPA = /(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|COAM|OAMT)\+/g;
  if (SEPA.test(purpose)) {
    const bits = purpose.split(/(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|COAM|OAMT)\+/);
    for (let i = 1; i + 1 < bits.length; i += 2) keys[bits[i]] = bits[i + 1].trim();
    purpose = keys.SVWZ || (bits[0] || '').trim();
  }
  const name = [parts['32'], parts['33']].filter(Boolean).join('').trim();
  const eref = keys.EREF && !/^NOTPROVIDED$/i.test(keys.EREF) ? keys.EREF : '';
  return { text: [name, purpose || parts['00'] || ''].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim(), eref };
}

/** Show only the last 4 characters of an account identifier. */
function mask(acct) { const s = String(acct || ''); return s ? (s.length > 4 ? '••••' + s.slice(-4) : '••••') : ''; }

export const BANK_FORMATS = ['csv', 'tsv', 'xlsx', 'json', 'camt053', 'mt940', 'bai2', 'ofx'];
/** Formats read as a table of rows (through the core reader and the export profiles). */
export const TABLE_FORMATS = ['csv', 'tsv', 'xlsx', 'json'];
/** Pick a format from the extension, then from the content. */
export function detectFormat(file, text) {
  const ext = extname(file).toLowerCase();
  if (ext === '.ofx' || ext === '.qfx') return 'ofx';
  if (ext === '.bai' || ext === '.bai2') return 'bai2';
  if (ext === '.sta' || ext === '.mt940' || ext === '.940') return 'mt940';
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv' || ext === '.tab') return 'tsv';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') return 'json';
  const head = String(text || '').slice(0, 4096);
  if (/BkToCstmrStmt|camt\.053/.test(head)) return 'camt053';
  if (/<OFX>|OFXHEADER/i.test(head)) return 'ofx';
  if (/^\s*01,/.test(head)) return 'bai2';
  if (/^:20:/m.test(head) && /^:(?:60[FM]|61):/m.test(head)) return 'mt940';
  return null;
}
export function parseBankText(format, text) {
  if (format === 'camt053') return parseCamt053(text);
  if (format === 'bai2') return parseBai2(text);
  if (format === 'mt940') return parseMt940(text);
  if (format === 'ofx') return parseOfx(text);
  throw new Error(`no text parser for ${format}`);
}
