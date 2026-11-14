import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { normContacts, audit, cleanupCsv } from './hygiene.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = { contacts: { ...str, description: 'Contact export CSV/JSON: id, email, name, company, last_activity, bounce, consent, consent_date, unsubscribed, status' }, suppression: { ...str, description: 'Optional suppression list CSV/JSON (email or domain column)' }, as_of: str, stale_days: { type: 'number' }, reconsent_days: { type: 'number' } };
const run = (a, ctx) => {
  const supp = a.suppression ? ctx.records(a.suppression).map((r) => String(r.email || r.domain || Object.values(r)[0] || '').trim()).filter(Boolean) : [];
  return audit(normContacts(ctx.records(a.contacts)), { ...a, suppression: supp });
};

export const manifest = defineManifest({
  name: 'nausicaa-of-hygiene',
  version: pkg.version,
  description: 'CRM and contact-list hygiene from exports: invalid and typo emails, hard bounces, role and disposable addresses, duplicates, stale records, missing or conflicting consent. Writes a review sheet and a do-not-email copy. Bulk deletes are always one human click and only record a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'nausicaa_audit', kind: 'read',
      description: 'Flag each contact and suggest keep, fix, merge, suppress, re-permission, review or delete candidate.',
      inputSchema: { type: 'object', required: ['contacts'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.contacts} contact(s): keep ${r.keep}, suppress ${r.suppress}, merge ${r.merge}, fix ${r.fix}, re-permission ${r.re_permission}, review ${r.review}, delete candidates ${r.delete_candidates}.`, ...r }; },
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
    { tool: 'nausicaa_write_clean_copy', decision: 'ask', reason: 'Writing a clean copy needs a human yes (or an Auto opt-in).' },
    { tool: 'crm_delete_contacts', decision: 'block', reason: 'Nausicaa never deletes CRM records.' },
    { tool: 'nausicaa_request_bulk_delete', decision: 'ask', reason: 'Deleting contacts is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Nausicaa allowlist.' },
  ] },
});
