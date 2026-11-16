// Telemetry-free eval report: report.json + a self-contained report.html
// (no scripts, no fonts, no network; CSP default-src 'none').

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareEvals } from './evals.js';
import { escapeHtml as e, htmlPage } from './formats.js';

export function evalReportHtml(r, cmp = null) {
  const reg = new Set(cmp ? cmp.regressions : []); const fixed = new Set(cmp ? cmp.fixed : []);
  const tiles = `<div class="tiles"><div class="tile"><b class="${r.passed === r.total ? 'ok' : 'bad'}">${r.passed}/${r.total}</b>passed</div>
<div class="tile"><b>${e(r.version || '')}</b>version</div><div class="tile"><b>${e(r.node || '')}</b>node</div>
${cmp ? `<div class="tile"><b class="${cmp.regressions.length ? 'bad' : 'ok'}">${cmp.regressions.length}</b>regressions vs baseline</div><div class="tile"><b>${cmp.fixed.length}</b>fixed</div>` : ''}</div>`;
  const rows = r.results.map((c) => `<tr><td>${reg.has(c.id) ? '<b class="bad">REGRESSED</b>' : fixed.has(c.id) ? '<b class="ok">FIXED</b>' : c.pass ? '<span class="ok">pass</span>' : '<span class="bad">fail</span>'}</td><td><code>${e(c.id)}</code></td><td><code>${e(c.tool || '')}</code></td><td>${e(c.status || '')}</td><td class="num">${e(c.ms ?? '')}</td><td>${e((c.fails || []).join('; '))}</td></tr>`).join('\n');
  const extra = cmp && (cmp.added.length || cmp.removed.length) ? `<p class="mut">Added cases: ${e(cmp.added.join(', ') || '—')}. Removed cases: ${e(cmp.removed.join(', ') || '—')}.</p>` : '';
  return htmlPage({
    title: `${r.suite} evals`,
    bodyHtml: `<h1>${e(r.suite)} evals</h1><p class="mut">Ran ${e(r.ran_at || '')}. Deterministic tool-level cases on fictional fixtures; no model is called.</p>${tiles}${extra}
<h2>Cases</h2><div class="wrap"><table><thead><tr><th>Result</th><th>Case</th><th>Tool</th><th>Status</th><th>ms</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    footer: 'Generated locally by mythos-agent-core. No scripts, no network requests.',
  });
}

/** Write report.json and report.html into dir. baseline: path to an earlier report.json. */
export function writeEvalReport(r, dir, { baseline } = {}) {
  const d = resolve(dir); mkdirSync(d, { recursive: true });
  let cmp = null;
  if (baseline && existsSync(baseline)) cmp = compareEvals(JSON.parse(readFileSync(baseline, 'utf8')), r);
  const json = { ...r, ...(cmp ? { comparison: cmp } : {}) };
  writeFileSync(join(d, 'report.json'), JSON.stringify(json, null, 2) + '\n');
  writeFileSync(join(d, 'report.html'), evalReportHtml(r, cmp));
  return { json: join(d, 'report.json'), html: join(d, 'report.html'), comparison: cmp };
}
