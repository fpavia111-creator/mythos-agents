// 0.2.0 features: budget-vs-actual variance by line with explanation markers,
// spend-down projection, funder template mapping, deadline calendar and evidence
// packs. Deterministic, offline, files under --root only.
import { round2, toCsv, toIcs, sha256 } from 'mythos-agent-core';
import { pick, parseDate, asOfMs } from './grants.js';

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const pctTxt = (p) => (p === null ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(Math.round(p * 1000) / 10)}%`);

export const VARIANCE_DEFAULTS = Object.freeze({ variance_pct: 0.10, variance_amount: 0, underspend_pct: 0.10 });
const vopts = (a = {}) => {
  const o = { ...VARIANCE_DEFAULTS };
  for (const k of Object.keys(o)) if (a[k] !== undefined && a[k] !== null && Number.isFinite(Number(a[k]))) o[k] = Number(a[k]);
  return o;
};

/**
 * Budget-vs-actual variance per line. Basis: the full budget for final reports or
 * once the period has ended; otherwise the share of the budget expected by now
 * (budget × time elapsed). A line whose variance exceeds BOTH thresholds (percent
 * of basis and absolute amount) needs an explanation. An `explanation` column in
 * the budget file is carried through but still marked for a person to check.
 */
export function varianceReview(g, lines, a = {}) {
  const o = vopts(a); const now = asOfMs(a.as_of);
  const s = parseDate(g.period_start), e = parseDate(g.period_end);
  const elapsed = s !== null && e !== null && e > s ? Math.min(1, Math.max(0, (now - s) / (e - s))) : null;
  const finalBasis = /final/i.test(g.report_type || '') || elapsed === 1 || elapsed === null;
  const basisName = finalBasis ? 'budget' : 'expected_by_now';
  const rows = lines.map((l) => {
    const budgeted = Number(pick(l, 'budgeted', 'budget', 'approved').replace(/[^0-9.-]/g, '')) || 0;
    const spent = Number(pick(l, 'spent', 'actual', 'expended').replace(/[^0-9.-]/g, '')) || 0;
    const basis = finalBasis ? budgeted : round2(budgeted * elapsed);
    const variance = round2(spent - basis);
    const pct = basis ? variance / basis : spent ? 1 : null;
    const over = (pct === null ? false : Math.abs(pct) > o.variance_pct) && Math.abs(variance) >= o.variance_amount && Math.abs(variance) > 0.005;
    const projected = elapsed && elapsed > 0 && !finalBasis ? round2(spent / elapsed) : spent;
    const explanation = pick(l, 'explanation', 'variance_explanation', 'note');
    return { line: pick(l, 'line', 'category', 'budget_line'), budgeted, spent, basis, variance, variance_pct: pct === null ? null : Math.round(pct * 10000) / 10000, direction: variance > 0 ? 'over' : variance < 0 ? 'under' : 'on', explanation_required: over, explanation, marker: over ? `[EXPLAIN VARIANCE — ${signed(variance)} (${pctTxt(pct)}) vs ${basisName.replace(/_/g, ' ')}${explanation ? '; explanation given, check it' : ''}]` : '', projected_at_end: projected };
  });
  const budget = round2(rows.reduce((t, r) => t + r.budgeted, 0)); const spent = round2(rows.reduce((t, r) => t + r.spent, 0));
  const projected = round2(rows.reduce((t, r) => t + r.projected_at_end, 0));
  const award = g.award_amount || budget;
  const flags = [];
  if (!finalBasis && elapsed && award) {
    if (projected < award * (1 - o.underspend_pct)) flags.push('projected_underspend');
    if (projected > award * (1 + o.underspend_pct)) flags.push('projected_overspend');
  }
  return { grant_id: g.grant_id, basis: basisName, elapsed_pct: elapsed, thresholds: o, lines: rows, total_budgeted: budget, total_spent: spent, projected_at_end: projected, projected_vs_award: round2(projected - award), lines_needing_explanation: rows.filter((r) => r.explanation_required).length, flags };
}

export const VARIANCE_COLUMNS = ['grant_id', 'line', 'budgeted', 'spent', 'basis', 'variance', 'variance_pct', 'explanation_required', 'explanation', 'projected_at_end', 'reviewed_by'];
export const varianceCsv = (list) => toCsv(list.flatMap((v) => v.lines.map((l) => ({ grant_id: v.grant_id, ...l, variance_pct: l.variance_pct === null ? '' : (Math.round(l.variance_pct * 1000) / 10).toFixed(1), explanation_required: l.explanation_required ? 'yes' : 'no', reviewed_by: '' }))), VARIANCE_COLUMNS);

export function varianceMarkdown(v) {
  const L = [`Variance basis: ${v.basis === 'budget' ? 'full budget' : `budget × ${Math.round((v.elapsed_pct || 0) * 100)}% of the period elapsed`}. Threshold: more than ${Math.round(v.thresholds.variance_pct * 100)}%${v.thresholds.variance_amount ? ` and at least ${money(v.thresholds.variance_amount)}` : ''}.`, '',
    '| Line | Budgeted | Basis | Spent | Variance | % | Explanation |', '|---|---:|---:|---:|---:|---:|---|'];
  for (const l of v.lines) L.push(`| ${l.line} | ${money(l.budgeted)} | ${money(l.basis)} | ${money(l.spent)} | ${signed(l.variance)} | ${pctTxt(l.variance_pct)} | ${l.explanation_required ? `${l.explanation ? `${l.explanation} ` : ''}${l.marker}` : ''} |`);
  if (v.basis !== 'budget') L.push('', `Spend-down projection at the current pace: ${money(v.projected_at_end)} by period end (${signed(v.projected_vs_award)} vs award).${v.flags.length ? ` [CHECK — ${v.flags.join(', ').replace(/_/g, ' ')}]` : ''}`);
  return L.join('\n');
}

// ---- Funder templates -----------------------------------------------------------
export const SECTION_SOURCES = ['narrative', 'summary', 'budget', 'variance', 'outcomes', 'evidence', 'deadlines', 'custom'];

/** Which template sections the data can fill and which are missing for one grant. */
export function templateCheck(t, g, v, exists = () => false) {
  const gaps = []; const sections = [];
  if (t.applies_to_funders && t.applies_to_funders.length && !t.applies_to_funders.includes(g.funder)) gaps.push({ section: '-', issue: 'template_funder_mismatch', detail: `Template "${t.name}" lists funders ${t.applies_to_funders.join(', ')}, not ${g.funder}.` });
  for (const s of t.sections) {
    let state = 'filled'; let detail = '';
    if (['narrative', 'custom'].includes(s.source)) { state = 'to_write'; detail = 'A person writes this section.'; }
    else if (s.source === 'budget' && !g.budget.lines.length) { state = 'missing'; detail = 'No budget lines for this grant.'; }
    else if (s.source === 'variance' && !v.lines.length) { state = 'missing'; detail = 'No budget lines, so no variance table.'; }
    else if (s.source === 'variance' && v.lines_needing_explanation) { state = 'needs_explanation'; detail = `${v.lines_needing_explanation} line(s) over the variance threshold.`; }
    else if (s.source === 'outcomes' && !g.outcomes.length) { state = 'missing'; detail = 'No outcomes for this grant.'; }
    else if (s.source === 'evidence' && !g.outcomes.some((o) => o.evidence && !o.flags.includes('evidence_not_found'))) { state = 'missing'; detail = 'No evidence files found.'; }
    sections.push({ id: s.id, title: s.title, source: s.source, required: s.required !== false, state, detail, max_words: s.max_words || null });
    if (s.required !== false && state === 'missing') gaps.push({ section: s.id, issue: 'template_section_missing', detail: `Required section "${s.title}": ${detail}` });
  }
  for (const att of t.required_attachments || []) {
    const ok = exists(att.file);
    if (!ok) gaps.push({ section: att.id, issue: 'attachment_missing', detail: `Required attachment "${att.title}" not found (${att.file}).` });
  }
  if (t.variance_threshold_pct !== undefined && v.lines_needing_explanation) gaps.push({ section: 'variance', issue: 'variance_explanations_needed', detail: `${v.lines_needing_explanation} budget line(s) over the funder's ${Math.round(t.variance_threshold_pct * 100)}% variance threshold need an explanation.` });
  return { template: t.name, funder: g.funder, grant_id: g.grant_id, sections, gaps, ready_sections: sections.filter((s) => s.state === 'filled').length };
}

/** report-draft.md following the template's section order. */
export function templatedDraft(t, g, v, tc, budgetTable, outcomeTable) {
  const L = [`# ${t.title || t.name} — ${g.program}`, '', `> **DRAFT packet — not submitted.** A person completes, checks and submits this in ${g.funder}'s own process. Section order follows the template "${t.name}".`, '',
    `- Funder: ${g.funder}`, `- Grant: ${g.grant_id} · award ${money(g.award_amount)}`, `- Period: ${g.period_start} to ${g.period_end}`, `- Report due: ${g.report_due || '—'}`, ''];
  for (const s of t.sections) {
    const st = tc.sections.find((x) => x.id === s.id);
    L.push(`## ${s.title}`, '');
    if (s.guidance) L.push(`_Funder guidance: ${s.guidance}_`, '');
    if (st.state === 'missing') { L.push(`[MISSING SECTION — ${st.detail}]`, ''); continue; }
    if (s.source === 'narrative' || s.source === 'custom') L.push(`[TO WRITE — a person writes this${s.max_words ? ` (max ${s.max_words} words)` : ''}. Polyhymnia does not write claims about your program.]`);
    else if (s.source === 'summary') L.push(`Award ${money(g.award_amount)}; spent ${money(g.budget.total_spent)} of ${money(g.budget.total_budgeted)} budgeted; ${g.outcomes.length} outcome measure(s).`);
    else if (s.source === 'budget') L.push(budgetTable);
    else if (s.source === 'variance') L.push(varianceMarkdown(v));
    else if (s.source === 'outcomes') L.push(outcomeTable);
    else if (s.source === 'evidence') for (const o of g.outcomes) L.push(`- ${o.ref} ${o.metric}: ${o.evidence && !o.flags.includes('evidence_not_found') ? o.evidence : '[MISSING EVIDENCE]'}`);
    else if (s.source === 'deadlines') L.push(`Report due ${g.report_due || '—'} (${g.status.replace(/_/g, ' ')}).`);
    L.push('');
  }
  if ((t.required_attachments || []).length) { L.push('## Attachments', ''); for (const a of t.required_attachments) L.push(`- ${a.title}: ${tc.gaps.some((x) => x.section === a.id) ? `[MISSING ATTACHMENT — ${a.file}]` : a.file}`); L.push(''); }
  L.push('## Open items before submission', '', ...([...g.gaps, ...tc.gaps.map((x) => x.detail)].length ? [...g.gaps, ...tc.gaps.map((x) => x.detail)].map((x) => `- ${x}`) : ['- None found by the checks. A person still reviews everything.']), '');
  return L.join('\n');
}

// ---- Calendar -------------------------------------------------------------------
export function deadlineIcs(items, { as_of, reminders = [30, 14, 7, 1], includePeriodEnd = true } = {}) {
  const ev = [];
  for (const g of items) {
    if (g.status === 'submitted') continue;
    if (g.report_due) ev.push({ uid: `${g.grant_id.toLowerCase()}-report@polyhymnia-of-grants`, date: g.report_due, summary: `${g.report_type} report due: ${g.funder} — ${g.program}`, description: `Grant ${g.grant_id}. Draft packet first; submitting is a person's click in the funder's process.`, reminders, categories: ['grant-report'] });
    if (includePeriodEnd && g.period_end && g.period_end >= as_of) ev.push({ uid: `${g.grant_id.toLowerCase()}-period-end@polyhymnia-of-grants`, date: g.period_end, summary: `Grant period ends: ${g.funder} — ${g.program}`, description: `Grant ${g.grant_id}. Check spend-down and outcomes before the period closes.`, reminders, categories: ['grant-period'] });
  }
  return toIcs(ev, { prodId: '-//Mythos Machine//polyhymnia-of-grants//EN', calName: 'Grant deadlines', stamp: as_of.replace(/-/g, '') + 'T000000Z' });
}

// ---- Evidence pack ----------------------------------------------------------------
/** manifest.json listing every file with its sha256 and size, plus the zip entries. */
export function evidenceManifest(g, files, { as_of }) {
  return { grant_id: g.grant_id, funder: g.funder, program: g.program, as_of, note: 'Draft evidence pack assembled from your files. Not submitted; a person reviews it.', files: Object.entries(files).map(([name, buf]) => ({ name, bytes: Buffer.byteLength(buf), sha256: sha256(buf) })) };
}
