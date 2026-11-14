import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSeats, findWaste, sheetCsv, summaryMarkdown } from './seats.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const common = { seats: { ...str, description: 'CSV/JSON seat export: app, user, email, tier, monthly_cost, last_active, premium_features_used, status' }, roster: { ...str, description: 'Optional HR roster CSV/JSON: email, status' }, as_of: str, idle_days: { type: 'number' }, downgrade_ratio: { type: 'number', description: 'Share of cost saved by a downgrade (default 0.5)' } };
const run = (a, ctx) => {
  const roster = a.roster ? new Map(ctx.records(a.roster).map((r) => [String(r.email || '').trim().toLowerCase(), String(r.status || 'active').toLowerCase()])) : null;
  return findWaste(normalizeSeats(ctx.records(a.seats)), { ...a, roster });
};
function appendRequest(ctx, a, kind) {
  for (const k of ['app', 'user', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
  const out = ctx.outDir(a.out_dir || 'mythos-out/helios'); const f = join(out, 'change-requests.csv');
  const row = toCsv([{ requested_at: new Date().toISOString(), change: kind, app: a.app, user: a.user, to_tier: a.to_tier || '', reason: a.reason, status: 'approved request - admin to action' }], ['requested_at', 'change', 'app', 'user', 'to_tier', 'reason', 'status']);
  appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
  return f;
}

export const manifest = defineManifest({
  name: 'helios-of-seats',
  version: pkg.version,
  description: 'Finds unused, idle, duplicate, leaver and over-tiered SaaS seats (including AI tools) in CSV/JSON exports and estimates the saving. Revocations are always one human click; Helios never changes any app itself.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'helios_find_waste', kind: 'read',
      description: 'Flag never-used, idle, duplicate, leaver and over-tiered seats with an estimated monthly saving, per seat and per app.',
      inputSchema: { type: 'object', required: ['seats'], properties: common },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.seats} seat(s): ${r.revoke_candidates} revoke and ${r.downgrade_candidates} downgrade candidate(s), est. $${r.est_monthly_saving}/month. Suggestions only.`, ...r }; },
    },
    {
      name: 'helios_write_review', kind: 'report',
      description: 'Write seat-review.csv (blank reviewer columns) and seat-review-summary.md into out_dir (default mythos-out/helios).',
      inputSchema: { type: 'object', required: ['seats'], properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/helios');
        const files = [ctx.writeFile(out, 'seat-review.csv', sheetCsv(r)), ctx.writeFile(out, 'seat-review-summary.md', summaryMarkdown(r, new Date().toISOString()))];
        return { summary: `Seat review written: est. $${r.est_monthly_saving}/month across ${r.seats} seat(s).`, files, est_monthly_saving: r.est_monthly_saving };
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
    { tool: 'helios_request_downgrade', decision: 'ask', reason: 'Downgrades need a human yes (or an Auto opt-in).' },
    { category: 'revoke_access', decision: 'ask', reason: 'Revoking a seat is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Helios allowlist.' },
  ] },
});
