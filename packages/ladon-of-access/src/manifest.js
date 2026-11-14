import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAccess, normalizeRoster, reviewAccess, sheetCsv, summaryMarkdown } from './access.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const common = { access: { ...str, description: 'CSV/JSON export of accounts: system, user, email, account_type (human/agent/service), role, owner, last_login, status, mfa' }, roster: { ...str, description: 'Optional HR roster CSV/JSON: email, status, termination_date' }, as_of: { ...str, description: 'YYYY-MM-DD (default today)' }, stale_days: { type: 'number' }, privileged_roles: { type: 'array', items: str } };
const run = (a, ctx) => reviewAccess(normalizeAccess(ctx.records(a.access)), a.roster ? normalizeRoster(ctx.records(a.roster)) : null, a);

export const manifest = defineManifest({
  name: 'ladon-of-access',
  version: pkg.version,
  description: 'Reads access-list exports (people, agents and service accounts), flags leavers, stale, privileged and ownerless accounts, and writes a recertification sheet a named reviewer signs. Never revokes access by itself.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  tools: [
    {
      name: 'ladon_review_access', kind: 'read',
      description: 'Flag risky accounts in an access export (optionally against an HR roster): leavers, not in roster, stale or never-used logins, privileged roles, privileged without MFA, agents without an owner, shared and duplicate accounts.',
      inputSchema: { type: 'object', required: ['access'], properties: common },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.accounts} account(s): high ${r.by_risk.high}, medium ${r.by_risk.medium}, low ${r.by_risk.low}. Suggestions only.`, ...r }; },
    },
    {
      name: 'ladon_recert_sheet', kind: 'report',
      description: 'Write recertification.csv (with blank reviewer_decision / reviewer_name / review_date columns) and recertification-summary.md into out_dir (default mythos-out/ladon).',
      inputSchema: { type: 'object', required: ['access'], properties: { ...common, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/ladon');
        const files = [ctx.writeFile(out, 'recertification.csv', sheetCsv(r)), ctx.writeFile(out, 'recertification-summary.md', summaryMarkdown(r, new Date().toISOString()))];
        return { summary: `Recertification sheet written for ${r.accounts} account(s).`, files, by_risk: r.by_risk };
      },
    },
    {
      name: 'ladon_request_revocation', kind: 'action', category: 'revoke_access',
      description: 'After a named human approves (one click, even in Auto), record a revocation request in revocation-requests.csv for the system admin. Ladon does not connect to any system and does not remove access itself.',
      inputSchema: { type: 'object', required: ['system', 'user', 'reason'], properties: { system: str, user: str, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['system', 'user', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        const out = ctx.outDir(a.out_dir || 'mythos-out/ladon');
        const f = join(out, 'revocation-requests.csv');
        const cols = ['requested_at', 'system', 'user', 'reason', 'status'];
        const row = toCsv([{ requested_at: new Date().toISOString(), system: a.system, user: a.user, reason: a.reason, status: 'approved request - admin to action' }], cols);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Revocation request recorded for ${a.user} on ${a.system}. An admin must remove the access in that system.`, file: f };
      },
    },
  ],
  policy: { rules: [
    { tool: 'ladon_review_access', decision: 'allow' },
    { tool: 'ladon_recert_sheet', decision: 'allow' },
    { category: 'revoke_access', decision: 'ask', reason: 'Revoking access needs a named human, one click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Ladon allowlist.' },
  ] },
});
