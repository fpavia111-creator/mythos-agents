import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scan, reportMarkdown, calendarIcs, chaseDraft, expiryCsv, slug } from './certs.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  certificates: { ...str, description: 'Inventory CSV/JSON: id, type (tls|domain|license|other), name, holder, issuer, expires (YYYY-MM-DD), auto_renew, renewal_cost, owner, key_type, key_bits, signature, registrar_lock' },
  cois: { ...str, description: 'Vendor certificate-of-insurance CSV/JSON: vendor, coverage, limit, expires, additional_insured, certificate_id' },
  requirements: { ...str, description: 'Your written COI requirements CSV/JSON: coverage, min_limit, additional_insured' },
  as_of: { ...str, description: 'YYYY-MM-DD (default today)' }, critical_days: num, warn_days: num, upcoming_days: num,
};
const run = (a, ctx) => {
  if (!a.certificates && !a.cois) throw new Error('give certificates and/or cois');
  return scan({ ...a, inventory: a.certificates ? ctx.records(a.certificates) : [], cois: a.cois ? ctx.records(a.cois) : [], requirements: a.requirements ? ctx.records(a.requirements) : [] });
};
const need = (a, ...ks) => { for (const k of ks) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`); };
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'aegle-of-certificates',
  version: pkg.version,
  description: 'Expiry tracking for TLS certificates, domains, licences and vendor certificates of insurance (COIs) from CSV inventories. Flags weak or self-signed certificates, auto-renew and registrar-lock gaps, and COI gaps against your written requirements. Writes a report and a calendar file and drafts chase emails. Paid renewals, production changes and sends are each one human click; it never buys, deploys or sends.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'aegle_scan', kind: 'read',
      description: 'List every certificate, domain or licence by days left (expired, critical, warning, upcoming, ok) with flags and a next step, and check vendor COIs against your requirement list.',
      inputSchema: { type: 'object', properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); const c = r.counts; return { summary: `${r.items.length} item(s): expired ${c.expired}, critical ${c.critical}, warning ${c.warning}, upcoming ${c.upcoming}, ok ${c.ok}; ${r.vendors.length} vendor COI set(s), ${r.vendors_with_gaps} with gaps.`, ...r }; },
    },
    {
      name: 'aegle_write_report', kind: 'report',
      description: 'Write expiry-report.md, expiry.csv (blank reviewer columns) and renewals.ics (calendar reminders) into out_dir (default mythos-out/aegle).',
      inputSchema: { type: 'object', properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/aegle');
        return { summary: `Report, CSV and calendar written for ${r.items.length} item(s) and ${r.vendors.length} vendor(s).`, files: [ctx.writeFile(out, 'expiry-report.md', reportMarkdown(r)), ctx.writeFile(out, 'expiry.csv', expiryCsv(r)), ctx.writeFile(out, 'renewals.ics', calendarIcs(r))] };
      },
    },
    {
      name: 'aegle_draft_chase', kind: 'write',
      description: 'Write one chase email draft per vendor with COI gaps into out_dir/chase-drafts (marked DRAFT, not sent). Needs a human yes unless opted in to Auto. Nothing is sent.',
      inputSchema: { type: 'object', required: ['cois'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'chase-drafts'); mkdirSync(dir, { recursive: true });
        const files = r.vendors.filter((v) => v.gaps.length).map((v) => ctx.writeFile(dir, `${slug(v.vendor)}.md`, chaseDraft(v)));
        return { summary: `${files.length} chase draft(s) written. Nothing was sent.`, files };
      },
    },
    {
      name: 'aegle_request_chase_send', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record that a chase draft is approved to send in send-requests.csv. A person sends it from their own mail; Aegle never sends.',
      inputSchema: { type: 'object', required: ['vendor', 'draft', 'to'], properties: { vendor: str, draft: { ...str, description: 'Path of the reviewed draft' }, to: str, out_dir: str } },
      handler: async (a, ctx) => {
        need(a, 'vendor', 'draft', 'to'); if (!existsSync(ctx.path(a.draft))) throw new Error(`draft not found: ${a.draft}`);
        const f = appendRow(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'send-requests.csv', { requested_at: new Date().toISOString(), vendor: a.vendor, to: a.to, draft: a.draft, status: 'approved - a person sends it' }, ['requested_at', 'vendor', 'to', 'draft', 'status']);
        return { summary: `Send approved and recorded for ${a.vendor}. Nothing was sent.`, file: f };
      },
    },
    {
      name: 'aegle_request_renewal', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record an approved paid renewal (domain, certificate, licence) in renewal-requests.csv for the person who holds the card. Aegle never buys anything.',
      inputSchema: { type: 'object', required: ['id', 'cost', 'reason'], properties: { id: str, cost: num, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        need(a, 'id', 'reason'); if (!(Number(a.cost) >= 0)) throw new Error('cost must be a number');
        const f = appendRow(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'renewal-requests.csv', { requested_at: new Date().toISOString(), id: a.id, cost: Number(a.cost).toFixed(2), reason: a.reason, status: 'approved request - a person pays' }, ['requested_at', 'id', 'cost', 'reason', 'status']);
        return { summary: `Renewal request recorded for ${a.id}. Nothing was paid.`, file: f };
      },
    },
    {
      name: 'aegle_request_production_change', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record an approved production change (install or rotate a certificate) in change-requests.csv for your change process. Aegle never touches a server.',
      inputSchema: { type: 'object', required: ['id', 'change'], properties: { id: str, change: str, window: str, out_dir: str } },
      handler: async (a, ctx) => {
        need(a, 'id', 'change');
        const f = appendRow(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'change-requests.csv', { requested_at: new Date().toISOString(), id: a.id, change: a.change, window: a.window || '', status: 'approved request - your change process applies it' }, ['requested_at', 'id', 'change', 'window', 'status']);
        return { summary: `Production change request recorded for ${a.id}. No system was changed.`, file: f };
      },
    },
    { name: 'purchase_renewal', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Aegle never pays a registrar, CA or broker.', inputSchema: { type: 'object', properties: {} } },
    { name: 'deploy_certificate', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Aegle never installs certificates.', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Aegle never sends email.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'aegle_scan', decision: 'allow' },
    { tool: 'aegle_write_report', decision: 'allow' },
    { tool: 'aegle_draft_chase', decision: 'ask', reason: 'Writing chase drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'purchase_renewal', decision: 'block', reason: 'Aegle never pays for renewals.' },
    { tool: 'deploy_certificate', decision: 'block', reason: 'Aegle never changes production systems.' },
    { tool: 'send_email', decision: 'block', reason: 'Aegle never sends email.' },
    { tool: 'aegle_request_chase_send', decision: 'ask', reason: 'A vendor-facing send is one named human click, even in Auto.' },
    { tool: 'aegle_request_renewal', decision: 'ask', reason: 'A renewal that costs money is one named human click, even in Auto.' },
    { tool: 'aegle_request_production_change', decision: 'ask', reason: 'A production change is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Aegle allowlist.' },
  ] },
});
