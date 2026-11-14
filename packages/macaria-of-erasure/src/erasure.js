import { toCsv } from 'mythos-agent-core';

const PD = [
  ['email', /e-?mail/i], ['phone', /(phone|mobile|cell|tel)/i], ['name', /(^|_|\b)(first|last|full|given|family|sur)?_?name$|^name$|contact_?name|customer_?name/i],
  ['ip_address', /(^ip$|ip_?addr|ip_?address)/i], ['address', /(address|street|city|postal|zip|postcode)/i], ['date_of_birth', /(dob|birth)/i],
  ['government_id', /(ssn|passport|national_?id|tax_?id|driver)/i], ['payment', /(card|iban|account_?number|bank)/i], ['customer_id', /(customer_?id|user_?id|member_?id|contact_?id)/i],
];
const RETAIN = /(invoice|tax|vat|payroll|ledger|gl_|journal|order|payment|transaction|contract|legal|hold)/i;
const lower = (v) => String(v ?? '').trim().toLowerCase();
const digits = (v) => String(v ?? '').replace(/\D/g, '');
export const maskEmail = (e) => { const [u, d] = String(e).split('@'); return d ? `${u.slice(0, 1)}***@${d}` : '***'; };

/** Which columns in each file look like personal data. */
export function mapData(files) {
  return files.map(({ name, rows }) => {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const pd = cols.map((c) => { const hit = PD.find(([, re]) => re.test(c)); return hit ? { column: c, category: hit[0] } : null; }).filter(Boolean);
    return { file: name, rows: rows.length, columns: cols.length, personal_data_columns: pd, retention_flag: RETAIN.test(name) || cols.some((c) => RETAIN.test(c)) };
  });
}

/** Find rows that match the data subject's identifiers. Identifiers are matched exactly after normalising (email lower-case, phone last 10 digits). */
export function findSubject(files, subject) {
  const email = lower(subject.email); const phone = digits(subject.phone).slice(-10); const ids = [].concat(subject.ids || subject.customer_id || []).map(lower).filter(Boolean);
  if (!email && !phone && !ids.length) throw new Error('give at least one identifier: email, phone or ids');
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
      }
      if (why.length) matched.push({ row: i + 2, matched_on: why, personal_data_columns: pdCols.map((p) => p.column) });
    });
    return { file: name, rows_found: matched.length, matches: matched, retention_flag: map[fi].retention_flag };
  });
  return { subject: { email: email ? maskEmail(email) : null, phone: phone ? `***${phone.slice(-4)}` : null, ids: ids.length }, files_scanned: files.length, files_with_data: hits.filter((h) => h.rows_found).length, rows_found: hits.reduce((t, h) => t + h.rows_found, 0), files: hits, inventory: map };
}

const DAYS = { gdpr: 30, uk_gdpr: 30, ccpa: 45, cpra: 45 };
export function dueDate(received, regime) {
  const d = Date.parse(received); const n = DAYS[lower(regime)];
  if (!Number.isFinite(d) || !n) return null;
  return new Date(d + n * 86400000).toISOString().slice(0, 10);
}

export const CHECKLIST_COLUMNS = ['step', 'system_or_file', 'rows_found', 'personal_data_columns', 'action', 'retention_check', 'owner', 'done_by', 'done_date', 'evidence'];
export function checklist(found, req = {}) {
  const steps = [
    { step: 1, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: 'Verify the requester\'s identity using your documented method before acting.', retention_check: '' },
    { step: 2, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: `Log the request${req.received ? ` received ${req.received}` : ''}${dueDate(req.received, req.regime) ? `; response target ${dueDate(req.received, req.regime)} (${req.regime}; confirm the deadline that applies to you)` : ''}.`, retention_check: '' },
  ];
  let n = 3;
  for (const f of found.files.filter((x) => x.rows_found)) {
    steps.push({ step: n++, system_or_file: f.file, rows_found: f.rows_found, personal_data_columns: [...new Set(f.matches.flatMap((m) => m.personal_data_columns))].join('; '), action: f.retention_flag ? 'Check retention duty first; delete or anonymise only what you may.' : 'Delete or anonymise the matched rows in the source system.', retention_check: f.retention_flag ? 'likely required (financial/legal records)' : 'none flagged' });
  }
  steps.push({ step: n++, system_or_file: '(processors)', rows_found: '', personal_data_columns: '', action: 'Ask processors and vendors holding copies (email tool, CRM, support desk, backups) to erase, per your contracts.', retention_check: '' });
  steps.push({ step: n, system_or_file: '(request)', rows_found: '', personal_data_columns: '', action: 'Confirm completion to the requester and keep a minimal record that the request was handled.', retention_check: '' });
  return steps.map((s) => ({ ...s, owner: '', done_by: '', done_date: '', evidence: '' }));
}
export const checklistCsv = (steps) => toCsv(steps, CHECKLIST_COLUMNS);
export function requestMarkdown(found, req, at) {
  const L = ['# Erasure request worksheet', '', `Generated ${at} by macaria-of-erasure. Identifiers are masked in this file.`, '',
    `- Subject: ${[found.subject.email, found.subject.phone, found.subject.ids ? `${found.subject.ids} id(s)` : null].filter(Boolean).join(', ')}`,
    `- Received: ${req.received || 'not given'}${dueDate(req.received, req.regime) ? ` · target ${dueDate(req.received, req.regime)} (${req.regime})` : ''}`,
    `- Found in ${found.files_with_data} of ${found.files_scanned} file(s), ${found.rows_found} row(s)`, '', '| File | Rows | Retention check |', '|---|---:|---|'];
  for (const f of found.files) L.push(`| ${f.file} | ${f.rows_found} | ${f.retention_flag ? 'check before deleting' : '-'} |`);
  L.push('', 'This maps only the exports you gave it. Systems you did not export are not covered. Not legal advice: confirm your obligations and exemptions.', '');
  return L.join('\n');
}
