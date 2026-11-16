import { defineManifest, toCsv, sha256, htmlPage, escapeHtml, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { audit, readHar, reportMarkdown, draftTable, VENDOR_LIST, snapshot, diffInventory, diffMarkdown, reportHtml } from './consent.js';
import { configSchemas } from './schemas.js';
import { prompts } from './prompts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  site: { ...str, description: 'Optional folder of exported HTML pages, relative to --root' },
  base_url: { ...str, description: 'Your site URL (https://www.example.com) so your own host counts as first party' },
  har_first_visit: { ...str, description: 'HAR capture of a first visit in a clean browser profile, before any consent choice' },
  har_after_reject: { ...str, description: 'Optional HAR capture after clicking "Reject" (or "Reject all") on the banner' },
  har_after_accept: { ...str, description: 'Optional HAR capture after accepting, so everything the site can set is inventoried' },
  har_gpc: { ...str, description: 'Optional HAR capture of a first visit with Global Privacy Control on (requests carry Sec-GPC: 1). Any capture that carries the header is checked.' },
  vendors: { ...str, description: 'Optional extra vendor list JSON (name, version, source, hosts, cookies), matched before the built-in list and cited by its version' },
  declared: { ...str, description: 'Your stated cookie policy as JSON: source, cookies [{name, provider, purpose, duration}], third_parties [{host, name, purpose}]' },
  ignore: { type: 'array', items: str, description: 'Check ids to leave out, e.g. ["cookie_long_lifetime"]' },
};
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function load(a, ctx) {
  const hars = {}; const files = { first_visit: a.har_first_visit, after_reject: a.har_after_reject, after_accept: a.har_after_accept, gpc_visit: a.har_gpc };
  for (const [k, p] of Object.entries(files)) if (p) { const f = ctx.path(p); if (!existsSync(f)) throw new Error(`HAR file not found: ${p}`); hars[k] = readHar(readFileSync(f, 'utf8'), p); }
  let siteDir = null;
  if (a.site) { siteDir = ctx.path(a.site); if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) throw new Error(`site folder not found: ${a.site}`); }
  if (!siteDir && !Object.keys(hars).length) throw new Error('give a site folder, a HAR capture, or both');
  let declared = null;
  if (a.declared) declared = readConfig(ctx, a.declared, 'declared_policy', 'declared policy');
  const vendorLists = a.vendors ? [readConfig(ctx, a.vendors, 'vendor_list', 'vendor list'), VENDOR_LIST] : [VENDOR_LIST];
  let siteHost = null; let https = true;
  if (a.base_url) { try { const u = new URL(a.base_url); siteHost = u.hostname.toLowerCase(); https = u.protocol === 'https:'; } catch { throw new Error('base_url must be a full URL like https://www.example.com'); } }
  return { r: audit({ siteDir, siteHost, hars, declared, ignore: a.ignore || [], https, vendorLists }), declared };
}
function readConfig(ctx, p, schema, label) {
  if (!existsSync(ctx.path(p))) throw new Error(`${label} not found: ${p}`);
  try { return ctx.readJson(p, schema); } catch (e) { if (e instanceof SyntaxError) throw new Error(`${label} is not valid JSON`); throw e; }
}
const tool = { name: pkg.name, version: pkg.version };
const filesHash = (files) => sha256(files.map((f) => `${f.split(/[\\/]/).pop()}:${sha256(readFileSync(f))}`).join('\n'));
const line = (r) => `${r.cookies.length} cookie(s) and ${r.third_parties.length} third-party host(s) seen; ${r.issues} gap(s) (${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory). A technical inventory, not a compliance finding.`;
const MARK = /\[TO CONFIRM[^\]]*\]/;

export const manifest = defineManifest({
  name: 'britomartis-of-consent',
  version: pkg.version,
  description: 'Inventories the cookies and third-party hosts a site actually sets and loads, from exported HTML and HAR captures (first visit, after reject, after accept), and compares them with your stated cookie policy and banner: undeclared cookies and hosts, non-essential cookies or trackers before consent, after a reject or despite a Global Privacy Control signal, ungated tracker scripts, contradicted "no cookies" or "no trackers" claims, insecure and long-lived cookies. Purposes it guesses cite a versioned vendor list. Compares scans over time and writes markdown, HTML and CSV reports. Drafts a cookie table for a person. Publishing is one human click. Not a consent-management platform; never claims GDPR, CCPA/CPRA or ePrivacy compliance.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'britomartis_inventory', kind: 'read', title: 'Inventory cookies and third parties',
      description: 'Build the cookie and third-party inventory from the HTML and HAR files and list every gap against the declared policy, with severity. Purposes not in your policy come from a versioned vendor list, are marked as guesses and cite the list version. Captures sent with Sec-GPC: 1 are checked for trackers (gpc_signal_ignored), and .well-known/gpc.json in the site folder is read. No network calls.',
      inputSchema: { type: 'object', properties: props },
      handler: async (a, ctx) => { const { r } = load(a, ctx); return { summary: line(r), ...r }; },
    },
    {
      name: 'britomartis_write_report', kind: 'report',
      title: 'Write the consent audit report',
      description: 'Write consent-audit.md, consent-audit.html (self-contained, no scripts), cookie-inventory.csv and third-parties.csv (blank owner and status columns) and inventory.json (a snapshot without cookie values, for britomartis_diff_inventory next time) into out_dir (default mythos-out/britomartis). The output hash goes into the audit line.',
      inputSchema: { type: 'object', properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const { r } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/britomartis');
        const cc = toCsv(r.cookies.map((c) => ({ name: c.name, domain: c.domain, party: c.party, purpose: c.purpose || '', purpose_source: c.purpose_source, declared: c.declared ? 'yes' : 'no', lifetime_days: c.lifetime_days ?? '', secure: c.secure ?? '', samesite: c.samesite || '', seen_in: c.seen_in.join('; '), owner: '', status: '' })), ['name', 'domain', 'party', 'purpose', 'purpose_source', 'declared', 'lifetime_days', 'secure', 'samesite', 'seen_in', 'owner', 'status']);
        const tc = toCsv(r.third_parties.map((t) => ({ host: t.host, vendor: t.vendor || '', purpose: t.purpose || '', purpose_source: t.purpose_source, declared: t.declared ? 'yes' : 'no', seen_in: t.seen_in.join('; '), owner: '', status: '' })), ['host', 'vendor', 'purpose', 'purpose_source', 'declared', 'seen_in', 'owner', 'status']);
        const html = htmlPage({ title: `Cookie and consent audit${r.site_host ? `: ${r.site_host}` : ''}`, bodyHtml: reportHtml(r, escapeHtml), footer: 'A technical inventory from the files you gave Britomartis. Not legal advice and not a compliance finding.' });
        const files = [ctx.writeFile(out, 'consent-audit.md', reportMarkdown(r)), ctx.writeFile(out, 'cookie-inventory.csv', cc), ctx.writeFile(out, 'third-parties.csv', tc), ctx.writeFile(out, 'consent-audit.html', html), ctx.writeFile(out, 'inventory.json', JSON.stringify(snapshot(r, tool), null, 2) + '\n')];
        return { summary: `Report written. ${line(r)}`, files, output_sha256: filesHash(files) };
      },
    },
    {
      name: 'britomartis_diff_inventory', kind: 'read', title: 'Compare with the last scan',
      description: 'Compare an inventory.json from an earlier britomartis_write_report with the current captures: new and gone cookies and hosts, purpose or declared changes, new gaps and gaps no longer found. Read-only; returns the changes and a markdown summary.',
      inputSchema: { type: 'object', required: ['previous'], properties: { previous: { ...str, description: 'inventory.json from an earlier report, relative to --root' }, ...props } },
      handler: async (a, ctx) => {
        if (!existsSync(ctx.path(a.previous))) throw new Error(`previous inventory not found: ${a.previous}`);
        let prev; try { prev = JSON.parse(readFileSync(ctx.path(a.previous), 'utf8')); } catch { throw new Error('previous inventory is not valid JSON'); }
        const { r } = load(a, ctx); const d = diffInventory(prev, snapshot(r, tool));
        return { summary: `${d.changes} change(s) since the earlier scan: ${d.new_cookies.length} new cookie(s), ${d.new_hosts.length} new host(s), ${d.new_findings.length} new gap(s) (${d.new_errors} error), ${d.resolved_findings.length} gap(s) no longer found. A technical comparison, not a compliance finding.`, ...d, markdown: diffMarkdown(d, a.previous, 'these captures') };
      },
    },
    {
      name: 'britomartis_draft_policy_table', kind: 'write', title: 'Draft a cookie table',
      description: 'Draft a cookie table for your policy page from what was observed and declared: cookie-table.md, declared.proposed.json and proposal.json with hashes, in out_dir. Unknown purposes, providers and durations are [TO CONFIRM] markers; Britomartis does not decide what a cookie is for. Fixes to scripts and the banner are listed for a person. Your site and policy are not changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, declared } = load(a, ctx); const d = draftTable(r, declared); const out = ctx.outDir(a.out_dir || 'mythos-out/britomartis');
        const L = ['# Proposed cookie table (draft, not published)', '', `Based on: ${r.captures.join(', ') || 'HTML only'}${r.declared_source ? `; compared with ${r.declared_source}` : ''}. A person confirms every row before it goes on the site.`, '', '| Cookie | Provider | Purpose | Duration | Status |', '|---|---|---|---|---|', ...d.rows.map((x) => `| ${x.name} | ${x.provider} | ${x.purpose} | ${x.duration} | ${x.status} |`), '', '## Third parties', '', '| Host | Vendor | Purpose | Status |', '|---|---|---|---|', ...d.hosts.map((x) => `| ${x.host} | ${x.vendor} | ${x.purpose} | ${x.status} |`), '', `## Needs a person (${d.needs_person.length})`, '', 'Britomartis does not edit scripts, the banner or the policy text.', '', ...d.needs_person.map((x) => `- [ ] ${x}`), ''];
        const table = safeMarkdown(L.join('\n')); const proposedDecl = JSON.stringify({ source: declared?.source || '[TO CONFIRM policy name and date]', cookies: d.rows.map(({ name, provider, purpose, duration }) => ({ name, provider, purpose, duration })), third_parties: d.hosts.map(({ host, vendor, purpose }) => ({ host, name: vendor, purpose })) }, null, 2) + '\n';
        const f1 = ctx.writeFile(out, 'cookie-table.md', table); const f2 = ctx.writeFile(out, 'declared.proposed.json', proposedDecl);
        const proposal = { created_at: new Date().toISOString(), files: [{ file: 'cookie-table.md', sha256: sha256(table) }, { file: 'declared.proposed.json', sha256: sha256(proposedDecl) }], open_markers: ((table + proposedDecl).match(/\[TO CONFIRM/g) || []).length, needs_person: d.needs_person.length, note: 'Draft only. A person publishes the policy or banner change.' };
        const pText = JSON.stringify(proposal, null, 2) + '\n'; const pf = ctx.writeFile(out, 'proposal.json', pText);
        return { summary: `Drafted a ${d.rows.length}-row cookie table and ${d.hosts.length} third-party row(s); ${proposal.open_markers} [TO CONFIRM] marker(s) and ${d.needs_person.length} fix(es) need a person. Nothing was published.`, proposal: rel(ctx, pf), proposal_sha256: sha256(pText), files: [f1, f2, pf] };
      },
    },
    {
      name: 'britomartis_request_publish', kind: 'action', category: 'production_deploy', title: 'Approve publishing the cookie table (one click)',
      description: 'After one named human click (even in Auto), record in publish-requests.csv that the reviewed cookie table or policy change is approved to publish. Tied to proposal_sha256; every drafted file is re-hashed, and it is refused while any [TO CONFIRM] marker is left. A person publishes; Britomartis never changes the live banner, policy or site.',
      inputSchema: { type: 'object', required: ['proposal', 'proposal_sha256'], properties: { proposal: str, proposal_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const pf = ctx.path(a.proposal); if (!existsSync(pf)) throw new Error(`proposal not found: ${a.proposal}`);
        const text = readFileSync(pf, 'utf8'); if (sha256(text) !== a.proposal_sha256) throw new Error('proposal_sha256 does not match the proposal file; review the current proposal and ask again');
        const p = JSON.parse(text); let open = 0;
        for (const f of p.files) { const fp = join(dirname(pf), f.file); if (!existsSync(fp)) throw new Error(`${f.file} is missing`); const t = readFileSync(fp, 'utf8'); if (sha256(t) !== f.sha256) throw new Error(`${f.file} changed after the proposal was written; draft again`); if (MARK.test(t)) open++; }
        if (open) throw new Error(`${open} drafted file(s) still have [TO CONFIRM] markers; a person fills them in and drafts the proposal again`);
        const dir = ctx.outDir(a.out_dir || 'mythos-out/britomartis'); const f = join(dir, 'publish-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), proposal: a.proposal, proposal_sha256: a.proposal_sha256, files: p.files.map((x) => x.file).join('; '), status: 'approved - a person publishes it' }], ['requested_at', 'proposal', 'proposal_sha256', 'files', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: 'Publish approved and recorded. Nothing was deployed.', file: f };
      },
    },
    { name: 'deploy_site', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Britomartis never changes the live banner, policy, tag manager or site.', inputSchema: { type: 'object', properties: {} } },
    { name: 'http_fetch', kind: 'action', description: 'Listed so agents can see it is refused. Britomartis makes no network calls; it reads the files you export and capture.', inputSchema: { type: 'object', properties: {} } },
  ],
  configSchemas,
  prompts,
  policy: { rules: [
    { tool: 'britomartis_inventory', decision: 'allow' },
    { tool: 'britomartis_diff_inventory', decision: 'allow' },
    { tool: 'britomartis_write_report', decision: 'allow' },
    { tool: 'britomartis_draft_policy_table', decision: 'ask', reason: 'Drafting a cookie table needs a human yes (or an Auto opt-in).' },
    { tool: 'deploy_site', decision: 'block', reason: 'Britomartis never changes the live site. A person publishes.' },
    { tool: 'http_fetch', decision: 'block', reason: 'Britomartis makes no network calls.' },
    { tool: 'britomartis_request_publish', decision: 'ask', reason: 'Publishing a policy or banner change is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Britomartis allowlist.' },
  ] },
});
