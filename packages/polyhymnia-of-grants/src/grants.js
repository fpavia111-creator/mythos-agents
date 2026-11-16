import { toNumber, round2, toCsv, sha256 } from 'mythos-agent-core';

const DAY = 86400000;
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
export function asOfMs(as_of) {
  if (as_of) { const t = parseDate(as_of); if (t === null) throw new Error(`as_of must be YYYY-MM-DD, got "${as_of}"`); return t; }
  const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const iso = (t) => (t === null ? '' : new Date(t).toISOString().slice(0, 10));
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n === null ? '—' : `${Math.round(n * 100)}%`);

export function deadlineStatus(days, submitted, soon = 30) {
  if (submitted) return 'submitted';
  if (days === null) return 'no_due_date';
  if (days < 0) return 'overdue';
  if (days <= soon) return 'due_soon';
  if (days <= 90) return 'upcoming';
  return 'later';
}

export function deadlines(grants, a = {}) {
  const now = asOfMs(a.as_of); const soon = Number(a.due_soon_days) || 30;
  const R = { overdue: 0, due_soon: 1, no_due_date: 2, upcoming: 3, later: 4, submitted: 5 };
  return grants.map((g, i) => {
    const due = parseDate(pick(g, 'report_due', 'due', 'due_date', 'deadline'));
    const days = due === null ? null : Math.round((due - now) / DAY);
    const submitted = /^(submitted|filed|done|yes)$/i.test(pick(g, 'status', 'submitted'));
    return { grant_id: pick(g, 'grant_id', 'id') || `G${i + 1}`, funder: pick(g, 'funder', 'funder_name'), program: pick(g, 'program', 'project', 'title'), award_amount: toNumber(pick(g, 'award_amount', 'award', 'amount')) || 0, period_start: iso(parseDate(pick(g, 'period_start', 'start'))), period_end: iso(parseDate(pick(g, 'period_end', 'end'))), report_type: pick(g, 'report_type', 'type') || 'report', report_due: iso(due), days_to_due: days, status: deadlineStatus(days, submitted, soon) };
  }).sort((x, y) => R[x.status] - R[y.status] || (x.days_to_due ?? 1e9) - (y.days_to_due ?? 1e9));
}

export function budgetReview(g, lines, a = {}) {
  const now = asOfMs(a.as_of); const tol = Number.isFinite(Number(a.pace_tolerance)) && a.pace_tolerance !== undefined ? Number(a.pace_tolerance) : 0.25;
  const s = parseDate(g.period_start), e = parseDate(g.period_end);
  const elapsed = s !== null && e !== null && e > s ? Math.min(1, Math.max(0, (now - s) / (e - s))) : null;
  const out = lines.map((l) => {
    const budgeted = toNumber(pick(l, 'budgeted', 'budget', 'approved')) || 0; const spent = toNumber(pick(l, 'spent', 'actual', 'expended')) || 0;
    const flags = [];
    const expected = elapsed === null ? null : round2(budgeted * elapsed);
    if (spent > budgeted) flags.push('over_budget');
    else if (expected && expected > 0) { const pace = spent / expected; if (pace > 1 + tol) flags.push('ahead_of_pace'); if (pace < 1 - tol) flags.push('behind_pace'); }
    return { line: pick(l, 'line', 'category', 'budget_line'), budgeted, spent, remaining: round2(budgeted - spent), pct_spent: budgeted ? spent / budgeted : null, expected_by_now: expected, flags, needs_explanation: flags.length > 0 };
  });
  const total_budgeted = round2(out.reduce((t, l) => t + l.budgeted, 0)); const total_spent = round2(out.reduce((t, l) => t + l.spent, 0));
  const flags = [];
  if (!out.length) flags.push('no_budget_lines');
  else if (g.award_amount && Math.abs(total_budgeted - g.award_amount) > 0.005) flags.push('budget_total_differs_from_award');
  return { elapsed_pct: elapsed, lines: out, total_budgeted, total_spent, flags };
}

export function outcomeReview(rows, exists) {
  return rows.map((o, i) => {
    const target = toNumber(pick(o, 'target', 'goal')); const actual = toNumber(pick(o, 'actual', 'result', 'achieved'));
    const evidence = pick(o, 'evidence', 'evidence_file', 'source');
    const flags = [];
    if (actual === null) flags.push('missing_actual');
    else if (target !== null && actual < target) flags.push('below_target');
    if (!evidence) flags.push('missing_evidence'); else if (!exists(evidence)) flags.push('evidence_not_found');
    return { ref: `E${i + 1}`, metric: pick(o, 'metric', 'outcome', 'measure'), target, actual, pct_of_target: target && actual !== null ? actual / target : null, evidence, flags };
  });
}

export function review({ grants, budget = [], outcomes = [], exists = () => false, ...a }) {
  const dl = deadlines(grants, a);
  // Rows grouped by grant once (file order kept), instead of filtering both files per grant.
  const byGrant = (rows) => { const m = new Map(); for (const r of rows) { const k = pick(r, 'grant_id', 'grant'); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return (id) => m.get(id) || []; };
  const budgetOf = byGrant(budget), outcomesOf = byGrant(outcomes);
  const items = dl.map((g) => {
    const b = budgetReview(g, budgetOf(g.grant_id), a);
    const o = outcomeReview(outcomesOf(g.grant_id), exists).map((x) => ({ ...x, ref: `${g.grant_id}-${x.ref}` }));
    const gaps = [];
    if (g.status === 'overdue') gaps.push(`Report was due ${g.report_due} (${-g.days_to_due} days ago).`);
    for (const f of b.flags) gaps.push(f === 'no_budget_lines' ? 'No budget lines found.' : `Budget lines total ${money(b.total_budgeted)}, award is ${money(g.award_amount)}.`);
    for (const l of b.lines) for (const f of l.flags) gaps.push(`Budget "${l.line}": ${f.replace(/_/g, ' ')} (spent ${money(l.spent)} of ${money(l.budgeted)}) — explanation needed.`);
    if (!o.length) gaps.push('No outcomes found.');
    for (const x of o) for (const f of x.flags) if (f !== 'below_target') gaps.push(`Outcome "${x.metric}": ${f.replace(/_/g, ' ')}${f === 'evidence_not_found' ? ` (${x.evidence})` : ''}.`);
    for (const x of o) if (x.flags.includes('below_target')) gaps.push(`Outcome "${x.metric}": ${x.actual} of ${x.target} — explanation needed.`);
    if (g.status === 'submitted') gaps.length = 0;
    return { ...g, budget: b, outcomes: o, gaps, open_items: gaps.length };
  });
  return { as_of: iso(asOfMs(a.as_of)), grants: items.length, overdue: items.filter((g) => g.status === 'overdue').length, due_soon: items.filter((g) => g.status === 'due_soon').length, open_items: items.reduce((t, g) => t + g.open_items, 0), items };
}

export function packetFiles(g, readEvidence, opts = {}) {
  const draft = [`# ${g.report_type[0].toUpperCase() + g.report_type.slice(1)} report — ${g.program}`, '', `> **DRAFT packet — not submitted.** A person completes, checks and submits this in ${g.funder}'s own process.`, '',
    `- Funder: ${g.funder}`, `- Grant: ${g.grant_id} · award ${money(g.award_amount)}`, `- Period: ${g.period_start} to ${g.period_end}`, `- Report due: ${g.report_due || '—'}`, '',
    '## Narrative', '', '[TO WRITE — a person writes this. Polyhymnia does not write claims about your program.]', '',
    '## Budget', '', `Period elapsed: ${pct(g.budget.elapsed_pct)}.`, '', '| Line | Budgeted | Spent | Remaining | % spent | Note |', '|---|---:|---:|---:|---:|---|'];
  for (const l of g.budget.lines) draft.push(`| ${l.line} | ${money(l.budgeted)} | ${money(l.spent)} | ${money(l.remaining)} | ${pct(l.pct_spent)} | ${l.needs_explanation ? `[EXPLAIN — ${l.flags.join(', ').replace(/_/g, ' ')}]` : ''} |`);
  draft.push(`| **Total** | **${money(g.budget.total_budgeted)}** | **${money(g.budget.total_spent)}** | **${money(g.budget.total_budgeted - g.budget.total_spent)}** | | |`);
  const budgetStart = draft.indexOf('## Budget') + 2;
  const budgetTable = draft.slice(budgetStart).join('\n');
  if (opts.varianceMd) draft.push('', '## Budget vs actual variance', '', opts.varianceMd);
  const outcomeLines = ['| Ref | Measure | Target | Actual | % of target | Evidence |', '|---|---|---:|---:|---:|---|'];
  for (const o of g.outcomes) outcomeLines.push(`| ${o.ref} | ${o.metric} | ${o.target ?? '—'} | ${o.actual ?? '[MISSING]'} | ${pct(o.pct_of_target)} | ${o.evidence && !o.flags.includes('evidence_not_found') ? o.evidence : '[MISSING EVIDENCE]'} |`);
  draft.push('', '## Outcomes', '', ...outcomeLines);
  draft.push('', '## Open items before submission', '', ...(g.gaps.length ? g.gaps.map((x) => `- ${x}`) : ['- None found by the checks. A person still reviews everything.']), '');
  const extra = opts.extraGaps || [];
  const checklist = [`# Checklist — ${g.grant_id} (${g.funder})`, '', '- [ ] Narrative written by a person', '- [ ] Every [EXPLAIN] and [MISSING] marker resolved', ...g.gaps.map((x) => `- [ ] ${x}`), ...extra.map((x) => `- [ ] ${x}`), "- [ ] Figures checked against the accounting system", "- [ ] Funder's own template and rules checked", '- [ ] Approved for submission by a named person', '', 'Reviewer: ____________  Date: ________', ''];
  const index = toCsv(g.outcomes.map((o) => { const t = o.evidence && !o.flags.includes('evidence_not_found') ? readEvidence(o.evidence) : null; return { ref: o.ref, metric: o.metric, evidence: o.evidence, found: t === null ? 'no' : 'yes', sha256: t === null ? '' : sha256(t).slice(0, 16) }; }), ['ref', 'metric', 'evidence', 'found', 'sha256']);
  const report = opts.render ? opts.render(budgetTable, outcomeLines.join('\n')) : draft.join('\n');
  return { 'report-draft.md': report, 'checklist.md': checklist.join('\n'), 'evidence-index.csv': index };
}
