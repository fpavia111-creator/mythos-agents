import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toNumber, round2, toCsv } from 'mythos-agent-core';

const DAY = 86400000;
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const money = (n) => round2(Number(n) || 0);

/** Mask anything that looks like a card or account number (12–19 digits) in free text. */
export const maskNumbers = (s) => String(s || '').replace(/\b\d(?:[ -]?\d){11,18}\b/g, (m) => `•••• ${m.replace(/\D/g, '').slice(-4)}`);

/** Read amounts and ISO or US dates from receipt text. The text itself is never returned. */
export function readReceipt(text) {
  const t = String(text);
  const amounts = [...t.matchAll(/\b(?:total|amount|paid|balance)[^\d\n]{0,20}\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/gi)].map((m) => toNumber(m[1]));
  const dates = [...t.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => parseDate(m[1]))
    .concat([...t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)].map((m) => Date.UTC(+m[3], +m[1] - 1, +m[2])));
  return { amounts: amounts.filter((n) => n !== null), dates };
}

export function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new Error('policy must be a JSON object');
  if (!p.source) throw new Error('policy.source is required: name the written policy and version these rules come from');
  return p;
}
const sec = (p, k) => (p.sections && p.sections[k]) || k;

/**
 * Review expense lines against the written policy. Recommendations only.
 * Line decisions: approve, approve_capped, needs_info, reject.
 */
export function review(lines, policy, a = {}) {
  const p = validatePolicy(policy); const cur = (p.currency || 'USD').toUpperCase();
  const receiptsDir = a.receiptsDir; const seen = new Map(); const receiptUse = new Map();
  const items = lines.map((l, i) => {
    const line = {
      report_id: pick(l, 'report_id', 'report'), line_id: pick(l, 'line_id', 'line', 'id') || `L${i + 1}`, employee: pick(l, 'employee', 'employee_name', 'submitter'),
      date: pick(l, 'date', 'expense_date', 'spent_on'), submitted_on: pick(l, 'submitted_on', 'submitted', 'report_date'),
      category: pick(l, 'category', 'type').toLowerCase(), merchant: pick(l, 'merchant', 'vendor'), amount: money(toNumber(pick(l, 'amount', 'total'))),
      currency: (pick(l, 'currency') || cur).toUpperCase(), receipt: pick(l, 'receipt', 'receipt_file'), purpose: maskNumbers(pick(l, 'purpose', 'business_purpose', 'description')),
      attendees: Number(pick(l, 'attendees')) || 0, nights: Number(pick(l, 'nights')) || 0, miles: toNumber(pick(l, 'miles')) || 0, preapproved_by: pick(l, 'preapproved_by', 'pre_approval'),
    };
    const f = []; const add = (check, decision, section, detail) => f.push({ check, decision, policy_section: section, detail });
    const rule = (p.categories || {})[line.category];
    if ((p.disallowed || []).some((d) => d.category === line.category)) {
      const d = p.disallowed.find((x) => x.category === line.category); add('disallowed_category', 'reject', d.section || sec(p, 'disallowed'), `${line.category} is not reimbursable${d.note ? ` (${d.note})` : ''}.`);
    } else if (!rule && p.categories) add('unknown_category', 'needs_info', sec(p, 'categories'), `Category "${line.category}" is not in the policy.`);
    if (line.currency !== cur) add('currency_review', 'needs_info', sec(p, 'currency'), `Claimed in ${line.currency}; the policy pays in ${cur}. Confirm the converted amount.`);
    if (!line.purpose) add('missing_purpose', 'needs_info', sec(p, 'purpose'), 'No business purpose given.');
    let allowed = line.amount;
    if (rule) {
      const per = rule.per || 'item';
      const units = per === 'person' ? (line.attendees || 1) : per === 'night' ? (line.nights || 1) : 1;
      if (per === 'person' && rule.attendees_required && !line.attendees) add('attendees_missing', 'needs_info', rule.section, 'Meals need the number of attendees (and who they were).');
      if (rule.limit !== undefined && line.amount > rule.limit * units + 0.005) {
        allowed = money(rule.limit * units);
        add('over_limit', 'approve_capped', rule.section, `${line.amount.toFixed(2)} is over the ${rule.limit.toFixed(2)} per ${per} limit${units > 1 ? ` × ${units}` : ''}; reimbursable up to ${allowed.toFixed(2)}.`);
      }
      if (rule.rate_per_mile !== undefined) {
        const exp = money(line.miles * rule.rate_per_mile);
        if (!line.miles) add('miles_missing', 'needs_info', rule.section, 'Mileage claimed with no miles.');
        else if (Math.abs(exp - line.amount) > 0.01) { allowed = Math.min(allowed, exp); add('mileage_mismatch', line.amount > exp ? 'approve_capped' : 'needs_info', rule.section, `${line.miles} mi × ${rule.rate_per_mile} = ${exp.toFixed(2)}, claimed ${line.amount.toFixed(2)}.`); }
      }
    }
    if (p.preapproval_over !== undefined && line.amount > p.preapproval_over && !line.preapproved_by) add('preapproval_missing', 'needs_info', sec(p, 'preapproval'), `Over ${Number(p.preapproval_over).toFixed(2)} with no pre-approval recorded.`);
    const needsReceipt = p.receipt_required_over !== undefined && line.amount > p.receipt_required_over && !(rule && rule.receipt_exempt);
    if (!line.receipt) { if (needsReceipt) add('missing_receipt', 'needs_info', sec(p, 'receipts'), `Over ${Number(p.receipt_required_over).toFixed(2)} with no receipt.`); }
    else if (receiptsDir) {
      const rf = join(receiptsDir, line.receipt);
      if (!/^[\w.\- ]+$/.test(line.receipt) || !existsSync(rf)) add('receipt_not_found', 'needs_info', sec(p, 'receipts'), `Receipt "${line.receipt}" is not in the receipts folder.`);
      else if (/\.(txt|md|text)$/i.test(rf)) {
        const r = readReceipt(readFileSync(rf, 'utf8'));
        if (r.amounts.length && !r.amounts.some((x) => Math.abs(x - line.amount) <= 0.01)) add('receipt_amount_mismatch', 'needs_info', sec(p, 'receipts'), `Receipt total ${r.amounts.map((x) => x.toFixed(2)).join(' / ')} does not match ${line.amount.toFixed(2)}.`);
        const d = parseDate(line.date);
        if (d !== null && r.dates.length && !r.dates.includes(d)) add('receipt_date_mismatch', 'needs_info', sec(p, 'receipts'), `Receipt date ${r.dates.map(iso).join(' / ')} does not match ${line.date}.`);
      }
    }
    const d = parseDate(line.date); const s = parseDate(line.submitted_on);
    if (p.submit_within_days !== undefined && d !== null && s !== null && (s - d) / DAY > p.submit_within_days) add('late_submission', p.late_decision || 'needs_info', sec(p, 'submission'), `Submitted ${Math.round((s - d) / DAY)} days after the expense (policy: ${p.submit_within_days}).`);
    const key = [line.employee.toLowerCase(), line.merchant.toLowerCase(), line.amount, line.date].join('|');
    if (seen.has(key)) add('possible_duplicate', 'needs_info', sec(p, 'duplicates'), `Same employee, merchant, amount and date as ${seen.get(key).report_id}/${seen.get(key).line_id}. Possible duplicate, not a finding of wrongdoing.`); else seen.set(key, line);
    return { ...line, allowed, findings: f };
  });
  for (const l of items) if (l.receipt) { const k = l.receipt.toLowerCase(); receiptUse.set(k, [...(receiptUse.get(k) || []), l]); }
  for (const [, ls] of receiptUse) if (ls.length > 1) for (const l of ls.slice(1)) l.findings.push({ check: 'receipt_reused', decision: 'needs_info', policy_section: sec(p, 'duplicates'), detail: `Receipt also attached to ${ls[0].report_id}/${ls[0].line_id}.` });
  const rank = { approve: 0, approve_capped: 1, needs_info: 2, reject: 3 };
  for (const l of items) {
    l.decision = l.findings.reduce((d, x) => (rank[x.decision] > rank[d] ? x.decision : d), 'approve');
    l.recommended = l.decision === 'approve' || l.decision === 'approve_capped' ? l.allowed : 0;
  }
  const reports = [...new Set(items.map((l) => l.report_id))].map((id) => {
    const ls = items.filter((l) => l.report_id === id);
    const any = (d) => ls.some((l) => l.decision === d);
    const recommendation = any('needs_info') ? 'needs_info' : ls.every((l) => l.decision === 'reject') ? 'reject' : any('reject') || any('approve_capped') ? 'approve_with_changes' : 'approve';
    return { report_id: id, employee: ls[0].employee, lines: ls.length, claimed: money(ls.reduce((s, l) => s + l.amount, 0)), recommended: recommendation === 'needs_info' || recommendation === 'reject' ? 0 : money(ls.reduce((s, l) => s + l.recommended, 0)), recommendation, findings: ls.flatMap((l) => l.findings.map((f) => `${l.line_id}: ${f.check}`)) };
  });
  const count = (k) => reports.filter((r) => r.recommendation === k).length;
  return {
    policy_source: p.source, currency: cur, reports: reports.length, lines: items.length, approve: count('approve'), approve_with_changes: count('approve_with_changes'), needs_info: count('needs_info'), reject: count('reject'),
    claimed: money(reports.reduce((s, r) => s + r.claimed, 0)), recommended: money(reports.reduce((s, r) => s + r.recommended, 0)),
    report_summaries: reports, items,
    note: 'Recommendations against your written policy, for a person to decide. Not fraud detection, and not tax or legal advice. Receipt text is read for totals and dates only and never returned.',
  };
}

export const FINDING_COLUMNS = ['report_id', 'line_id', 'employee', 'date', 'category', 'merchant', 'amount', 'allowed', 'decision', 'check', 'policy_section', 'detail', 'reviewer', 'reviewer_decision'];
export function findingsCsv(r) {
  const rows = [];
  for (const l of r.items) {
    if (!l.findings.length) rows.push({ ...l, check: '', policy_section: '', detail: '', reviewer: '', reviewer_decision: '' });
    for (const f of l.findings) rows.push({ ...l, ...f, decision: l.decision, reviewer: '', reviewer_decision: '' });
  }
  return toCsv(rows, FINDING_COLUMNS);
}
export function reviewMarkdown(r) {
  const L = [`# Expense review`, '', `Policy: ${r.policy_source}`, '', `${r.reports} report(s), ${r.lines} line(s). Claimed ${r.claimed.toFixed(2)} ${r.currency}; recommended to reimburse ${r.recommended.toFixed(2)} ${r.currency}.`, '', `> ${r.note}`, '', '| Report | Employee | Claimed | Recommended | Recommendation |', '|---|---|---|---|---|'];
  for (const s of r.report_summaries) L.push(`| ${s.report_id} | ${s.employee} | ${s.claimed.toFixed(2)} | ${s.recommended.toFixed(2)} | ${s.recommendation} |`);
  L.push('', '## Findings', '');
  for (const l of r.items) for (const f of l.findings) L.push(`- ${l.report_id}/${l.line_id} **${f.check}** (${f.policy_section}): ${f.detail}`);
  return L.join('\n') + '\n';
}
export const BATCH_COLUMNS = ['report_id', 'employee', 'amount', 'currency', 'recommendation', 'status'];
export function batchCsv(r) {
  return toCsv(r.report_summaries.filter((s) => s.recommended > 0).map((s) => ({ ...s, amount: s.recommended.toFixed(2), currency: r.currency, status: 'staged - not paid' })), BATCH_COLUMNS);
}
