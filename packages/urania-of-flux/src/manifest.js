import { defineManifest, toCsv, sha256, canonical, safeMarkdown, safeFileName } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { variances, varianceTable, draftCommentary, checkClaims, citationsCsv, comparePrior } from './flux.js';
import { CHARTS, chartSvg, tracePoints } from './charts.js';
import { packHtml } from './html.js';
import { PACK_MANIFEST_SCHEMA } from './schemas.js';
import { PROMPTS } from './prompts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const strs = { type: 'array', items: str };
const base = { figures: { ...str, description: 'Source figures CSV/JSON: id, metric, period, actual, budget, prior, source' }, materiality_abs: num, materiality_pct: num, out_dir: { ...str, description: 'Default mythos-out/urania' } };
const OUT = (a) => a.out_dir || 'mythos-out/urania';
const text = (ctx, p) => { const f = ctx.path(p); if (!existsSync(f)) throw new Error(`file not found: ${p}`); return readFileSync(f, 'utf8'); };
const fileHash = (ctx, p) => sha256(readFileSync(ctx.path(p)));
function lockState(a, ctx) {
  const lf = join(ctx.path(OUT(a)), 'figures.lock.json');
  if (!existsSync(lf)) return { lock: 'none' };
  const l = JSON.parse(readFileSync(lf, 'utf8'));
  if (l.figures !== a.figures) return { lock: 'other_file', locked_file: l.figures };
  return { lock: l.sha256 === fileHash(ctx, a.figures) ? 'match' : 'changed', locked_at: l.locked_at, locked_sha256: l.sha256 };
}
function requireLock(a, ctx) {
  const l = lockState(a, ctx);
  if (l.lock !== 'match') throw new Error(l.lock === 'changed' ? 'figures changed since they were locked; re-lock after review' : 'lock the figures first (urania_lock_figures)');
  return l;
}
const chartNames = Object.keys(CHARTS);
function buildCharts(vs, list, source, ids) {
  const charts = (list && list.length ? list : ['variance', 'variance_pct']).map((c) => chartSvg(vs, c, { source, ids }));
  for (const c of charts) { const bad = tracePoints(c.points, vs); if (bad.length) throw new Error(`chart ${c.chart} does not trace to the figures: ${bad.join('; ')}`); }
  return charts;
}
const readManifest = (ctx, p) => { if (!ctx.exists(p)) throw new Error(`file not found: ${p}`); return ctx.readJson(p, 'pack_manifest'); };
const docsOf = (a, ctx) => [...(a.docs || []), ...(a.commentary ? [a.commentary] : [])].map((p) => ({ path: p, text: text(ctx, p) }));

export const manifest = defineManifest({
  name: 'urania-of-flux',
  version: pkg.version,
  description: 'Board pack assembly from locked source figures and source documents: variances against budget and prior period, cited commentary drafts with reasons left to owners, and a claims check that every number in the pack cites a figure id and matches it. Controller sign-off and distribution are each one human click; it never uploads or sends.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'urania_lock_figures', kind: 'write',
      description: 'Record the sha256 of the source figures file in figures.lock.json. Packs are only built from locked figures, and a sign-off is refused if the figures change after locking. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['figures'], properties: { ...base, as_of: str } },
      handler: async (a, ctx) => {
        const rows = variances(ctx.records(a.figures), a).length; const out = ctx.outDir(OUT(a));
        const lock = { figures: a.figures, sha256: fileHash(ctx, a.figures), rows, locked_at: a.as_of || new Date().toISOString() };
        return { summary: `Locked ${rows} figure(s) from ${a.figures} (sha256 ${lock.sha256.slice(0, 12)}…).`, file: ctx.writeFile(out, 'figures.lock.json', JSON.stringify(lock, null, 2) + '\n'), ...lock };
      },
    },
    {
      name: 'urania_variance', kind: 'read',
      description: 'Variance of each figure against budget and prior period, with materiality flags and the lock state of the figures file.',
      inputSchema: { type: 'object', required: ['figures'], properties: base },
      handler: async (a, ctx) => { const v = variances(ctx.records(a.figures), a); const l = lockState(a, ctx); return { summary: `${v.length} figure(s), ${v.filter((x) => x.material).length} material; lock: ${l.lock}.`, ...l, figures: v }; },
    },
    {
      name: 'urania_draft_commentary', kind: 'write',
      description: 'Write commentary.md: one cited line per material variance with "Reason: [TO WRITE]" for the owner. Urania does not guess causes. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['figures'], properties: { ...base, period: str } },
      handler: async (a, ctx) => { const v = variances(ctx.records(a.figures), a); return { summary: `Commentary draft written for ${v.filter((x) => x.material).length} material variance(s).`, file: ctx.writeFile(ctx.outDir(OUT(a)), 'commentary.md', draftCommentary(v, a)) }; },
    },
    {
      name: 'urania_check_claims', kind: 'read',
      description: 'Check every sentence with a number in the given documents: it must cite a known figure id like [F1]; each number must match a value of a cited figure (actual, budget, prior, variance, variance %, or a ratio or change between two cited figures) at the precision written (one full unit of the last digit after "about", "roughly", "nearly" or "~"); and an up/above or down/below word must agree with the sign of the matched variance.',
      inputSchema: { type: 'object', required: ['figures', 'docs'], properties: { ...base, docs: strs, commentary: str } },
      handler: async (a, ctx) => { const c = checkClaims(docsOf(a, ctx), variances(ctx.records(a.figures), a)); return { summary: `${c.claims_checked} claim(s): ${c.ok} ok, ${c.uncited_number} uncited, ${c.unknown_citation} unknown citation, ${c.number_mismatch} mismatch, ${c.direction_mismatch} wrong direction.`, ...c }; },
    },
    {
      name: 'urania_assemble_pack', kind: 'report',
      description: 'Assemble board-pack.md (variance table, commentary, each source doc with its hash, figure sources, claims-check result), citations.csv and pack-manifest.json. Refuses unless the figures are locked and unchanged. Marked DRAFT until a controller signs.',
      inputSchema: { type: 'object', required: ['figures'], properties: { ...base, docs: strs, commentary: str, title: str, period: str, html: { type: 'boolean', description: 'Also write board-pack.html (self-contained, no scripts) with the charts inline' }, charts: { type: 'array', items: { type: 'string', enum: chartNames }, description: 'Charts for the HTML pack (default variance, variance_pct)' } } },
      handler: async (a, ctx) => {
        const l = requireLock(a, ctx);
        const v = variances(ctx.records(a.figures), a); const docs = docsOf(a, ctx); const c = checkClaims(docs, v);
        const title = a.title || 'Board pack'; const out = ctx.outDir(OUT(a));
        const L = [`# ${title}${a.period ? ` — ${a.period}` : ''}`, '', '> **DRAFT — not for distribution until a controller signs.**', '', `Figures: \`${a.figures}\` (locked, sha256 ${l.locked_sha256.slice(0, 12)}…). Claims check: ${c.ok}/${c.claims_checked} ok, ${c.issues} issue(s).`, '', '## Contents', '', '1. Variances', ...docs.map((d, i) => `${i + 2}. ${d.path}`), `${docs.length + 2}. Figure sources`, `${docs.length + 3}. Claims check`, '', '## 1. Variances', '', varianceTable(v), ''];
        docs.forEach((d, i) => L.push(`## ${i + 2}. ${d.path}`, '', `_Source: \`${d.path}\` · sha256 ${sha256(d.text).slice(0, 12)}…_`, '', d.text.replace(/^#\s+.*\n?/, '').trim(), ''));
        L.push(`## ${docs.length + 2}. Figure sources`, '', ...v.map((x) => `- [${x.id}] ${x.metric}: ${x.source || '(no source given)'}`), '', `## ${docs.length + 3}. Claims check`, '');
        if (!c.issues) L.push('Every sentence with a number cites a figure and matches it.', '');
        for (const x of c.claims.filter((y) => y.status !== 'ok')) L.push(`- **${x.status}** — ${x.doc}:${x.line}: "${x.text}"${x.unmatched.length ? ` (no match for ${x.unmatched.join(', ')})` : ''}${x.unknown_refs.length ? ` (unknown ${x.unknown_refs.join(', ')})` : ''}`);
        const pack = safeMarkdown(L.join('\n') + '\n'); const packFile = ctx.writeFile(out, 'board-pack.md', pack);
        const man = { title, period: a.period || '', pack: relative(ctx.root, packFile).split('\\').join('/'), pack_sha256: sha256(pack), figures: a.figures, figures_sha256: l.locked_sha256, docs: docs.map((d) => ({ path: d.path, sha256: sha256(d.text) })), claims_checked: c.claims_checked, claims_issues: c.issues, open_markers: (pack.match(/\[TO WRITE[^\]]*\]/g) || []).length };
        const files = [packFile, ctx.writeFile(out, 'citations.csv', citationsCsv(c))];
        if (a.html) {
          const charts = buildCharts(v, a.charts, `${a.figures} (locked)`);
          const html = packHtml({ title, period: a.period || '', figures: a.figures, lockedSha: l.locked_sha256, vs: v, docs: docs.map((d) => ({ ...d, sha256: sha256(d.text) })), claims: c, charts });
          const hf = ctx.writeFile(out, 'board-pack.html', html); files.push(hf);
          Object.assign(man, { html: relative(ctx.root, hf).split('\\').join('/'), html_sha256: sha256(html) });
        }
        files.push(ctx.writeFile(out, 'pack-manifest.json', JSON.stringify(man, null, 2) + '\n'));
        return { summary: `Board pack assembled from ${docs.length} doc(s); claims check ${c.ok}/${c.claims_checked} ok, ${c.issues} issue(s); ${man.open_markers} [TO WRITE] marker(s). DRAFT until a controller signs.`, claims_issues: c.issues, open_markers: man.open_markers, pack_sha256: man.pack_sha256, output_sha256: man.pack_sha256, files };
      },
    },
    {
      name: 'urania_charts', kind: 'report', title: 'Charts from locked figures',
      description: 'Draw self-contained SVG charts (no scripts, no external references) from the locked figures: variance, variance_pct and actual_vs_basis. Every bar carries data-figure-id, data-field and data-value, and charts.json lists each point, so every mark traces to a figure id. Refuses unless the figures are locked and unchanged.',
      inputSchema: { type: 'object', required: ['figures'], properties: { ...base, charts: { type: 'array', items: { type: 'string', enum: chartNames }, description: 'Default: variance, variance_pct' }, ids: { ...strs, description: 'Only these figure ids (default all)' } } },
      handler: async (a, ctx) => {
        const l = requireLock(a, ctx); const v = variances(ctx.records(a.figures), a);
        const charts = buildCharts(v, a.charts, `${a.figures} (locked, sha256 ${l.locked_sha256.slice(0, 12)}…)`, a.ids);
        const out = ctx.outDir(join(OUT(a), 'charts'));
        const files = charts.map((c) => ctx.writeFile(out, `${safeFileName(c.chart)}.svg`, c.svg));
        const index = { figures: a.figures, figures_sha256: l.locked_sha256, charts: charts.map((c) => ({ chart: c.chart, file: `${safeFileName(c.chart)}.svg`, sha256: sha256(c.svg), points: c.points })) };
        files.push(ctx.writeFile(out, 'charts.json', JSON.stringify(index, null, 2) + '\n'));
        const points = charts.reduce((n, c) => n + c.points.length, 0);
        return { summary: `${charts.length} chart(s), ${points} point(s), each traced to a figure id.`, charts: charts.map((c) => ({ chart: c.chart, points: c.points })), files, output_sha256: sha256(canonical(index)) };
      },
    },
    {
      name: 'urania_compare_prior', kind: 'read', title: 'Compare with the prior pack',
      description: "Compare this pack's figures with the previous pack's figures: restated figures (same period, new value), prior periods that no longer equal what was reported, new and dropped metrics, and changed figure ids. With docs, lists every sentence that cites an affected figure. With prior_manifest, checks the prior figures file is the one that pack was built from.",
      inputSchema: { type: 'object', required: ['figures', 'prior_figures'], properties: { ...base, prior_figures: { ...str, description: "The previous pack's figures CSV/JSON" }, prior_manifest: { ...str, description: "The previous pack's pack-manifest.json (optional)" }, docs: strs, commentary: str, tolerance: { type: 'number', minimum: 0, description: 'Absolute tolerance for equal values (default 0.5)' } } },
      handler: async (a, ctx) => {
        const r = comparePrior(variances(ctx.records(a.figures), a), variances(ctx.records(a.prior_figures), a), { tolerance: a.tolerance ?? 0.5, docs: docsOf(a, ctx) });
        let prior_pack = null;
        if (a.prior_manifest) {
          const pm = readManifest(ctx, a.prior_manifest); const h = fileHash(ctx, a.prior_figures);
          prior_pack = { title: pm.title, period: pm.period || '', figures_match_manifest: h === pm.figures_sha256 };
        }
        const warn = prior_pack && !prior_pack.figures_match_manifest ? ' WARNING: the prior figures file is not the one the prior pack was built from.' : '';
        return { summary: `${r.restated} restated, ${r.prior_restated} prior-period restatement(s), ${r.new_metrics} new and ${r.dropped_metrics} dropped metric(s); ${r.impact.length} sentence(s) cite affected figures.${warn}`, prior_pack, ...r };
      },
    },
    {
      name: 'urania_record_signoff', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record the controller sign-off for this exact pack (by pack_sha256) in signoff.json. Refused if the pack or figures changed, or if claims issues or [TO WRITE] markers remain, unless accept_open_issues is true with a note.',
      inputSchema: { type: 'object', required: ['pack_manifest', 'pack_sha256', 'controller'], properties: { pack_manifest: str, pack_sha256: { ...str, description: 'The pack_sha256 from pack-manifest.json: the approval covers this exact pack' }, controller: str, accept_open_issues: { type: 'boolean' }, note: str } },
      handler: async (a, ctx) => {
        if (!String(a.controller || '').trim()) throw new Error('controller is required');
        const m = readManifest(ctx, a.pack_manifest);
        if (a.pack_sha256 !== m.pack_sha256) throw new Error('pack_sha256 does not match pack-manifest.json; sign the current pack');
        if (fileHash(ctx, m.pack) !== m.pack_sha256) throw new Error('board-pack.md changed after it was assembled; reassemble it');
        if (m.html && (!ctx.exists(m.html) || fileHash(ctx, m.html) !== m.html_sha256)) throw new Error('board-pack.html changed after it was assembled; reassemble it');
        if (fileHash(ctx, m.figures) !== m.figures_sha256) throw new Error('figures changed after the pack was built; re-lock and reassemble');
        const open = m.claims_issues + (m.open_markers || 0);
        if (open > 0 && !(a.accept_open_issues === true && String(a.note || '').trim())) throw new Error(`${m.claims_issues} claims issue(s) and ${m.open_markers || 0} [TO WRITE] marker(s) open; fix them, or pass accept_open_issues with a note`);
        const s = { controller: a.controller, pack: m.pack, pack_sha256: m.pack_sha256, figures_sha256: m.figures_sha256, open_issues_accepted: open, note: a.note || '', signed_at: new Date().toISOString() };
        const f = join(dirname(ctx.path(a.pack_manifest)), 'signoff.json'); writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
        return { summary: `Sign-off recorded for ${m.title} by ${a.controller}.`, file: f, output_sha256: m.pack_sha256 };
      },
    },
    {
      name: 'urania_request_distribution', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record an approved distribution of the signed pack in distribution-requests.csv. Refused unless signoff.json matches this exact pack. A person distributes it; Urania never uploads or emails.',
      inputSchema: { type: 'object', required: ['pack_manifest', 'pack_sha256', 'recipients'], properties: { pack_manifest: str, pack_sha256: str, recipients: strs, out_dir: str } },
      handler: async (a, ctx) => {
        if (!Array.isArray(a.recipients) || !a.recipients.length) throw new Error('recipients must list at least one recipient');
        const m = readManifest(ctx, a.pack_manifest); if (a.pack_sha256 !== m.pack_sha256) throw new Error('pack_sha256 does not match pack-manifest.json');
        const sf = join(dirname(ctx.path(a.pack_manifest)), 'signoff.json');
        if (!existsSync(sf)) throw new Error('not signed: a controller must sign this pack first (urania_record_signoff)');
        const s = JSON.parse(readFileSync(sf, 'utf8'));
        if (s.pack_sha256 !== m.pack_sha256 || fileHash(ctx, m.pack) !== m.pack_sha256) throw new Error('the sign-off does not match the current pack; sign the current pack first');
        const f = join(ctx.outDir(OUT(a)), 'distribution-requests.csv');
        const csv = toCsv(a.recipients.map((r) => ({ requested_at: new Date().toISOString(), pack: m.pack, pack_sha256: m.pack_sha256.slice(0, 16), signed_by: s.controller, recipient: r, status: 'approved - a person distributes it' })), ['requested_at', 'pack', 'pack_sha256', 'signed_by', 'recipient', 'status']);
        appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        return { summary: `Distribution to ${a.recipients.length} recipient(s) approved and recorded. Nothing was sent.`, file: f };
      },
    },
    { name: 'board_portal_upload', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Urania never uploads to a board portal.', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Urania never sends email.', inputSchema: { type: 'object', properties: {} } },
  ],
  prompts: PROMPTS,
  configSchemas: { pack_manifest: PACK_MANIFEST_SCHEMA },
  policy: { rules: [
    { tool: 'urania_variance', decision: 'allow' },
    { tool: 'urania_check_claims', decision: 'allow' },
    { tool: 'urania_assemble_pack', decision: 'allow' },
    { tool: 'urania_charts', decision: 'allow' },
    { tool: 'urania_compare_prior', decision: 'allow' },
    { tool: 'urania_lock_figures', decision: 'ask', reason: 'Locking the source figures needs a human yes (or an Auto opt-in).' },
    { tool: 'urania_draft_commentary', decision: 'ask', reason: 'Writing a commentary draft needs a human yes (or an Auto opt-in).' },
    { tool: 'board_portal_upload', decision: 'block', reason: 'Urania never uploads board packs.' },
    { tool: 'send_email', decision: 'block', reason: 'Urania never sends email.' },
    { tool: 'urania_record_signoff', decision: 'ask', reason: 'A controller sign-off is one named human click, even in Auto.' },
    { tool: 'urania_request_distribution', decision: 'ask', reason: 'Distributing the board pack is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Urania allowlist.' },
  ] },
});
