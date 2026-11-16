import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSeats, findWaste, sheetCsv, summaryMarkdown } from './seats.js';
import { POLICY_SCHEMA, contractTerms, applyContracts, actionList, renewalIcs, confirmationDrafts, draftIndexCsv, compareReviews } from './renewals.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const date = { type: 'string', format: 'date', description: 'YYYY-MM-DD (default today)' };
const common = {
  seats: { ...str, description: 'CSV/JSON seat export: app, user, email, tier, monthly_cost, last_active, premium_features_used, status' },
  roster: { ...str, description: 'Optional HR roster CSV/JSON: email, status (optional manager_email)' },
  as_of: date,
  idle_days: { type: 'integer', minimum: 1 },
  downgrade_ratio: { type: 'number', minimum: 0, maximum: 1, description: 'Share of cost saved by a downgrade (default 0.5)' },
  policy: { ...str, description: 'Optional helios-policy JSON: defaults and contract terms per app (billing, renewal_date, notice_days, min_seats, owner)' },
  contracts: { ...str, description: 'Optional contract records CSV/JSON: app, billing, renewal_date, notice_days, min_seats, owner (override the policy)' },
};
const low = (s) => String(s ?? '').trim().toLowerCase();

function run(a, ctx, seatsPath = a.seats, asOf = a.as_of) {
  const policy = a.policy ? ctx.readJson(a.policy, 'helios-policy') : null;
  const rosterRows = a.roster ? ctx.records(a.roster) : null;
  const roster = rosterRows ? new Map(rosterRows.map((r) => [low(r.email), low(r.status || 'active')])) : null;
  const managers = new Map((rosterRows || []).filter((r) => r.manager_email || r.manager).map((r) => [low(r.email), String(r.manager_email || r.manager).trim()]));
  const terms = contractTerms(policy, a.contracts ? ctx.records(a.contracts) : []);
  const perApp = new Map([...terms].map(([k, t]) => [k, { idle_days: t.idle_days, downgrade_ratio: t.downgrade_ratio }]));
  const r = findWaste(normalizeSeats(ctx.records(seatsPath)), { as_of: asOf, idle_days: a.idle_days ?? policy?.idle_days, downgrade_ratio: a.downgrade_ratio ?? policy?.downgrade_ratio, roster, perApp });
  applyContracts(r, terms);
  r.actions = actionList(r);
  return { r, policy, managers };
}
function appendRequest(ctx, a, kind) {
  for (const k of ['app', 'user', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
  const out = ctx.outDir(a.out_dir || 'mythos-out/helios'); const f = join(out, 'change-requests.csv');
  const row = toCsv([{ requested_at: new Date().toISOString(), change: kind, app: a.app, user: a.user, to_tier: a.to_tier || '', reason: a.reason, status: 'approved request - admin to action' }], ['requested_at', 'change', 'app', 'user', 'to_tier', 'reason', 'status']);
  appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
  return f;
}
const ACTION_COLS = ['app', 'act_by', 'renewal_date', 'seats', 'recommended_seats', 'revoke_candidates', 'downgrade_candidates', 'est_monthly_saving', 'est_saving_next_12m', 'why'];

const PROMPT = `You are running a SaaS seat review with Helios of Seats. Helios reads exports under its --root; it never connects to or changes any app.

1. Call helios_find_waste with seats "{{seats}}", roster "{{roster}}", policy "{{policy}}" and as_of "{{as_of}}" (leave out any argument the user did not give). Check seats_with_unknown_cost and any "assumption" fields: tell the user which savings are guesses.
2. Read result.actions in order: the soonest act_by comes first. Say which apps have a notice window that has passed (flag notice_window_passed) and what that means for timing.
3. If an earlier export exists, call helios_compare_reviews with previous and seats to show what changed, what was fixed and what is still flagged since last time.
4. Call helios_write_review, then helios_renewal_calendar (renewals.ics for act-by dates) and helios_draft_confirmations (one draft per app owner). The drafts are not sent: a person reviews and sends them.
5. Wait for owners' answers. Only then, for seats the owner confirmed, call helios_request_downgrade or helios_request_revoke with the reason. Revocations are one human click (an approval id); never try to approve them yourself.
6. Remind the user: savings are estimates from their export and contract terms; an admin makes every change in the app.`;

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'helios-of-seats',
  version: pkg.version,
  description: 'Finds unused, idle, duplicate, leaver and over-tiered SaaS seats (including AI tools) in CSV/JSON exports and estimates the saving, timed to each contract renewal and notice window. Writes a review sheet, a renewal calendar and owner confirmation drafts, and compares two exports. Revocations are always one human click; Helios never changes any app itself.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { 'helios-policy': POLICY_SCHEMA },
  prompts: [{
    name: 'helios_seat_review', title: 'Run a renewal-aware seat review',
    description: 'Walks the host model through a seat review: find waste, act-by order, compare with last time, write the sheet, calendar and owner drafts, then record only owner-confirmed changes (revokes stay one human click).',
    arguments: [
      { name: 'seats', description: 'Seat export CSV/JSON under --root', required: true },
      { name: 'roster', description: 'HR roster CSV under --root (optional)', required: false },
      { name: 'policy', description: 'helios-policy JSON with contract terms (optional)', required: false },
      { name: 'as_of', description: 'Review date YYYY-MM-DD (optional)', required: false },
    ],
    text: PROMPT,
  }],
  tools: [
    {
      name: 'helios_find_waste', kind: 'read', title: 'Find seat waste',
      description: 'Flag never-used, idle, duplicate, leaver and over-tiered seats with an estimated monthly saving, per seat and per app. With contract terms (policy or contracts), adds act-by dates, contract minimums, recommended seats at renewal and a 12-month saving pro-rated to the renewal date.',
      inputSchema: { type: 'object', required: ['seats'], additionalProperties: false, properties: common },
      handler: async (a, ctx) => { const { r } = run(a, ctx); return { summary: `${r.seats} seat(s): ${r.revoke_candidates} revoke and ${r.downgrade_candidates} downgrade candidate(s), est. $${r.est_monthly_saving}/month (~$${r.est_saving_next_12m} over the next 12 months after renewal timing). Suggestions only.`, ...r }; },
    },
    {
      name: 'helios_write_review', kind: 'report', title: 'Write seat review sheet',
      description: 'Write seat-review.csv (blank reviewer columns), renewal-actions.csv (act-by order) and seat-review-summary.md into out_dir (default mythos-out/helios). The sheet hash is recorded in the audit log.',
      inputSchema: { type: 'object', required: ['seats'], additionalProperties: false, properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const { r } = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/helios');
        const sheet = sheetCsv(r); const acts = toCsv(r.actions, ACTION_COLS);
        const files = [ctx.writeFile(out, 'seat-review.csv', sheet), ctx.writeFile(out, 'seat-review-summary.md', summaryMarkdown(r, new Date().toISOString())), ctx.writeFile(out, 'renewal-actions.csv', acts)];
        return { summary: `Seat review written: est. $${r.est_monthly_saving}/month across ${r.seats} seat(s).`, files, est_monthly_saving: r.est_monthly_saving, est_saving_next_12m: r.est_saving_next_12m, output_sha256: sha256(sheet + acts) };
      },
    },
    {
      name: 'helios_renewal_calendar', kind: 'report', title: 'Write renewal calendar (.ics)',
      description: 'Write renewals.ics with an all-day "notice due" event (renewal date minus notice days) and a renewal event for each annual app, with reminders and the seat counts to true-down. Needs contract terms (policy or contracts).',
      inputSchema: { type: 'object', required: ['seats'], additionalProperties: false, properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const { r } = run(a, ctx);
        const ics = renewalIcs(r);
        const file = ctx.writeFile(ctx.outDir(a.out_dir || 'mythos-out/helios'), 'renewals.ics', ics.text);
        return { summary: `Renewal calendar written: ${ics.events} event(s).`, file, events: ics.events, output_sha256: sha256(ics.text) };
      },
    },
    {
      name: 'helios_draft_confirmations', kind: 'report', title: 'Draft owner confirmations',
      description: 'Write one Markdown confirmation draft per app owner (from the policy or contracts; managers from the roster are added as Cc) listing each flagged seat with keep/remove boxes, plus drafts-index.csv, into out_dir/confirmations. Drafts only: Helios sends nothing.',
      inputSchema: { type: 'object', required: ['seats'], additionalProperties: false, properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, policy, managers } = run(a, ctx);
        const drafts = confirmationDrafts(r, { defaultOwner: policy?.default_owner || null, managers });
        const out = ctx.outDir(join(a.out_dir || 'mythos-out/helios', 'confirmations'));
        const files = drafts.map((d) => ctx.writeFile(out, d.name, d.text));
        const index = draftIndexCsv(drafts); files.push(ctx.writeFile(out, 'drafts-index.csv', index));
        return { summary: `${drafts.length} confirmation draft(s) written for ${drafts.reduce((s, d) => s + d.seats, 0)} flagged seat(s). Not sent.`, files, drafts: drafts.map(({ text, ...d }) => d), sent: 0, output_sha256: sha256(drafts.map((d) => d.text).join('\n') + index) };
      },
    },
    {
      name: 'helios_compare_reviews', kind: 'read', title: 'Compare two seat exports',
      description: 'Compare an earlier seat export with the current one: seats added and removed, waste resolved, new waste, seats still flagged, cost changes, and the change in monthly spend and estimated waste.',
      inputSchema: { type: 'object', required: ['previous', 'seats'], additionalProperties: false, properties: { ...common, previous: { ...str, description: 'Earlier seat export CSV/JSON' }, previous_as_of: date } },
      handler: async (a, ctx) => {
        const prev = run(a, ctx, a.previous, a.previous_as_of || a.as_of).r; const cur = run(a, ctx).r;
        const c = compareReviews(prev, cur);
        return { summary: `Spend ${c.monthly_spend_before} -> ${c.monthly_spend_after}/month; waste ${c.waste_before} -> ${c.waste_after}/month; ${c.resolved.length} resolved, ${c.new_waste.length} new, ${c.still_flagged.length} still flagged.`, ...c };
      },
    },
    {
      name: 'helios_request_downgrade', kind: 'write',
      description: 'Record a downgrade request in change-requests.csv for the app admin. Needs a human yes unless the buyer opted this action in to Auto. Helios does not change the app.',
      inputSchema: { type: 'object', required: ['app', 'user', 'reason'], properties: { app: str, user: str, to_tier: str, reason: str, out_dir: str } },
      handler: async (a, ctx) => ({ summary: `Downgrade request recorded for ${a.user} on ${a.app}. An admin makes the change.`, file: appendRequest(ctx, a, 'downgrade') }),
    },
    {
      name: 'helios_request_revoke', kind: 'action', category: 'revoke_access',
      description: 'Record a seat revocation request for the app admin after one named human click (even in Auto). Helios does not remove the seat itself.',
      inputSchema: { type: 'object', required: ['app', 'user', 'reason'], properties: { app: str, user: str, reason: str, out_dir: str } },
      handler: async (a, ctx) => ({ summary: `Revocation request recorded for ${a.user} on ${a.app}. An admin removes the seat.`, file: appendRequest(ctx, a, 'revoke') }),
    },
  ],
  policy: { rules: [
    { tool: 'helios_find_waste', decision: 'allow' },
    { tool: 'helios_write_review', decision: 'allow' },
    { tool: 'helios_renewal_calendar', decision: 'allow' },
    { tool: 'helios_draft_confirmations', decision: 'allow' },
    { tool: 'helios_compare_reviews', decision: 'allow' },
    { tool: 'helios_request_downgrade', decision: 'ask', reason: 'Downgrades need a human yes (or an Auto opt-in).' },
    { category: 'revoke_access', decision: 'ask', reason: 'Revoking a seat is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Helios allowlist.' },
  ] },
});
