import { defineManifest, toCsv, sha256, unifiedDiff, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { audit, fixListCsv, reportMarkdown, reportHtml, mechanicalFixes, MECHANICAL } from './pages.js';
import { AUDIT_CONFIG_SCHEMA } from './schemas.js';
import { PROMPTS } from './prompts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  site: { ...str, description: 'Folder of exported HTML pages (a static build or a saved copy of the site), relative to --root' },
  base_url: { ...str, description: 'Optional site URL (https://www.example.com) so absolute links to your own host are checked as internal' },
  ignore: { type: 'array', items: str, description: 'Check ids to leave out, e.g. ["canonical_missing"]' },
  config: { ...str, description: 'Optional audit config JSON (schema "audit_config"): base_url, ignore, ignore_pages, contrast thresholds, sitemap and robots file names, template_min_pages' },
};
/** Merge the config file under the call's own arguments (arguments win). */
const withConfig = (a, ctx) => {
  if (!a.config) return a;
  if (!ctx.exists(a.config)) throw new Error(`config not found: ${a.config}`);
  const c = ctx.readJson(a.config, 'audit_config');
  return { ...c, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), ignore: [...(c.ignore || []), ...(a.ignore || [])] };
};
const siteDir = (a, ctx) => {
  if (!String(a.site ?? '').trim()) throw new Error('site is required');
  const d = ctx.path(a.site); if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`site folder not found: ${a.site}`); return d;
};
const run = (a, ctx) => { const c = withConfig(a, ctx); return audit(siteDir(c, ctx), c); };
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'daphne-of-pages',
  version: pkg.version,
  description: 'Audits a folder of exported HTML pages: broken links, anchors and images; basic SEO gaps (titles, descriptions, headings, noindex, viewport); sitemap.xml and robots.txt consistency; and automatable checks mapped to WCAG 2.2 criteria (alt text, labels, link and button names, page language, zoom, frames, tab order, contrast from static CSS, focus indicators, ARIA misuse), each with a CSS selector and a prioritised action list. Writes a fix list and drafts mechanical fixes as copies. Publishing is one human click. A technical checklist, not a legal opinion; it never claims ADA or WCAG compliance.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'daphne_audit', kind: 'read',
      description: 'Check every .html page under site: links, SEO, sitemap.xml/robots.txt consistency, and accessibility issues (including contrast from static CSS, focus indicators and ARIA misuse) with severity, line, CSS selector and the WCAG criterion each automated check maps to, plus a prioritised action list. External links are listed, not fetched. Not a conformance claim.',
      inputSchema: { type: 'object', required: ['site'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.pages} page(s): ${r.issues} issue(s) (${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory); ${r.external_links.length} external link(s) not checked; sitemap/robots ${r.crawl.checked ? 'checked' : 'not present'}. Not a compliance finding.`, ...r }; },
    },
    {
      name: 'daphne_write_report', kind: 'report',
      description: 'Write page-audit.md, page-audit.html (self-contained, no scripts) and fix-list.csv (selector column; blank owner and status columns) into out_dir (default mythos-out/daphne). Both reports open with a prioritised "do these first" list.',
      inputSchema: { type: 'object', required: ['site'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/daphne');
        const md = safeMarkdown(reportMarkdown(r, a.site)); const html = reportHtml(r, a.site); const csv = fixListCsv(r);
        return { summary: `Report written: ${r.issues} issue(s) across ${r.pages} page(s).`, files: [ctx.writeFile(out, 'page-audit.md', md), ctx.writeFile(out, 'fix-list.csv', csv), ctx.writeFile(out, 'page-audit.html', html)], output_sha256: sha256(md + csv + html) };
      },
    },
    {
      name: 'daphne_draft_fixes', kind: 'write',
      description: 'Write fixed copies of pages into out_dir/proposed for mechanical fixes only (page language when you pass lang, zoom-blocking viewport, missing viewport, positive tabindex), plus fixes.diff (one unified diff for all pages, applies with patch -p1 or git apply), changes.md and proposal.json with hashes. Alt text, titles, labels and link text are left for a person. Your site files are not changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['site'], properties: { ...props, lang: { ...str, description: 'Language to set on pages with none, e.g. "en"' }, out_dir: str } },
      handler: async (a, ctx) => {
        const c = withConfig(a, ctx); const dir = siteDir(c, ctx); const r = audit(dir, c);
        const out = ctx.outDir(a.out_dir || 'mythos-out/daphne'); const files = []; const diffs = [];
        for (const p of r.by_page) {
          const before = readFileSync(join(dir, p.page), 'utf8'); const fx = mechanicalFixes(before, a);
          if (!fx.applied.length) continue;
          const dest = join(out, 'proposed', p.page); mkdirSync(dirname(dest), { recursive: true }); ctx.writeFile(dirname(dest), p.page.split('/').pop(), fx.text);
          files.push({ page: p.page, proposed: `proposed/${p.page}`, applied: fx.applied, sha256_before: sha256(before), sha256_after: sha256(fx.text) });
          diffs.push(unifiedDiff(before, fx.text, { oldPath: `a/${p.page}`, newPath: `b/${p.page}` }));
        }
        const diffText = diffs.join('');
        const fixed = new Set(files.flatMap((f) => f.applied.map((c) => `${f.page}|${c}`)));
        const person = r.items.filter((i) => !(MECHANICAL.includes(i.check) && fixed.has(`${i.page}|${i.check}`)));
        const L = ['# Proposed page changes (not published)', '', `Site: ${a.site}`, '', '## Mechanical fixes in proposed/', ''];
        for (const f of files) L.push(`- ${f.page}: ${f.applied.join(', ')}`);
        if (!files.length) L.push('- none');
        L.push('', `## Needs a person (${person.length})`, '', 'Daphne does not write alt text, titles, descriptions, labels or link text.', '');
        for (const i of person) L.push(`- [TO DO] \`${i.page}:${i.line}\` ${i.check}: ${i.detail}`);
        const diffFile = ctx.writeFile(out, 'fixes.diff', diffText);
        L.push('', '## Patch', '', `fixes.diff holds every mechanical fix as a unified diff against ${a.site}. Review it, then apply from inside the site folder with \`patch -p1 < fixes.diff\` (or \`git apply\`).`);
        const proposal = { site: a.site, created_at: new Date().toISOString(), files, diff: 'fixes.diff', diff_sha256: sha256(diffText), needs_person: person.length, note: 'Proposal only. A person publishes it.' };
        const pText = JSON.stringify(proposal, null, 2) + '\n';
        const pf = ctx.writeFile(out, 'proposal.json', pText);
        return { summary: `${files.length} page(s) with mechanical fixes written to proposed/ and fixes.diff; ${person.length} item(s) need a person. Nothing was published.`, proposal: relative(ctx.root, pf).split('\\').join('/'), proposal_sha256: sha256(pText), output_sha256: sha256(pText), files: [...files.map((f) => join(out, f.proposed)), diffFile, ctx.writeFile(out, 'changes.md', L.join('\n') + '\n'), pf] };
      },
    },
    {
      name: 'daphne_request_publish', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record that the reviewed proposal is approved to publish in publish-requests.csv. The approval is tied to proposal_sha256, and every proposed file is re-hashed first. A person publishes; Daphne never deploys.',
      inputSchema: { type: 'object', required: ['proposal', 'proposal_sha256'], properties: { proposal: str, proposal_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const pf = ctx.path(a.proposal); if (!existsSync(pf)) throw new Error(`proposal not found: ${a.proposal}`);
        const text = readFileSync(pf, 'utf8'); if (sha256(text) !== a.proposal_sha256) throw new Error('proposal_sha256 does not match the proposal file; review the current proposal and ask again');
        const p = JSON.parse(text);
        for (const f of p.files) { const fp = join(dirname(pf), f.proposed); if (!existsSync(fp) || sha256(readFileSync(fp, 'utf8')) !== f.sha256_after) throw new Error(`${f.proposed} changed after the proposal was written`); }
        if (p.diff) { const dp = join(dirname(pf), p.diff); if (!existsSync(dp) || sha256(readFileSync(dp, 'utf8')) !== p.diff_sha256) throw new Error(`${p.diff} changed after the proposal was written`); }
        const file = appendRow(ctx.outDir(a.out_dir || 'mythos-out/daphne'), 'publish-requests.csv', { requested_at: new Date().toISOString(), proposal: a.proposal, proposal_sha256: a.proposal_sha256, pages: p.files.map((f) => f.page).join('; '), status: 'approved - a person publishes it' }, ['requested_at', 'proposal', 'proposal_sha256', 'pages', 'status']);
        return { summary: `Publish approved and recorded for ${p.files.length} page(s). Nothing was deployed.`, file, output_sha256: a.proposal_sha256 };
      },
    },
    { name: 'deploy_site', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Daphne never deploys or uploads to a live site.', inputSchema: { type: 'object', properties: {} } },
    { name: 'http_fetch', kind: 'action', description: 'Listed so agents can see it is refused. Daphne makes no network calls; it reads the files you export.', inputSchema: { type: 'object', properties: {} } },
  ],
  prompts: PROMPTS,
  configSchemas: { audit_config: AUDIT_CONFIG_SCHEMA },
  policy: { rules: [
    { tool: 'daphne_audit', decision: 'allow' },
    { tool: 'daphne_write_report', decision: 'allow' },
    { tool: 'daphne_draft_fixes', decision: 'ask', reason: 'Writing proposed page copies needs a human yes (or an Auto opt-in).' },
    { tool: 'deploy_site', decision: 'block', reason: 'Daphne never deploys. A person publishes.' },
    { tool: 'http_fetch', decision: 'block', reason: 'Daphne makes no network calls.' },
    { tool: 'daphne_request_publish', decision: 'ask', reason: 'Publishing to a live site is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Daphne allowlist.' },
  ] },
});
