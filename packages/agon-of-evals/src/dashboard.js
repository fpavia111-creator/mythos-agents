// Static HTML dashboard for a series of graded runs. Self-contained: inline CSS only,
// no scripts, fonts, images or links, so opening it makes zero network requests.
// Deterministic: no timestamps, so the same runs give the same bytes.
import { htmlPage, escapeHtml as e } from 'mythos-agent-core';
import { compare } from './grade.js';

const bar = (pct, cls) => `<div style="background:var(--line);border-radius:4px;height:10px;min-width:120px"><div class="${cls}" style="background:currentColor;height:10px;border-radius:4px;width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

/** runs: [{ label, grade }] oldest first. stats: optional scoreDeltaCI result for the last two runs. */
export function dashboardHtml(suite, runs, { stats = null, gate = null, rubric = null } = {}) {
  const last = runs[runs.length - 1].grade; const prev = runs.length > 1 ? runs[runs.length - 2].grade : null;
  const cmp = prev ? compare(prev, last) : null;
  const tiles = [`<div class="tile"><b class="${last.failed ? 'warn' : 'ok'}">${e(last.score)}%</b>latest score</div>`, `<div class="tile"><b>${last.passed}/${last.cases}</b>cases passed</div>`];
  if (cmp) tiles.push(`<div class="tile"><b class="${cmp.delta < 0 ? 'bad' : 'ok'}">${cmp.delta >= 0 ? '+' : ''}${e(cmp.delta)}</b>points vs previous</div>`, `<div class="tile"><b class="${cmp.regressions.length ? 'bad' : 'ok'}">${cmp.regressions.length}</b>regressions</div>`, `<div class="tile"><b>${cmp.fixes.length}</b>fixed</div>`);
  if (last.trials) tiles.push(`<div class="tile"><b class="${last.trials.flaky_cases.length ? 'warn' : 'ok'}">${last.trials.flaky_cases.length}</b>flaky cases</div>`);
  if (last.critical_failures.length) tiles.push(`<div class="tile"><b class="bad">${last.critical_failures.length}</b>critical failing</div>`);
  if (gate) tiles.push(`<div class="tile"><b class="${gate.result === 'pass' ? 'ok' : 'bad'}">${e(gate.result.toUpperCase())}</b>gate</div>`);
  if (rubric) tiles.push(`<div class="tile"><b>${e(rubric.score)}%</b>rubric score</div>`);

  const trend = runs.map((r, i) => {
    const g = r.grade; const d = i ? Math.round((g.score - runs[i - 1].grade.score) * 100) / 100 : null;
    return `<tr><td>${e(r.label)}</td><td class="num">${e(g.score)}%</td><td>${bar(g.score, g.comparable ? 'ok' : 'mut')}</td><td class="num">${d === null ? '' : `<span class="${d < 0 ? 'bad' : d > 0 ? 'ok' : 'mut'}">${d >= 0 ? '+' : ''}${e(d)}</span>`}</td><td class="num">${g.passed}/${g.cases}</td><td>${g.passed_ci95.map(e).join('–')}%</td><td>${g.comparable ? '<span class="ok">yes</span>' : `<span class="warn">no</span> <span class="mut">${e(g.response_models.join(', ') || 'no model id')}</span>`}</td></tr>`;
  }).join('\n');

  const cell = (r, o) => {
    if (!r) return '<td class="mut">—</td>';
    const label = r.missing ? 'missing' : r.trials > 1 ? `${r.passes}/${r.trials}` : r.pass ? 'pass' : 'fail';
    const flag = o && o.pass && !r.pass ? ' <b class="bad">REGRESSED</b>' : o && !o.pass && r.pass ? ' <b class="ok">FIXED</b>' : '';
    return `<td><span class="${r.pass ? 'ok' : 'bad'}">${e(label)}</span>${r.flaky ? ' <span class="warn">flaky</span>' : ''}${flag}</td>`;
  };
  const matrix = suite.cases.map((c) => {
    const cells = runs.map((r, i) => cell(r.grade.results.find((x) => x.id === c.id), i ? runs[i - 1].grade.results.find((x) => x.id === c.id) : null)).join('');
    const lr = last.results.find((x) => x.id === c.id);
    return `<tr><td><code>${e(c.id)}</code>${c.critical ? ' <span class="warn">critical</span>' : ''}<br><span class="mut">${e((c.tags || []).join(', '))}</span></td>${cells}<td>${e(lr && !lr.pass ? lr.failures.join('; ') : '')}</td></tr>`;
  }).join('\n');

  const tags = Object.entries(last.by_tag).sort(([a], [b]) => a.localeCompare(b));
  const tagTable = tags.length ? `<h2>By tag (latest run)</h2><div class="wrap"><table><thead><tr><th>Tag</th><th>Passed</th><th></th></tr></thead><tbody>${tags.map(([t, x]) => `<tr><td>${e(t)}</td><td class="num">${x.passed}/${x.cases}</td><td>${bar(x.pass_pct, x.passed === x.cases ? 'ok' : 'warn')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const statsBlock = stats ? `<h2>Is the change real?</h2><p><b class="${stats.verdict === 'regression' ? 'bad' : stats.verdict === 'improvement' ? 'ok' : 'mut'}">${e(stats.verdict.replace(/_/g, ' '))}</b>: score change ${stats.delta >= 0 ? '+' : ''}${e(stats.delta)} points, ${Math.round(stats.confidence * 100)}% interval ${e(stats.ci_low)} to ${e(stats.ci_high)} <span class="mut">(${e(stats.method)}, ${e(stats.resamples)} resamples, seed ${e(stats.seed)})</span>.</p><p class="mut">${e(stats.note)}</p>${stats.per_case.length ? `<div class="wrap"><table><thead><tr><th>Case</th><th>Previous</th><th>Latest</th><th>Change</th><th>p (one-sided)</th><th></th></tr></thead><tbody>${stats.per_case.map((p) => `<tr><td><code>${e(p.id)}</code></td><td class="num">${e(p.baseline)}</td><td class="num">${e(p.candidate)}</td><td class="num">${e(p.change)}</td><td class="num">${p.p_value === undefined || p.p_value === null ? '' : e(p.p_value)}</td><td>${p.significant ? '<b class="bad">significant regression</b>' : p.change < 0 ? '<span class="mut">within noise</span>' : '<span class="ok">better</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}` : '';
  const gateBlock = gate ? `<h2>Gate</h2><p><b class="${gate.result === 'pass' ? 'ok' : 'bad'}">${e(gate.result)}</b>${gate.reasons.length ? ': ' + e(gate.reasons.join('; ')) : ''}</p>` : '';
  const rubricBlock = rubric ? `<h2>Rubric: ${e(rubric.rubric)}</h2><p>${e(rubric.earned)}/${e(rubric.possible)} points (${e(rubric.score)}%); ${rubric.pending} pending, ${rubric.unverified_citations} citation(s) not found.</p><div class="wrap"><table><thead><tr><th>Case</th><th>Criterion</th><th>Points</th><th>Evidence or reason</th></tr></thead><tbody>${rubric.results.flatMap((c) => c.criteria.map((k) => `<tr><td><code>${e(c.id)}</code></td><td><b>${e(k.criterion)}</b> ${e(k.text)}</td><td class="num"><span class="${k.status === 'met' ? 'ok' : k.status === 'pending' ? 'mut' : 'bad'}">${k.status === 'pending' ? 'pending' : `${e(k.earned)}/${e(k.points)}`}</span></td><td>${e(k.evidence ? `“${k.evidence.quote}”` : k.reason || '')}</td></tr>`)).join('')}</tbody></table></div>` : '';

  return htmlPage({
    title: `${suite.suite} eval dashboard`,
    bodyHtml: `<h1>${e(suite.suite)}</h1><p class="mut">${e(suite.process || '')} · pinned model <code>${e(suite.model.id)}</code> · ${runs.length} run(s), oldest first</p>
<div class="tiles">${tiles.join('')}</div>${gateBlock}${statsBlock}
<h2>Runs</h2><div class="wrap"><table><thead><tr><th>Run</th><th>Score</th><th></th><th>Change</th><th>Passed</th><th>95% interval</th><th>Comparable</th></tr></thead><tbody>${trend}</tbody></table></div>
<h2>Cases</h2><div class="wrap"><table><thead><tr><th>Case</th>${runs.map((r) => `<th>${e(r.label)}</th>`).join('')}<th>Latest failure</th></tr></thead><tbody>${matrix}</tbody></table></div>
${tagTable}${rubricBlock}`,
    footer: 'Generated locally by agon-of-evals from recorded responses. No scripts, no network requests. A score covers this suite and this pinned model only.',
  });
}
