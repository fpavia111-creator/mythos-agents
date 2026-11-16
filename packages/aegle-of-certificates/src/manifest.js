import { defineManifest, toCsv, sha256, uniqueNames } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scan, reportMarkdown, reportHtml, calendarIcs, chaseDraft, expiryCsv, slug, diffInventory, reminderOffsets, pick } from './certs.js';
import { extractCoiText, EXTRACT_COLUMNS } from './coi-text.js';
import { liveTlsCheck, liveCsv, parseTarget, MAX_HOSTS, HOST_RE } from './live-tls.js';
import { COI_REQUIREMENTS_SCHEMA } from './schemas.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  certificates: { ...str, description: 'Inventory CSV/JSON: id, type (tls|domain|license|other), name, holder, issuer, expires (YYYY-MM-DD), auto_renew, renewal_cost, owner, key_type, key_bits, signature, registrar_lock' },
  cois: { ...str, description: 'Vendor certificate-of-insurance CSV/JSON: vendor, coverage, limit, expires, additional_insured, certificate_id' },
  requirements: { ...str, description: 'Your written COI requirements: a CSV (coverage, min_limit, additional_insured, waiver_of_subrogation) or a .json requirement profile (default list, per-category lists, vendor→category map; checked against the coi_requirements schema)' },
  as_of: { ...str, pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (default today)' }, critical_days: { ...num, minimum: 0 }, warn_days: { ...num, minimum: 0 }, upcoming_days: { ...num, minimum: 0 },
};
const reminderDays = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 365 }, maxItems: 6, description: 'Calendar reminder offsets in days before each expiry (default: warn_days, critical_days and 1)' };
const loadReqs = (a, ctx) => (!a.requirements ? [] : /\.json$/i.test(a.requirements) ? ctx.readJson(a.requirements, 'coi_requirements') : ctx.records(a.requirements));
const run = (a, ctx) => {
  if (!a.certificates && !a.cois) throw new Error('give certificates and/or cois');
  return scan({ ...a, inventory: a.certificates ? ctx.records(a.certificates) : [], cois: a.cois ? ctx.records(a.cois) : [], requirements: loadReqs(a, ctx) });
};
const need = (a, ...ks) => { for (const k of ks) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`); };
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  sources: SOURCES,
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
      name: 'aegle_write_report', kind: 'report', title: 'Write expiry report',
      description: 'Write expiry-report.md, expiry-report.html (self-contained, no scripts), expiry.csv (blank reviewer columns) and renewals.ics (calendar reminders at warn_days, critical_days and 1 day before, or reminder_days) into out_dir (default mythos-out/aegle). The output hash goes into the audit line.',
      inputSchema: { type: 'object', properties: { ...props, reminder_days: reminderDays, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/aegle');
        const docs = { 'expiry-report.md': reportMarkdown(r), 'expiry.csv': expiryCsv(r), 'renewals.ics': calendarIcs(r, a.reminder_days), 'expiry-report.html': reportHtml(r) };
        const files = Object.entries(docs).map(([n, t]) => ctx.writeFile(out, n, t));
        return { summary: `Report (md, html), CSV and calendar written for ${r.items.length} item(s) and ${r.vendors.length} vendor(s); reminders ${reminderOffsets(r, a.reminder_days).join('/')} days before.`, files, output_sha256: sha256(Object.entries(docs).map(([n, t]) => `${n}:${sha256(t)}`).join('\n')) };
      },
    },
    {
      name: 'aegle_diff_inventory', kind: 'read', title: 'Compare inventory snapshots',
      description: 'Compare a previous inventory export with the current one: renewed, added, removed, expiry moved earlier, auto-renew turned off, owner changed or removed, new weak-key or lock flags, status worse. Riskiest changes first.',
      inputSchema: { type: 'object', required: ['previous', 'certificates'], properties: { previous: { ...str, description: 'The earlier inventory CSV/JSON' }, certificates: props.certificates, as_of: props.as_of, critical_days: props.critical_days, warn_days: props.warn_days, upcoming_days: props.upcoming_days } },
      handler: async (a, ctx) => {
        const d = diffInventory(ctx.records(a.previous), ctx.records(a.certificates), a);
        return { summary: `${d.changes.length} change(s) between ${d.previous_items} and ${d.current_items} item(s): ${Object.entries(d.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`, ...d };
      },
    },
    {
      name: 'aegle_extract_coi', kind: 'report', title: 'Extract COI fields from text',
      description: 'Best-effort extraction of insured, coverages, limits, policy dates, additional insured and waiver of subrogation from text exported from ACORD 25-style certificates (for example pdftotext output; no PDF parsing or OCR). Writes coi-extracted.csv in the COI column layout with needs_review=yes on every row and the source line. A person checks it against the certificate before using it.',
      inputSchema: { type: 'object', required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1 }, description: 'Text files under --root, one per certificate' }, out_dir: str } },
      handler: async (a, ctx) => {
        const docs = a.files.map((f) => extractCoiText(ctx.readText(f), { source: basename(f) }));
        const rows = docs.flatMap((d) => d.rows.map((r) => ({ ...r, warnings: r.warnings.join('; '), reviewed_by: '' })));
        const csv = toCsv(rows, EXTRACT_COLUMNS); const out = ctx.outDir(a.out_dir || 'mythos-out/aegle');
        const file = ctx.writeFile(out, 'coi-extracted.csv', csv);
        const warn = docs.reduce((t, d) => t + d.warnings.length, 0);
        return { summary: `${rows.length} coverage row(s) extracted from ${docs.length} file(s), all marked needs_review; ${warn} warning(s).`, documents: docs, file, output_sha256: sha256(csv) };
      },
    },
    {
      name: 'aegle_tls_live_check', kind: 'write', openWorld: true, title: 'Live TLS expiry check (opt-in, network)',
      description: `Opt-in network check. For each listed host (at most ${MAX_HOSTS}), open one TLS handshake, read the presented certificate (expiry, issuer, SAN, key, chain trust, hostname match) and close. Sends no application data and changes nothing. Compares the result with your inventory (inventory_mismatch, not_in_inventory) and writes live-tls.csv. Needs a human yes each time unless opted in to Auto; blocked in review mode.`,
      inputSchema: { type: 'object', properties: { hosts: { type: 'array', maxItems: MAX_HOSTS, items: { type: 'string', pattern: HOST_RE.source }, description: 'host or host:port (default port 443)' }, certificates: { ...props.certificates, description: 'Inventory CSV/JSON to compare with (and the host list when from_inventory is true; TLS rows: name, optional port)' }, from_inventory: { type: 'boolean', description: 'Check every TLS row in the inventory' }, as_of: props.as_of, critical_days: props.critical_days, warn_days: props.warn_days, upcoming_days: props.upcoming_days, timeout_ms: { type: 'integer', minimum: 500, maximum: 20000 }, out_dir: str } },
      handler: async (a, ctx) => {
        const inventory = a.certificates ? ctx.records(a.certificates) : [];
        const targets = (a.hosts || []).map((h) => parseTarget(h));
        if (a.from_inventory) {
          if (!a.certificates) throw new Error('from_inventory needs certificates');
          for (const r of inventory) if ((pick(r, 'type', 'kind', 'category') || '').toLowerCase() === 'tls') { const n = pick(r, 'name', 'common_name', 'cn', 'domain', 'host'); if (n) targets.push(parseTarget(n, Number(pick(r, 'port')) || 443)); }
        }
        if (!targets.length) throw new Error('give hosts, or certificates with from_inventory: true');
        const r = await liveTlsCheck(targets, { ...a, inventory, timeoutMs: a.timeout_ms });
        const csv = liveCsv(r); const file = ctx.writeFile(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'live-tls.csv', csv);
        return { summary: `${r.checked} host(s) checked live (${r.reachable} reachable); ${r.rows.filter((x) => ['expired', 'critical'].includes(x.status)).length} expired or critical; ${r.mismatches} inventory mismatch(es). Read-only handshakes; nothing was changed.`, ...r, file, output_sha256: sha256(csv) };
      },
    },
    {
      name: 'aegle_draft_chase', kind: 'write',
      description: 'Write one chase email draft per vendor with COI gaps into out_dir/chase-drafts (marked DRAFT, not sent). Needs a human yes unless opted in to Auto. Nothing is sent.',
      inputSchema: { type: 'object', required: ['cois'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/aegle'), 'chase-drafts'); mkdirSync(dir, { recursive: true });
        const unique = uniqueNames();
        const files = r.vendors.filter((v) => v.gaps.length).map((v) => ctx.writeFile(dir, unique(`${slug(v.vendor)}.md`), chaseDraft(v)));
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
  configSchemas: { coi_requirements: COI_REQUIREMENTS_SCHEMA },
  prompts: [
    {
      name: 'aegle_renewal_review', title: 'Renewal and COI review',
      description: 'Walk through a full expiry and certificate-of-insurance review: scan, compare with last time, optional live TLS check, report, chase drafts, and the one-click steps a person takes.',
      arguments: [
        { name: 'certificates', description: 'Inventory CSV/JSON under --root', required: true },
        { name: 'cois', description: 'Vendor COI CSV/JSON (optional)', required: false },
        { name: 'requirements', description: 'Requirement CSV or .json profile (optional)', required: false },
        { name: 'previous', description: 'Last review\'s inventory export, for the change list (optional)', required: false },
        { name: 'as_of', description: 'YYYY-MM-DD (optional, default today)', required: false },
      ],
      text: [
        'You are running a renewal and COI review with the aegle-of-certificates tools. Inventory: {{certificates}}. COIs: {{cois}}. Requirements: {{requirements}}. Previous inventory: {{previous}}. As of: {{as_of}}. Leave out any argument shown in [brackets].',
        '1. If the requirements file ends in .json, run `aegle-of-certificates validate-config coi_requirements <file>` first or expect a JSON-pointer error from the tools; fix typos before going on.',
        '2. Call aegle_scan with certificates, cois, requirements and as_of. Read items in order: expired, critical, no_expiry_date, warning. For each, note the flags (weak_key_*, weak_signature, self_signed, registrar_lock_off, auto_renew_off, no_owner) and next_step.',
        '3. If a previous inventory is given, call aegle_diff_inventory (previous, certificates). Treat expiry_moved_earlier, auto_renew_turned_off and removed as questions for the owner, not as facts.',
        '4. If the owner wants live confirmation, ask them first: aegle_tls_live_check opens network connections. Call it with hosts or from_inventory: true; it returns needs_approval until a named person approves. Report inventory_mismatch, hostname_mismatch and chain_untrusted rows. Skip this step in review mode.',
        '5. If vendors sent certificates as PDFs, have the text exported (e.g. pdftotext -layout) and call aegle_extract_coi. Every row is needs_review: a person compares it with the certificate before it is used as a COI file.',
        '6. Call aegle_write_report (add reminder_days if the owner wants different calendar alerts). Give the person the paths of expiry-report.html, expiry.csv and renewals.ics.',
        '7. Call aegle_draft_chase for vendors with gaps. Drafts are not sent. A person reads each draft.',
        '8. Human clicks: sending a chase (aegle_request_chase_send), paying for a renewal (aegle_request_renewal) and installing a certificate (aegle_request_production_change) are one named human click each, even in Auto. Never try purchase_renewal, deploy_certificate or send_email: they are blocked.',
        'Say clearly that this is a check against the owner\'s own records and written requirements, not insurance or legal advice.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'aegle_scan', decision: 'allow' },
    { tool: 'aegle_write_report', decision: 'allow' },
    { tool: 'aegle_diff_inventory', decision: 'allow' },
    { tool: 'aegle_extract_coi', decision: 'allow' },
    { tool: 'aegle_tls_live_check', decision: 'ask', reason: 'Opens network connections to the hosts you list: needs a human yes each time (or an Auto opt-in). Blocked in review mode.' },
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
