import { createHash } from 'node:crypto';
import { toCsv, sha256 } from 'mythos-agent-core';

const PD = [
  ['email', /e-?mail/i], ['phone', /(phone|mobile|cell|tel)/i], ['name', /(^|_|\b)(first|last|full|given|family|sur)?_?name$|^name$|contact_?name|customer_?name/i],
  ['ip_address', /(^ip$|ip_?addr|ip_?address)/i], ['address', /(address|street|city|postal|zip|postcode)/i], ['date_of_birth', /(dob|birth)/i],
  ['government_id', /(ssn|passport|national_?id|tax_?id|driver)/i], ['payment', /(card|iban|account_?number|bank)/i], ['customer_id', /(customer_?id|user_?id|member_?id|contact_?id)/i],
];
const RETAIN = /(invoice|tax|vat|payroll|ledger|gl_|journal|order|payment|transaction|contract|legal|hold)/i;
const lower = (v) => String(v ?? '').trim().toLowerCase();
const digits = (v) => String(v ?? '').replace(/\D/g, '');
export const maskEmail = (e) => { const [u, d] = String(e).split('@'); return d ? `${u.slice(0, 1)}***@${d}` : '***'; };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const HEX = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

/**
 * Hashes of the subject's identifiers as they commonly appear in exports (ad audiences,
 * ESP subscriber hashes, warehouse pseudonymised columns): SHA-256 and MD5 of the
 * lower-cased email; SHA-256 of the phone as last 10 digits, all digits, +digits and
 * +1 plus 10 digits. Returns Map(hash -> label). The raw values never leave this function.
 */
export function identifierHashes(email, phoneDigits) {
  const m = new Map(); const e = lower(email); const all = digits(phoneDigits);
  if (e) { m.set(sha256(e), 'email_sha256'); m.set(md5(e), 'email_md5'); }
  if (all.length >= 7) {
    const last = all.slice(-10);
    for (const v of new Set([last, all, `+${all}`, last.length === 10 ? `+1${last}` : null].filter(Boolean))) m.set(sha256(v), 'phone_sha256');
  }
  return m;
}

/** Which columns in each file look like personal data. */
export function mapData(files) {
  return files.map(({ name, rows }) => {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const pd = cols.map((c) => { const hit = PD.find(([, re]) => re.test(c)); return hit ? { column: c, category: hit[0] } : null; }).filter(Boolean);
    return { file: name, rows: rows.length, columns: cols.length, personal_data_columns: pd, retention_flag: RETAIN.test(name) || cols.some((c) => RETAIN.test(c)) };
  });
}

/**
 * Find rows that match the data subject's identifiers. Identifiers are matched exactly after
 * normalising (email lower-case, phone last 10 digits), and also as hashed values (see
 * identifierHashes) so pseudonymised exports are covered. Matches report the column and the
 * kind of match, never the value.
 */
export function findSubject(files, subject) {
  const email = lower(subject.email); const phoneAll = digits(subject.phone); const phone = phoneAll.slice(-10); const ids = [].concat(subject.ids || subject.customer_id || []).map(lower).filter(Boolean);
  if (!email && !phone && !ids.length) throw new Error('give at least one identifier: email, phone or ids');
  const hashes = identifierHashes(email, phoneAll);
  const map = mapData(files);
  const hits = files.map(({ name, rows }, fi) => {
    const pdCols = map[fi].personal_data_columns;
    const matched = [];
    rows.forEach((r, i) => {
      const why = [];
      for (const [c, v] of Object.entries(r)) {
        if (email && lower(v) === email) why.push(`${c}=email`);
        else if (phone && phone.length >= 7 && digits(v).length >= 7 && digits(v).slice(-10) === phone) why.push(`${c}=phone`);
        else if (ids.length && ids.includes(lower(v)) && /id/i.test(c)) why.push(`${c}=id`);
        else if (hashes.size && HEX.test(lower(v)) && hashes.has(lower(v))) why.push(`${c}=${hashes.get(lower(v))}`);
      }
      if (why.length) matched.push({ row: i + 2, matched_on: why, personal_data_columns: pdCols.map((p) => p.column) });
    });
    return { file: name, rows_found: matched.length, matches: matched, retention_flag: map[fi].retention_flag };
  });
  const hashed = hits.reduce((t, h) => t + h.matches.filter((m) => m.matched_on.some((w) => /_(sha256|md5)$/.test(w))).length, 0);
  return { subject: { email: email ? maskEmail(email) : null, phone: phone ? `***${phone.slice(-4)}` : null, ids: ids.length }, files_scanned: files.length, files_with_data: hits.filter((h) => h.rows_found).length, rows_found: hits.reduce((t, h) => t + h.rows_found, 0), rows_matched_by_hash: hashed, files: hits, inventory: map };
}

export const DEFAULT_RESPONSE_DAYS = Object.freeze({ gdpr: 30, uk_gdpr: 30, ccpa: 45, cpra: 45 });
/** Response target: received + the configured period for the regime (your rules file overrides the defaults). */
export function dueDate(received, regime, periods = {}) {
  const d = Date.parse(received); const n = { ...DEFAULT_RESPONSE_DAYS, ...periods }[lower(regime)];
  if (!Number.isFinite(d) || !n) return null;
  return new Date(d + n * 86400000).toISOString().slice(0, 10);
}

export const CHECKLIST_COLUMNS = ['step', 'system_or_file', 'rows_found', 'personal_data_columns', 'action', 'retention_check', 'owner', 'done_by', 'done_date', 'evidence'];
export function checklist(found, req = {}, retention = null) {
  const periods = req.periods || {}; const due = dueDate(req.received, req.regime, periods);
  const ret = new Map(); for (const f of retention?.files || []) ret.set(f.file, f);
  const steps = [
    { step: 1, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: 'Verify the requester\'s identity using your documented method before acting.', retention_check: '' },
    { step: 2, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: `Log the request${req.received ? ` received ${req.received}` : ''}${due ? `; response target ${due} (${req.regime}; confirm the deadline that applies to you)` : ''}.`, retention_check: '' },
  ];
  let n = 3;
  for (const f of found.files.filter((x) => x.rows_found)) {
    const r = ret.get(f.file);
    const base = { step: n++, system_or_file: f.file, rows_found: f.rows_found, personal_data_columns: [...new Set(f.matches.flatMap((m) => m.personal_data_columns))].join('; ') };
    if (r && r.rules_cited.length) steps.push({ ...base, action: r.on_hold ? 'On hold: do not delete these rows while the hold applies.' : r.retain ? 'Keep the rows your rule retains; delete or anonymise only rows whose period has ended.' : 'Your retention period has ended for these rows; delete or anonymise per your rule.', retention_check: r.text });
    else steps.push({ ...base, action: f.retention_flag ? 'Check retention duty first; delete or anonymise only what you may.' : 'Delete or anonymise the matched rows in the source system.', retention_check: f.retention_flag ? 'likely required (financial/legal records)' : 'none flagged' });
  }
  steps.push({ step: n++, system_or_file: '(processors)', rows_found: '', personal_data_columns: '', action: 'Ask processors and vendors holding copies (email tool, CRM, support desk, backups) to erase, per your contracts.', retention_check: '' });
  steps.push({ step: n, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: 'Confirm completion to the requester and keep a minimal record that the request was handled.', retention_check: '' });
  return steps.map((s) => ({ ...s, owner: '', done_by: '', done_date: '', evidence: '' }));
}
export const checklistCsv = (steps) => toCsv(steps, CHECKLIST_COLUMNS);
export function requestMarkdown(found, req, at) {
  const due = dueDate(req.received, req.regime, req.periods || {});
  const L = ['# Erasure request worksheet', '', `Generated ${at} by macaria-of-erasure. Identifiers are masked in this file.`, '',
    `- Subject: ${[found.subject.email, found.subject.phone, found.subject.ids ? `${found.subject.ids} id(s)` : null].filter(Boolean).join(', ')}`,
    `- Received: ${req.received || 'not given'}${due ? ` · target ${due} (${req.regime})` : ''}`,
    `- Found in ${found.files_with_data} of ${found.files_scanned} file(s), ${found.rows_found} row(s)`, '', '| File | Rows | Retention check |', '|---|---:|---|'];
  for (const f of found.files) L.push(`| ${f.file} | ${f.rows_found} | ${f.retention_flag ? 'check before deleting' : '-'} |`);
  L.push('', 'This maps only the exports you gave it. Systems you did not export are not covered. Not legal advice: confirm your obligations and exemptions.', '');
  return L.join('\n');
}
