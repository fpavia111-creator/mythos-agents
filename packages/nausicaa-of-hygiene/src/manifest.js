import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { normContacts, audit, cleanupCsv, consentProvenance } from './hygiene.js';
import { mergePlan, mergeCsv } from './merge.js';
import { compareAudits } from './compare.js';
import { checkDomains, dohResolver, recordsResolver, RESOLVERS } from './mx.js';
import { HYGIENE_RULES_SCHEMA } from './schemas.js';
import { PROMPTS } from './prompts.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = { contacts: { ...str, description: 'Contact export CSV/JSON: id, email, name, company, last_activity, bounce, consent, consent_date, consent_source, unsubscribed, status' }, suppression: { ...str, description: 'Optional suppression list CSV/JSON (email or domain column)' }, as_of: str, stale_days: { type: 'number' }, reconsent_days: { type: 'number' }, rules: { ...str, description: 'Optional hygiene rules JSON (extra role/disposable/typo lists, allowed consent sources, stale/reconsent days); validated against the hygiene_rules schema' } };
const loadRules = (a, ctx) => (a.rules ? ctx.readJson(a.rules, 'hygiene_rules') : {});
const suppressionList = (a, ctx) => (a.suppression ? ctx.records(a.suppression).map((r) => String(r.email || r.domain || Object.values(r)[0] || '').trim()).filter(Boolean) : []);
const auditOpts = (a, ctx, asOf = a.as_of) => ({ ...a, as_of: asOf, suppression: suppressionList(a, ctx), rules: loadRules(a, ctx) });
const run = (a, ctx, file = a.contacts, asOf = a.as_of) => audit(normContacts(ctx.records(file)), auditOpts(a, ctx, asOf));

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'nausicaa-of-hygiene',
  version: pkg.version,
  description: 'CRM and contact-list hygiene from exports: invalid and typo emails, hard bounces, role and disposable addresses, duplicates, stale records, missing or conflicting consent. Writes a review sheet and a do-not-email copy. Bulk deletes are always one human click and only record a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { hygiene_rules: HYGIENE_RULES_SCHEMA },
  prompts: PROMPTS,
  tools: [
    {
      name: 'nausicaa_audit', kind: 'read',
      description: 'Flag each contact and suggest keep, fix, merge, suppress, re-permission, review or delete candidate.',
      inputSchema: { type: 'object', required: ['contacts'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.contacts} contact(s), health ${r.health.score}/100: keep ${r.keep}, suppress ${r.suppress}, merge ${r.merge}, fix ${r.fix}, re-permission ${r.re_permission}, review ${r.review}, delete candidates ${r.delete_candidates}.`, ...r }; },
    },
    {
      name: 'nausicaa_write_cleanup', kind: 'report',
      description: 'Write hygiene-review.csv (blank reviewer columns) and suppression-additions.csv into out_dir (default mythos-out/nausicaa).',
      inputSchema: { type: 'object', required: ['contacts'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/nausicaa');
        const add = toCsv(r.items.filter((i) => ['suppress', 'delete_candidate'].includes(i.suggested_action) && i.email).map((i) => ({ email: i.email.toLowerCase(), reason: i.flags.filter((f) => /bounce|invalid|suppression|consent|unsub/.test(f)).join('; ') })), ['email', 'reason']);
        return { summary: `Cleanup files written: ${r.contacts - r.keep} contact(s) to review.`, files: [ctx.writeFile(out, 'hygiene-review.csv', cleanupCsv(r)), ctx.writeFile(out, 'suppression-additions.csv', add)] };
      },
    },
    {
      name: 'nausicaa_write_clean_copy', kind: 'write',
      description: 'Write <name>.clean.csv: a copy with hygiene_flags, suggested_action and do_not_email columns added. Rows are never removed and the input is never changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['contacts'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const raw = ctx.records(a.contacts); const out = ctx.outDir(a.out_dir || 'mythos-out/nausicaa');
        const cols = [...Object.keys(raw[0] || {}), 'hygiene_flags', 'suggested_action', 'do_not_email'];
        const rows = raw.map((x, i) => ({ ...x, hygiene_flags: r.items[i].flags.join('; '), suggested_action: r.items[i].suggested_action, do_not_email: ['suppress', 'delete_candidate'].includes(r.items[i].suggested_action) ? 'yes' : '' }));
        return { summary: `Clean copy written with all ${rows.length} row(s) kept; ${rows.filter((x) => x.do_not_email).length} marked do-not-email.`, file: ctx.writeFile(out, `${basename(a.contacts, extname(a.contacts))}.clean.csv`, toCsv(rows, cols)) };
      },
    },
    {
      name: 'nausicaa_merge_plan', kind: 'report', title: 'Merge suggestions for duplicates',
      description: 'For each group of duplicates (same canonical email): suggest a survivor and a winning value for each field, each with the rule that decided it. Opt-outs and hard bounces always carry over. Writes merge-plan.csv (blank reviewer columns) into out_dir (default mythos-out/nausicaa). Nothing is merged in your CRM.',
      inputSchema: { type: 'object', required: ['contacts'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const contacts = normContacts(ctx.records(a.contacts)); const r = audit(contacts, auditOpts(a, ctx)); const p = mergePlan(contacts, r.items);
        const out = ctx.outDir(a.out_dir || 'mythos-out/nausicaa');
        return { summary: `${p.groups} duplicate group(s); ${p.contacts_merged_away} record(s) would merge into a survivor.`, ...p, file: ctx.writeFile(out, 'merge-plan.csv', mergeCsv(p)) };
      },
    },
    {
      name: 'nausicaa_consent_provenance', kind: 'read', title: 'Consent provenance check',
      description: 'For contacts that are opted in or subscribed, check the consent record has a source and a valid date (not in the future), and, if your rules list allowed sources, that the source is one of them. Not legal advice on what consent you need.',
      inputSchema: { type: 'object', required: ['contacts'], properties: { contacts: props.contacts, as_of: str, rules: props.rules } },
      handler: async (a, ctx) => {
        const rules = loadRules(a, ctx); const r = consentProvenance(normContacts(ctx.records(a.contacts)), { as_of: a.as_of, allowed_sources: rules.allowed_consent_sources });
        return { summary: `${r.in_scope} opted-in contact(s): ${r.complete} with source and date; ${r.source_missing} without a source, ${r.date_missing} without a date, ${r.date_invalid + r.date_in_future} with an unusable date${rules.allowed_consent_sources ? `, ${r.source_not_allowed} from a source not on your list` : ''}.`, ...r };
      },
    },
    {
      name: 'nausicaa_compare', kind: 'read', title: 'Compare with the previous export',
      description: 'Period-over-period: audit the previous export and the current one and report the health score change, contacts added and removed, contacts newly flagged (e.g. bounced or unsubscribed since), contacts whose issues were resolved, and suggested-action changes.',
      inputSchema: { type: 'object', required: ['previous', 'contacts'], properties: { ...props, previous: { ...str, description: 'The earlier contact export' }, previous_as_of: { ...str, description: 'Date for the earlier audit (default: as_of)' } } },
      handler: async (a, ctx) => {
        const r = compareAudits(run(a, ctx, a.previous, a.previous_as_of || a.as_of), run(a, ctx));
        return { summary: `Health ${r.previous.health} -> ${r.current.health} (${r.health_change >= 0 ? '+' : ''}${r.health_change}); ${r.added} added, ${r.removed} removed, ${r.newly_flagged} newly flagged, ${r.improved} improved.`, ...r };
      },
    },
    {
      name: 'nausicaa_check_mx', kind: 'write', title: 'Opt-in MX check (DNS)', openWorld: true,
      description: 'Opt-in: check that each email domain in the export can receive mail (MX record, or an A record fallback; null MX and missing domains flagged). Offline with a saved records file, or live with allow_network:true, which sends domain names only (never addresses) to one allowlisted DNS-over-HTTPS resolver (cloudflare or google). Writes mx-check.csv. Needs a human yes unless opted in to Auto; blocked in review mode. Not a mailbox verification.',
      inputSchema: { type: 'object', required: ['contacts'], properties: { contacts: props.contacts, records: { ...str, description: 'Saved DNS records JSON for an offline check: {"example.com":{"MX":["10 mx.example.com."]}}' }, allow_network: { type: 'boolean', description: 'Must be true for live lookups (default false)' }, resolver: { type: 'string', enum: Object.keys(RESOLVERS) }, max_domains: { type: 'integer', minimum: 1, maximum: 500 }, out_dir: str } },
      handler: async (a, ctx) => {
        let resolver; let source;
        if (a.records) { resolver = recordsResolver(ctx.readJson(a.records)); source = `records file ${a.records}`; }
        else if (a.allow_network === true) { resolver = dohResolver(a.resolver || 'cloudflare'); source = `DNS-over-HTTPS (${a.resolver || 'cloudflare'}); domain names only`; }
        else throw new Error('No lookup source. Pass "records" (a saved records file, offline) or allow_network:true to query a public DNS-over-HTTPS resolver with domain names only. Off by default.');
        const contacts = normContacts(ctx.records(a.contacts));
        const byDomain = new Map(); for (const c of contacts) { const d = c.email.toLowerCase().split('@')[1]; if (d && c.email.includes('@')) byDomain.set(d, [...(byDomain.get(d) || []), c.id]); }
        const r = await checkDomains([...byDomain.keys()], resolver, { maxDomains: a.max_domains || 50 });
        const results = r.results.map((x) => ({ ...x, contacts: byDomain.get(x.domain)?.length || 0, contact_ids: byDomain.get(x.domain) || [] }));
        const bad = results.filter((x) => ['domain_not_found', 'no_mail_host', 'invalid_domain'].includes(x.status));
        const out = ctx.outDir(a.out_dir || 'mythos-out/nausicaa');
        const file = ctx.writeFile(out, 'mx-check.csv', toCsv(results.map((x) => ({ domain: x.domain, status: x.status, mx: x.mx.join('; '), contacts: x.contacts, contact_ids: x.contact_ids.join('; ') })), ['domain', 'status', 'mx', 'contacts', 'contact_ids']));
        return { summary: `${r.checked} of ${r.domains} domain(s) checked via ${source}: ${bad.length} cannot receive mail (${bad.reduce((n, x) => n + x.contacts, 0)} contact(s)).`, source, ...r, results, file };
      },
    },
    {
      name: 'nausicaa_request_bulk_delete', kind: 'action', category: 'delete_personal_data',
      description: 'After one named human click (even in Auto), record an approved bulk delete (list of contact ids) in delete-requests.csv for the CRM admin. Nausicaa never deletes contacts.',
      inputSchema: { type: 'object', required: ['ids', 'reason'], properties: { ids: { type: 'array', items: { type: 'string' } }, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!Array.isArray(a.ids) || !a.ids.length) throw new Error('ids must list at least one contact id');
        if (!String(a.reason || '').trim()) throw new Error('reason is required');
        const out = ctx.outDir(a.out_dir || 'mythos-out/nausicaa'); const f = join(out, 'delete-requests.csv');
        const csv = toCsv(a.ids.map((id) => ({ requested_at: new Date().toISOString(), id, reason: a.reason, status: 'approved request - CRM admin deletes' })), ['requested_at', 'id', 'reason', 'status']);
        appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        return { summary: `Bulk delete request recorded for ${a.ids.length} contact(s). Nothing was deleted.`, file: f };
      },
    },
    { name: 'crm_delete_contacts', kind: 'action', category: 'delete_personal_data', description: 'Listed so agents can see it is refused. Nausicaa never deletes or edits CRM records.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'nausicaa_audit', decision: 'allow' },
    { tool: 'nausicaa_write_cleanup', decision: 'allow' },
    { tool: 'nausicaa_merge_plan', decision: 'allow' },
    { tool: 'nausicaa_consent_provenance', decision: 'allow' },
    { tool: 'nausicaa_compare', decision: 'allow' },
    { tool: 'nausicaa_check_mx', decision: 'ask', reason: 'The MX check is opt-in: it may send domain names to a public DNS resolver. Needs a human yes (or an Auto opt-in).' },
    { tool: 'nausicaa_write_clean_copy', decision: 'ask', reason: 'Writing a clean copy needs a human yes (or an Auto opt-in).' },
    { tool: 'crm_delete_contacts', decision: 'block', reason: 'Nausicaa never deletes CRM records.' },
    { tool: 'nausicaa_request_bulk_delete', decision: 'ask', reason: 'Deleting contacts is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Nausicaa allowlist.' },
  ] },
});
