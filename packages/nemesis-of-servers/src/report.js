import { RULES, OWASP_MCP } from './catalog.js';

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const where = (i) => (i.tool ? `${i.server ? i.server + '/' : ''}${i.tool}` : i.server !== undefined && !i.file ? `server ${i.server}` : `${i.file}${i.line ? ':' + i.line : ''}${i.server !== undefined ? ` (server ${i.server})` : ''}`);
const SEV = { high: 0, medium: 1, low: 2 };

/** Group findings by rule into a prioritised "fix first" list. */
export function actionPlan(items) {
  const g = new Map();
  for (const i of items) {
    const a = g.get(i.id) || { rule: i.id, severity: i.severity, title: RULES[i.id]?.title || i.title, fix: i.fix || RULES[i.id]?.fix, owasp: RULES[i.id]?.owasp || [], count: 0, where: [] };
    a.count++; if (SEV[i.severity] < SEV[a.severity]) a.severity = i.severity;
    if (a.where.length < 5) a.where.push(where(i));
    g.set(i.id, a);
  }
  return [...g.values()].sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.count - a.count || a.rule.localeCompare(b.rule)).map((a, k) => ({ priority: k + 1, ...a }));
}

export function owaspCoverage(items) {
  return Object.entries(OWASP_MCP).map(([id, name]) => ({ id, name, findings: items.filter((i) => (RULES[i.id]?.owasp || []).includes(id)).length }));
}

export function reportMarkdown(result, title, generatedAt) {
  const L = [`# ${title}`, '', `Generated ${generatedAt} by nemesis-of-servers. Static, pattern-based review.`, '', `**Verdict:** ${result.verdict.replace(/_/g, ' ')} · high ${result.by_severity.high}, medium ${result.by_severity.medium}, low ${result.by_severity.low}${result.suppressed?.length ? ` · ${result.suppressed.length} suppressed by policy` : ''}`, ''];
  if (result.gate) L.push(`**Gate (fail on ${result.gate.fail_on}):** ${result.gate.result}`, '');
  const plan = actionPlan(result.items);
  if (plan.length) {
    L.push('## Fix first', '', '| # | Severity | Rule | Count | What to do | Examples |', '|---|---|---|---:|---|---|');
    for (const a of plan) L.push(`| ${a.priority} | ${a.severity} | ${a.rule} | ${a.count} | ${cell(a.fix)} | ${cell(a.where.join('; '))} |`);
    L.push('');
  }
  L.push('## Findings', '', '| Severity | Rule | Where | Finding |', '|---|---|---|---|');
  for (const i of result.items) L.push(`| ${i.severity} | ${i.id} | ${cell(where(i))} | ${cell(i.title)} |`);
  const flows = result.items.filter((i) => i.flow);
  if (flows.length) {
    L.push('', '## Data flows', '');
    for (const i of flows) { L.push(`- **${i.id}** in \`${i.file}\``); for (const s of i.flow) L.push(`  - line ${s.line}: ${s.label} — \`${cell(s.code).replace(/`/g, "'")}\``); }
  }
  if (result.tool_changes?.length) {
    L.push('', '## Tool changes since the pin', '');
    for (const c of result.tool_changes) { L.push(`- **${c.change}** \`${c.server}/${c.tool}\`${c.fields ? ` (${c.fields.join(', ')})` : ''}`); if (c.diff) L.push('', '```diff', c.diff.trimEnd(), '```', ''); }
  }
  L.push('', '## OWASP MCP Top 10 view', '', '| Risk | Findings |', '|---|---:|');
  for (const o of owaspCoverage(result.items)) L.push(`| ${o.id} ${o.name} | ${o.findings} |`);
  L.push('', 'A zero here means none of Nemesis\'s patterns matched; some risks (for example MCP08 audit and telemetry) are mostly outside what a static scan can see.');
  if (result.suppressed?.length) {
    L.push('', '## Suppressed by policy', '', '| Rule | Where | Reason |', '|---|---|---|');
    for (const i of result.suppressed) L.push(`| ${i.id} | ${cell(where(i))} | ${cell(i.suppressed)} |`);
  }
  L.push('', '## Limits', '', '- Patterns and the one-file data-flow check find places to read; they can miss obfuscated or dynamic code and can flag safe code.', '- The advisory list is a small offline snapshot, not a vulnerability database.', '- This is not a penetration test, a certification or a guarantee.', '');
  return L.join('\n');
}
