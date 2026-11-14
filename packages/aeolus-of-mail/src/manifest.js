import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { audit, draftChanges, reportMarkdown, recordsResolver, dohResolver, hasMarkers } from './mail.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  domain: { ...str, description: 'Sending domain to audit, e.g. example.com or send.example.com' },
  selectors: { type: 'array', items: str, description: 'DKIM selectors to check (the s= tag in a sent message). Default: a list of common ones' },
  records: { ...str, description: 'Optional saved records JSON (relative to --root) to audit offline instead of asking a resolver' },
  return_path: { ...str, description: 'Optional bounce (Return-Path) domain your mail provider uses, e.g. send.example.com; SPF is checked there' },
  resolver: { type: 'string', enum: ['cloudflare', 'google'], description: 'Public DNS-over-HTTPS resolver for live lookups (default cloudflare). Only domain names are sent.' },
  ignore: { type: 'array', items: str, description: 'Check ids to leave out, e.g. ["mta_sts_missing"]' },
};
export const resolverFor = (a, ctx) => {
  if (a.records) { const f = ctx.path(a.records); if (!existsSync(f)) throw new Error(`records file not found: ${a.records}`); return recordsResolver(JSON.parse(readFileSync(f, 'utf8'))); }
  return dohResolver(a.resolver || 'cloudflare');
};
const run = (a, ctx) => { if (!String(a.domain ?? '').trim()) throw new Error('domain is required'); return audit(a.domain, resolverFor(a, ctx), a); };
const source = (a) => (a.records ? `records file ${a.records}` : `DNS-over-HTTPS (${a.resolver || 'cloudflare'})`);

export const manifest = defineManifest({
  name: 'aeolus-of-mail',
  version: pkg.version,
  description: 'Audits a sending domain\'s SPF (with the 10-lookup count through every include), DMARC (policy, reports, external report authorisation), DKIM keys for the selectors you name, MX, MTA-STS and TLS-RPT with read-only DNS-over-HTTPS lookups or a saved records file. Explains each gap and pre-stages record changes for a person. Changing DNS is one human click; Aeolus never edits DNS and never sends mail.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'aeolus_audit', kind: 'read',
      description: 'Look up and check the domain\'s mail-authentication records. Each finding has a severity, the record it is about, what it means and the RFC. Read-only; with live lookups only domain names go to the public resolver.',
      inputSchema: { type: 'object', required: ['domain'], properties: props },
      handler: async (a, ctx) => { const r = await run(a, ctx); return { summary: `${r.domain}: ${r.issues} issue(s) (${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory); SPF lookups ${r.spf_lookups ?? 'n/a'} of 10; ${r.queries} DNS queries via ${source(a)}. A DNS check, not a deliverability guarantee.`, ...r }; },
    },
    {
      name: 'aeolus_write_report', kind: 'report',
      description: 'Write mail-dns-audit.md and findings.csv (blank owner and status columns) into out_dir (default mythos-out/aeolus).',
      inputSchema: { type: 'object', required: ['domain'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = await run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/aeolus');
        const csv = toCsv(r.findings.map((f) => ({ domain: r.domain, severity: f.severity, check: f.check, record: f.record, detail: f.detail, ref: f.ref || '', owner: '', status: '' })), ['domain', 'severity', 'check', 'record', 'detail', 'ref', 'owner', 'status']);
        return { summary: `Report written for ${r.domain}: ${r.issues} issue(s).`, files: [ctx.writeFile(out, 'mail-dns-audit.md', reportMarkdown(r)), ctx.writeFile(out, 'findings.csv', csv)] };
      },
    },
    {
      name: 'aeolus_draft_records', kind: 'write',
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
  policy: { rules: [
    { tool: 'aeolus_audit', decision: 'allow' },
    { tool: 'aeolus_write_report', decision: 'allow' },
    { tool: 'aeolus_draft_records', decision: 'ask', reason: 'Staging DNS changes needs a human yes (or an Auto opt-in).' },
    { tool: 'dns_update', decision: 'block', reason: 'Aeolus never edits DNS. A person makes the change.' },
    { tool: 'send_test_email', decision: 'block', reason: 'Aeolus never sends mail.' },
    { tool: 'aeolus_request_dns_change', decision: 'ask', reason: 'Changing DNS is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Aeolus allowlist.' },
  ] },
});
