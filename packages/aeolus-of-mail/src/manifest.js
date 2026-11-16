import { defineManifest, toCsv, sha256, toIcs, htmlPage, escapeHtml, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { audit, draftChanges, reportMarkdown, recordsResolver, dohResolver, hasMarkers } from './mail.js';
import { reportXmls, parseAggregate, summarise } from './reports.js';
import { checkHeaders } from './headers.js';
import { planRollout, rolloutMarkdown, ROLLOUT_SCHEMA, DEFAULT_ROLLOUT } from './rollout.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  domain: { ...str, description: 'Sending domain to audit, e.g. example.com or send.example.com' },
  selectors: { type: 'array', items: str, description: 'DKIM selectors to check (the s= tag in a sent message). Default: a list of common ones' },
  records: { ...str, description: 'Optional saved records JSON (relative to --root) to audit offline instead of asking a resolver' },
  return_path: { ...str, description: 'Optional bounce (Return-Path) domain your mail provider uses, e.g. send.example.com; SPF is checked there' },
  resolver: { type: 'string', enum: ['cloudflare', 'google'], description: 'Public DNS-over-HTTPS resolver for live lookups (default cloudflare). Only domain names are sent.' },
  ignore: { type: 'array', items: str, description: 'Check ids to leave out, e.g. ["mta_sts_missing"]' },
  bimi_selector: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,63}$', description: 'BIMI selector to check (default "default")' },
};
const reportsProp = { type: 'array', items: str, minItems: 1, maxItems: 50, description: 'Saved DMARC aggregate reports (.xml, .xml.gz, .gz or .zip) or folders of them, relative to --root' };
const thresholdProp = { type: 'number', minimum: 50, maximum: 100, description: 'Percent of mail that must pass DMARC before the next enforcing stage (default 98)' };
/** Read and total saved DMARC aggregate reports. Offline. */
export function loadReports(paths, ctx, { domain = null, threshold = 98 } = {}) {
  const files = [];
  for (const p of paths) {
    const f = ctx.path(p); if (!existsSync(f)) throw new Error(`report not found: ${p}`);
    if (statSync(f).isDirectory()) { for (const n of readdirSync(f).sort()) if (/\.(xml|gz|zip)$/i.test(n) && statSync(join(f, n)).isFile()) files.push(join(f, n)); }
    else files.push(f);
  }
  if (!files.length) throw new Error('no .xml, .xml.gz, .gz or .zip DMARC reports found');
  if (files.length > 500) throw new Error('more than 500 report files; pass a narrower folder');
  const parsed = [];
  for (const f of files) for (const x of reportXmls(f, readFileSync(f))) parsed.push(parseAggregate(x, relative(ctx.root, f)));
  return { files: files.map((f) => relative(ctx.root, f).split('\\').join('/')), ...summarise(parsed, { domain, threshold }) };
}
const sourcesCsv = (s) => toCsv(s.sources.map((x) => ({ source_ip: x.source_ip, status: x.status, messages: x.messages, dmarc_pass: x.dmarc_pass, pass_rate: x.pass_rate, envelope_from: x.envelope_from.join(' '), dkim_domains: x.dkim_domains.join(' '), why: x.why.join(' | '), owner: '', status_note: '' })), ['source_ip', 'status', 'messages', 'dmarc_pass', 'pass_rate', 'envelope_from', 'dkim_domains', 'why', 'owner', 'status_note']);
function auditHtml(r, s) {
  const rows = r.findings.map((f) => `<tr><td class="${f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'mut'}">${escapeHtml(f.severity)}</td><td><code>${escapeHtml(f.check)}</code></td><td><code>${escapeHtml(f.record)}</code></td><td>${escapeHtml(f.detail)}${f.ref ? ` <span class="mut">(${escapeHtml(f.ref)})</span>` : ''}</td></tr>`).join('');
  const tiles = `<div class="tiles"><div class="tile"><b class="bad">${r.by_severity.error || 0}</b>errors</div><div class="tile"><b class="warn">${r.by_severity.warning || 0}</b>warnings</div><div class="tile"><b>${r.by_severity.advisory || 0}</b>advisories</div><div class="tile"><b>${r.spf_lookups ?? 'n/a'}/10</b>SPF lookups</div><div class="tile"><b>${escapeHtml(r.dmarc?.policy || 'none')}</b>DMARC policy</div>${s ? `<div class="tile"><b>${s.pass_rate ?? 'n/a'}%</b>DMARC pass in reports</div>` : ''}</div>`;
  const src = s ? `<h2>Senders in DMARC reports (${escapeHtml(s.period.from)} to ${escapeHtml(s.period.to)})</h2><div class="wrap"><table><tr><th>Source IP</th><th>Status</th><th>Messages</th><th>Pass %</th><th>What to do</th></tr>${s.sources.map((x) => `<tr><td><code>${escapeHtml(x.source_ip)}</code></td><td>${escapeHtml(x.status)}</td><td class="num">${x.messages}</td><td class="num">${x.pass_rate}</td><td>${escapeHtml(x.why.join(' '))}</td></tr>`).join('')}</table></div>` : '';
  return htmlPage({ title: `Mail DNS audit: ${r.domain}`, bodyHtml: `<h1>Mail DNS audit: ${escapeHtml(r.domain)}</h1><p class="mut">${r.issues} issue(s), ${r.queries} DNS queries.</p>${tiles}<h2>Findings</h2><div class="wrap"><table><tr><th>Severity</th><th>Check</th><th>Record</th><th>What it means</th></tr>${rows || '<tr><td colspan="4">none</td></tr>'}</table></div>${src}`, footer: r.limits });
}
export const resolverFor = (a, ctx) => {
  if (a.records) { const f = ctx.path(a.records); if (!existsSync(f)) throw new Error(`records file not found: ${a.records}`); return recordsResolver(JSON.parse(readFileSync(f, 'utf8'))); }
  return dohResolver(a.resolver || 'cloudflare');
};
const run = (a, ctx) => { if (!String(a.domain ?? '').trim()) throw new Error('domain is required'); return audit(a.domain, resolverFor(a, ctx), a); };
const source = (a) => (a.records ? `records file ${a.records}` : `DNS-over-HTTPS (${a.resolver || 'cloudflare'})`);

export const manifest = defineManifest({
  name: 'aeolus-of-mail',
  version: pkg.version,
  description: 'Audits a sending domain\'s SPF (with the 10-lookup count through every include), DMARC (policy, reports, external report authorisation), DKIM keys for the selectors you name, BIMI, MX, MTA-STS and TLS-RPT with read-only DNS-over-HTTPS lookups or a saved records file. Reads saved DMARC aggregate reports and message headers (alignment, ARC chain) offline. Explains each gap, pre-stages record changes and plans a staged DMARC rollout for a person. Changing DNS is one human click; Aeolus never edits DNS and never sends mail.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'aeolus_audit', kind: 'read', openWorld: true,
      description: 'Look up and check the domain\'s mail-authentication records. Each finding has a severity, the record it is about, what it means and the RFC. Read-only; with live lookups only domain names go to the public resolver.',
      inputSchema: { type: 'object', required: ['domain'], properties: props },
      handler: async (a, ctx) => { const r = await run(a, ctx); return { summary: `${r.domain}: ${r.issues} issue(s) (${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory); SPF lookups ${r.spf_lookups ?? 'n/a'} of 10; ${r.queries} DNS queries via ${source(a)}. A DNS check, not a deliverability guarantee.`, ...r }; },
    },
    {
      name: 'aeolus_write_report', kind: 'report', openWorld: true,
      description: 'Write mail-dns-audit.md, a self-contained mail-dns-audit.html (no scripts) and findings.csv (blank owner and status columns) into out_dir (default mythos-out/aeolus). With reports, also totals the DMARC aggregate reports into the report and dmarc-sources.csv. Returns output_sha256 of the Markdown report, which is written into the audit log.',
      inputSchema: { type: 'object', required: ['domain'], properties: { ...props, reports: reportsProp, out_dir: str } },
      handler: async (a, ctx) => {
        const r = await run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/aeolus');
        const s = a.reports ? loadReports(a.reports, ctx, { domain: r.domain }) : null;
        const csv = toCsv(r.findings.map((f) => ({ domain: r.domain, severity: f.severity, check: f.check, record: f.record, detail: f.detail, ref: f.ref || '', owner: '', status: '' })), ['domain', 'severity', 'check', 'record', 'detail', 'ref', 'owner', 'status']);
        let md = reportMarkdown(r);
        if (s) md += ['', `## Senders in DMARC reports (${s.period.from} to ${s.period.to})`, '', `${s.messages} message(s) in ${s.reports} report(s); ${s.pass_rate ?? 'n/a'}% pass DMARC. ${s.readiness.reason}`, '', '| Source IP | Status | Messages | Pass % | What to do |', '|---|---|---|---|---|', ...s.sources.map((x) => `| ${x.source_ip} | ${x.status} | ${x.messages} | ${x.pass_rate} | ${x.why.join(' ').replace(/\|/g, '\\|')} |`), ''].join('\n');
        const files = [ctx.writeFile(out, 'mail-dns-audit.md', md), ctx.writeFile(out, 'mail-dns-audit.html', auditHtml(r, s)), ctx.writeFile(out, 'findings.csv', csv)];
        if (s) files.push(ctx.writeFile(out, 'dmarc-sources.csv', sourcesCsv(s)));
        return { summary: `Report written for ${r.domain}: ${r.issues} issue(s)${s ? `; ${s.sources.length} sending source(s) from ${s.reports} DMARC report(s)` : ''}.`, files, output_sha256: sha256(safeMarkdown(md)) };
      },
    },
    {
      name: 'aeolus_dmarc_reports', kind: 'read', title: 'Read DMARC aggregate reports',
      description: 'Read saved DMARC aggregate (rua) reports offline: .xml, .xml.gz, .gz or .zip files, or folders of them. Totals messages by sending source IP with pass/fail, SPF and DKIM alignment, and for each failing source the likely reason and fix (unaligned Return-Path, DKIM signed by the service\'s own domain, or neither passing). Duplicate reports are counted once. Gives a readiness verdict for the next DMARC stage. No network.',
      inputSchema: { type: 'object', required: ['reports'], additionalProperties: false, properties: { reports: reportsProp, domain: { ...str, description: 'Only count mail whose From domain is this domain or a subdomain' }, pass_threshold: thresholdProp } },
      handler: async (a, ctx) => { const s = loadReports(a.reports, ctx, { domain: a.domain || null, threshold: a.pass_threshold ?? 98 }); return { summary: `${s.messages} message(s) in ${s.reports} report(s) from ${s.reporters.length} reporter(s) (${s.period.from} to ${s.period.to}); ${s.pass_rate ?? 'n/a'}% pass DMARC; ${s.failing_sources} of ${s.sources.length} source(s) fail some mail. ${s.readiness.reason}`, ...s }; },
    },
    {
      name: 'aeolus_check_headers', kind: 'read', title: 'Check message headers and ARC',
      description: 'Read a saved message (.eml) or its pasted headers offline: the SPF, DKIM and DMARC results the receiver recorded, whether the Return-Path and DKIM d= domains align with From, weak rsa-sha1 signatures, the DKIM selectors in use (to feed aeolus_audit), and the structure of any ARC chain (instances 1..n, complete sets, cv= values). Does not verify signatures.',
      inputSchema: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { ...str, description: 'Saved message source or headers (.eml or .txt), relative to --root' }, trusted_authserv: { ...str, description: 'Only trust Authentication-Results from this receiving server id, e.g. mx.example.org' } } },
      handler: async (a, ctx) => {
        if (!/\.(eml|txt|msg\.txt|headers)$/i.test(a.message)) throw new Error('message must be a .eml or .txt file with the message source or headers');
        const r = checkHeaders(ctx.readText(a.message), a);
        return { summary: `From ${r.from_domain || '(none)'}: receiver says spf=${r.receiver_results.spf || 'n/a'}, dkim=${r.receiver_results.dkim || 'n/a'}, dmarc=${r.receiver_results.dmarc || 'n/a'}; DKIM ${r.dkim_aligned ? 'aligned' : 'not aligned'}, SPF ${r.spf_aligned ? 'aligned' : 'not aligned'}; ${r.arc.sets} ARC set(s); ${r.issues} issue(s). Signatures are not verified.`, ...r };
      },
    },
    {
      name: 'aeolus_plan_dmarc_rollout', kind: 'write', title: 'Plan a staged DMARC rollout', openWorld: true,
      description: 'Write a staged DMARC rollout plan into out_dir: dmarc-rollout.md, dmarc-rollout.json, dmarc-rollout.ics (review dates with reminders) and dmarc-next-stage.json, a proposal for the next stage only in the same format aeolus_request_dns_change takes. Stages go none -> quarantine -> reject one step at a time with earliest dates; the plan never skips straight to reject. The next enforcing stage carries a [TO CONFIRM] marker unless the DMARC reports you pass show the readiness threshold is met, so the one-click request is refused until a person clears it. DNS is not changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['domain', 'start_date'], properties: { ...props, start_date: { type: 'string', format: 'date', description: 'Date of the first stage, YYYY-MM-DD' }, reports: reportsProp, pass_threshold: thresholdProp, config: { ...str, description: 'Optional rollout config JSON (stages, pass_threshold, reminder_days, owner); checked against the dmarc_rollout schema' }, rua: { ...str, description: 'Mailbox for DMARC reports if the record has none' }, out_dir: str } },
      handler: async (a, ctx) => {
        const r = await run(a, ctx);
        const config = a.config ? ctx.readJson(a.config, 'dmarc_rollout') : DEFAULT_ROLLOUT;
        const threshold = a.pass_threshold ?? config.pass_threshold ?? DEFAULT_ROLLOUT.pass_threshold;
        const s = a.reports ? loadReports(a.reports, ctx, { domain: r.domain, threshold }) : null;
        const p = planRollout(r, { start_date: a.start_date, config: { ...config, pass_threshold: threshold }, readiness: s ? s.readiness : null, rua: a.rua || '' });
        const out = ctx.outDir(a.out_dir || 'mythos-out/aeolus');
        const md = safeMarkdown(rolloutMarkdown(p));
        const ics = toIcs(p.stages.map((st) => ({ uid: `${r.domain}-dmarc-step-${st.step}@aeolus.local`, date: st.earliest_date, summary: `DMARC step ${st.step} for ${r.domain}: ${st.policy}${st.pct < 100 ? ` pct=${st.pct}` : ''}`, description: `${st.gate} Proposed: ${st.record}. A person approves the change (aeolus_request_dns_change).`, reminders: p.reminder_days, categories: ['DMARC'] })), { calName: `DMARC rollout ${r.domain}`, prodId: '-//Mythos Machine//aeolus-of-mail//EN' });
        const files = [ctx.writeFile(out, 'dmarc-rollout.md', md), ctx.writeFile(out, 'dmarc-rollout.json', JSON.stringify(p, null, 2) + '\n'), ctx.writeFile(out, 'dmarc-rollout.ics', ics)];
        let change = null; let changeSha = null;
        if (p.next_change) {
          const open = hasMarkers(p.next_change.note) ? 1 : 0;
          const proposal = { domain: r.domain, created_at: new Date().toISOString(), source: source(a), changes: [p.next_change], needs_person: open ? ['Read the DMARC aggregate reports and fix every real sender that fails before this stage; then remove the [TO CONFIRM] marker.'] : [], open_markers: open, note: 'Proposal for the next rollout stage only. A person makes the change at the DNS host.' };
          const text = JSON.stringify(proposal, null, 2) + '\n'; const pf = ctx.writeFile(out, 'dmarc-next-stage.json', text); files.push(pf);
          change = relative(ctx.root, pf).split('\\').join('/'); changeSha = sha256(text);
        }
        return { summary: p.done ? `${r.domain} is already at p=reject for all mail; nothing to stage.` : `${p.stages.length} stage(s) planned for ${r.domain} from ${a.start_date} (next: ${p.stages[0].policy}${p.stages[0].pct < 100 ? ` pct=${p.stages[0].pct}` : ''}); ${s ? s.readiness.reason : 'no reports given, so the next enforcing stage waits for them.'} DNS was not changed.`, plan: p, change, change_sha256: changeSha, files, output_sha256: sha256(safeMarkdown(md)) };
      },
    },
    {
      name: 'aeolus_draft_records', kind: 'write', openWorld: true,
      description: 'Pre-stage DNS record changes into out_dir: zone-change.md (current vs proposed) and proposed-records.json with its hash. Only safe, mechanical proposals: add SPF from the senders you list, merge duplicate SPF, fix the all term, add DMARC at p=none with reports, add TLS-RPT. Never creates DKIM keys or an enforcing DMARC policy; those are listed for a person. Unknown values are left as [TO CONFIRM] markers. DNS is not changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['domain'], properties: { ...props, senders: { type: 'array', items: str, description: 'SPF terms for services that send as you, e.g. ["include:_spf.google.com"]' }, rua: { ...str, description: 'Mailbox for DMARC/TLS reports, e.g. dmarc@example.com' }, out_dir: str } },
      handler: async (a, ctx) => {
        const r = await run(a, ctx); const d = draftChanges(r, a); const out = ctx.outDir(a.out_dir || 'mythos-out/aeolus');
        const proposal = { domain: r.domain, created_at: new Date().toISOString(), source: source(a), changes: d.changes, needs_person: d.needs_person, open_markers: d.open_markers, note: 'Proposal only. A person makes the change at the DNS host.' };
        const text = JSON.stringify(proposal, null, 2) + '\n'; const pf = ctx.writeFile(out, 'proposed-records.json', text);
        const L = [`# Proposed DNS changes for ${r.domain} (not applied)`, '', 'Suggested TTL 3600. Check each value with your mail provider before you add it.', ''];
        for (const c of d.changes) { L.push(`## ${c.action} ${c.type} ${c.name}`, '', `Why: ${c.why}`, '', 'Current:', '', ...(c.current.length ? c.current.map((x) => '    ' + x) : ['    (none)']), '', 'Proposed:', '', '    ' + c.proposed, ''); if (c.note) L.push(c.note, ''); }
        if (!d.changes.length) L.push('No mechanical record changes to propose.', '');
        L.push(`## Needs a person (${d.needs_person.length})`, '', ...d.needs_person.map((x) => `- ${x}`), '');
        const files = [ctx.writeFile(out, 'zone-change.md', L.join('\n')), pf];
        return { summary: `${d.changes.length} record change(s) staged, ${d.open_markers} with open [TO CONFIRM]/[CHECK MERGE] markers; ${d.needs_person.length} item(s) need a person. DNS was not changed.`, change: relative(ctx.root, pf).split('\\').join('/'), change_sha256: sha256(text), changes: d.changes, needs_person: d.needs_person, files };
      },
    },
    {
      name: 'aeolus_request_dns_change', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record that the staged record changes are approved in dns-change-requests.csv. The approval is tied to change_sha256, and it is refused while any [TO CONFIRM] or [CHECK MERGE] marker is left (edit the proposal, then ask again with its new hash). A person edits DNS at the registrar; Aeolus never does.',
      inputSchema: { type: 'object', required: ['change', 'change_sha256'], properties: { change: str, change_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const pf = ctx.path(a.change); if (!existsSync(pf)) throw new Error(`proposal not found: ${a.change}`);
        const text = readFileSync(pf, 'utf8'); if (sha256(text) !== a.change_sha256) throw new Error('change_sha256 does not match the proposal file; review the current file and ask again');
        const p = JSON.parse(text);
        if (!p.changes?.length) throw new Error('the proposal has no record changes');
        const open = p.changes.filter((c) => hasMarkers(c.proposed) || hasMarkers(c.note || ''));
        if (open.length) throw new Error(`${open.length} change(s) still have [TO CONFIRM] or [CHECK MERGE] markers (${open.map((c) => c.name).join(', ')}); fill them in or remove the change first`);
        const dir = ctx.outDir(a.out_dir || 'mythos-out/aeolus'); const f = join(dir, 'dns-change-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), domain: p.domain, change: a.change, change_sha256: a.change_sha256, records: p.changes.map((c) => `${c.action} ${c.type} ${c.name}`).join('; '), status: 'approved - a person edits DNS' }], ['requested_at', 'domain', 'change', 'change_sha256', 'records', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `DNS change approved and recorded for ${p.domain} (${p.changes.length} record(s)). DNS was not changed.`, file: f };
      },
    },
    { name: 'dns_update', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Aeolus never edits DNS at any registrar or DNS host.', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_test_email', kind: 'action', description: 'Listed so agents can see it is refused. Aeolus never sends mail.', inputSchema: { type: 'object', properties: {} } },
  ],
  configSchemas: { dmarc_rollout: ROLLOUT_SCHEMA },
  prompts: [{
    name: 'mail_dns_review', title: 'Review a sending domain end to end',
    description: 'Walks through auditing a domain\'s mail DNS, reading DMARC reports and message headers, staging fixes and planning DMARC enforcement, with the human clicks marked.',
    arguments: [
      { name: 'domain', description: 'Sending domain, e.g. example.com', required: true },
      { name: 'reports', description: 'Folder of saved DMARC aggregate reports under --root (optional)', required: false },
      { name: 'message', description: 'A saved message (.eml) sent from the domain (optional)', required: false },
      { name: 'start_date', description: 'First rollout date, YYYY-MM-DD (optional)', required: false },
    ],
    text: `Review mail authentication for {{domain}} with the Aeolus tools. Aeolus never edits DNS and never sends mail.

1. If a saved message is available ({{message}}), call aeolus_check_headers on it first. Note the DKIM selectors in use, whether SPF and DKIM align with the From domain, and any ARC problems.
2. Call aeolus_audit for {{domain}} with those selectors (and return_path if the provider uses its own bounce domain). List errors first. Do not claim deliverability; this is a DNS check.
3. If DMARC reports are available ({{reports}}), call aeolus_dmarc_reports with domain {{domain}}. For each failing source, say whether it looks like a real sender to fix (and the fix given) or unknown traffic. Do not guess who owns an IP address.
4. Call aeolus_write_report (with reports if you have them) so the person has the Markdown, HTML and CSV files.
5. Ask the person before calling aeolus_draft_records (it needs their yes). Fill in [TO CONFIRM] values only with facts the person gives you.
6. If DMARC is not at p=reject, offer aeolus_plan_dmarc_rollout with start_date {{start_date}} and the reports. Explain that it moves one stage at a time and never skips to reject.
7. Applying any record change is aeolus_request_dns_change with the change and change_sha256. It is a production deploy: a named person must approve it with one click, even in Auto, and it is refused while [TO CONFIRM] or [CHECK MERGE] markers remain. A person then edits DNS at the DNS host.`,
  }],
  policy: { rules: [
    { tool: 'aeolus_audit', decision: 'allow' },
    { tool: 'aeolus_write_report', decision: 'allow' },
    { tool: 'aeolus_dmarc_reports', decision: 'allow' },
    { tool: 'aeolus_check_headers', decision: 'allow' },
    { tool: 'aeolus_draft_records', decision: 'ask', reason: 'Staging DNS changes needs a human yes (or an Auto opt-in).' },
    { tool: 'aeolus_plan_dmarc_rollout', decision: 'ask', reason: 'Staging a DMARC rollout needs a human yes (or an Auto opt-in).' },
    { tool: 'dns_update', decision: 'block', reason: 'Aeolus never edits DNS. A person makes the change.' },
    { tool: 'send_test_email', decision: 'block', reason: 'Aeolus never sends mail.' },
    { tool: 'aeolus_request_dns_change', decision: 'ask', reason: 'Changing DNS is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Aeolus allowlist.' },
  ] },
});
