import { defineManifest, toCsv, sha256, LANGS, normLang } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAccess, normalizeRoster, reviewAccess, sheetCsv, summaryMarkdown, effectiveOptions, campaignStatus, accessDiff, evidencePack } from './access.js';
import { SOURCES } from './sources.js';
import { MEMORY, MEMORY_KINDS, withMemory } from './memory.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const date = { type: 'string', format: 'date', description: 'YYYY-MM-DD (default today)' };
const roleList = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 };

/** Review policy file (ladon-policy). Unknown keys fail, so typos are caught. */
export const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    $schema: str,
    stale_days: { type: 'integer', minimum: 1, description: 'Days without a login before an account is stale (default 90)' },
    privileged_roles: { ...roleList, description: 'Role words that count as privileged (replaces the built-in list)' },
    due_days: { type: 'integer', minimum: 1, description: 'Days from as_of until a line is due (default 14; high risk gets half)' },
    rotation_max_days: { type: 'integer', minimum: 1, description: 'Max days since an agent/service credential was rotated (default 90)' },
    delegations: {
      type: 'array', description: 'Reviewer delegations: lines assigned to "from" go to "to"',
      items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 }, reason: str } },
    },
    sod_rules: {
      type: 'array', description: 'Segregation-of-duties rules: one person must not hold a roles_a role and a roles_b role',
      items: { type: 'object', additionalProperties: false, required: ['name', 'roles_a', 'roles_b'], properties: { name: { type: 'string', minLength: 1 }, roles_a: roleList, roles_b: roleList, same_role_counts: { type: 'boolean' } } },
    },
  },
};

const common = {
  access: { ...str, description: 'CSV/JSON export of accounts: system, user, email, account_type (human/agent/service), role, owner, last_login, last_rotated, status, mfa' },
  roster: { ...str, description: 'Optional HR roster CSV/JSON: email, status, termination_date, manager' },
  policy: { ...str, description: 'Optional ladon-policy JSON: stale_days, privileged_roles, due_days, rotation_max_days, delegations, sod_rules' },
  as_of: date,
  stale_days: { type: 'integer', minimum: 1 },
  privileged_roles: roleList,
  due_days: { type: 'integer', minimum: 1 },
  rotation_max_days: { type: 'integer', minimum: 1 },
};
const loadPolicy = (a, ctx) => (a.policy ? ctx.readJson(a.policy, 'ladon-policy') : {});
const run = (a, ctx) => {
  const { opts, memory } = withMemory(effectiveOptions(loadPolicy(a, ctx), a), ctx);
  const r = reviewAccess(normalizeAccess(ctx.records(a.access)), a.roster ? normalizeRoster(ctx.records(a.roster)) : null, opts);
  return memory ? { ...r, memory } : r;
};
const memNote = (r) => (r.memory ? ` ${r.memory.used.length} learned fact(s) used.` : '');
const OUT = 'mythos-out/ladon';
const language = { type: 'string', enum: LANGS, description: 'Language of the summary or evidence page: en, de, fr, es, pt, it, ja, zh, ko (default: the --lang setting, else English). The CSV, codes and JSON stay in English.' };

const PROMPT = `You are running an access recertification with the ladon-of-access tools. Work only on files under --root. Ladon never revokes access; a named person does.

0. Call ladon_recall to see what Ladon has learned about this customer. Accepted facts (extra privileged roles, SoD rules, standing delegations) are applied to every review automatically and listed under "memory" in the results; waiting facts are not applied. If the user tells you something Ladon should remember (for example "Vault Keeper is a privileged role here"), call ladon_learn with the matching kind and tell the user it waits for a named person to accept it ("ladon memory accept <id> --as Name", or ladon_accept_learning, which always asks). Never store passwords, keys or personal identifiers.
1. Call ladon_review_access with access="{{access}}", roster="{{roster}}" (leave roster out if it is empty) and as_of="{{as_of}}" (add policy="{{policy}}" if a policy file was given). Read by_risk, sod_conflicts, rotation_checked and unassigned_reviewer. Tell the user the top risks in plain words using each item's "reasons".
2. If a previous export exists ("{{previous}}"), call ladon_access_diff with previous and current to show what changed since the last review (privilege gained, reactivated accounts, new agents). Review those first.
3. Call ladon_recert_sheet with the same arguments. It writes recertification.csv (assigned_reviewer, delegated_to, due_date, blank decision columns) and a summary. Tell the user where the files are and that each reviewer fills in reviewer_decision (keep / modify / revoke), reviewer_name and review_date. You do not fill in decisions.
4. When the user returns a filled sheet, call ladon_campaign_status with sheet=<path>. Report percent complete, the chase_list (who to remind), overdue lines and any issues (self-review, missing sign-off, signed by someone other than the assigned reviewer). Do not fix decisions yourself; ask the reviewer.
5. When the campaign is complete (or the user asks), call ladon_evidence_pack with the filled sheet. It writes an HTML and JSON evidence file and records an output_sha256 in the audit log. Say clearly that it records what the sheet says and is not proof that the reviews took place.
6. For each line in revocations_to_request, call ladon_request_revocation (system, user, reason). It returns needs_approval: a named human must approve each one (one click, even in Auto). Give the user the approval command and repeat the same call after approval. An admin then removes the access in that system.

Never claim the review makes anyone compliant or certified.`;

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'ladon-of-access',
  version: pkg.version,
  description: 'Reads access-list exports (people, agents and service accounts), flags leavers, stale, privileged, ownerless and unrotated accounts and segregation-of-duties conflicts, writes a recertification sheet with reviewers and due dates, tracks campaign progress and writes an evidence pack. Never revokes access by itself.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  configSchemas: { 'ladon-policy': POLICY_SCHEMA },
  memory: { prefix: 'ladon', kinds: MEMORY_KINDS },
  prompts: [{
    name: 'ladon_recertification_campaign', title: 'Run an access recertification campaign',
    description: 'Review an access export, write the sheet, chase reviewers, write the evidence pack and route revocations to a human click.',
    arguments: [
      { name: 'access', description: 'Access export under --root (CSV/JSON)', required: true },
      { name: 'roster', description: 'HR roster under --root (optional)', required: false },
      { name: 'as_of', description: 'Review date YYYY-MM-DD', required: true },
      { name: 'policy', description: 'ladon-policy JSON (optional)', required: false },
      { name: 'previous', description: 'Previous period access export, for the diff (optional)', required: false },
    ],
    text: PROMPT,
  }],
  tools: [
    {
      name: 'ladon_review_access', kind: 'read', title: 'Review access',
      description: 'Flag risky accounts in an access export (optionally against an HR roster and a policy file): leavers, not in roster, stale or never-used logins, privileged roles, privileged without MFA, agents/services without an owner or credential rotation date, segregation-of-duties conflicts, shared and duplicate accounts. Each line gets reasons, an assigned reviewer and a due date.',
      inputSchema: { type: 'object', required: ['access'], additionalProperties: false, properties: common },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.accounts} account(s): high ${r.by_risk.high}, medium ${r.by_risk.medium}, low ${r.by_risk.low}; ${r.sod_conflicts.length} SoD conflict(s).${memNote(r)} Suggestions only.`, ...r }; },
    },
    {
      name: 'ladon_recert_sheet', kind: 'report', title: 'Write recertification sheet',
      description: 'Write recertification.csv (assigned_reviewer, delegated_to, due_date, and blank reviewer_decision / reviewer_name / review_date columns) and recertification-summary.md into out_dir (default mythos-out/ladon).',
      inputSchema: { type: 'object', required: ['access'], additionalProperties: false, properties: { ...common, out_dir: str, language } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || OUT);
        const csv = sheetCsv(r);
        const lang = normLang(a.language || ctx.lang);
        const files = [ctx.writeFile(out, 'recertification.csv', csv), ctx.writeFile(out, 'recertification-summary.md', summaryMarkdown(r, new Date().toISOString(), lang))];
        return { summary: `Recertification sheet written for ${r.accounts} account(s).${memNote(r)}`, files, language: lang, by_risk: r.by_risk, sod_conflicts: r.sod_conflicts.length, output_sha256: sha256(csv), ...(r.memory ? { memory: r.memory } : {}) };
      },
    },
    {
      name: 'ladon_campaign_status', kind: 'read', title: 'Campaign status',
      description: 'Read a filled recertification.csv and report progress: decided, open, overdue (past due_date), incomplete sign-offs, self-reviews, lines signed by someone other than the assigned or delegated reviewer, a chase list per reviewer, and the lines marked revoke.',
      inputSchema: { type: 'object', required: ['sheet'], additionalProperties: false, properties: { sheet: { ...str, description: 'Filled recertification.csv' }, as_of: date } },
      handler: async (a, ctx) => { const s = campaignStatus(ctx.records(a.sheet), a); return { summary: `${s.percent_complete}% decided (${s.decided}/${s.lines}); ${s.overdue} overdue, ${s.open} open, ${s.incomplete + s.invalid} need fixing; ${s.revocations_to_request.length} revoke decision(s).`, ...s }; },
    },
    {
      name: 'ladon_access_diff', kind: 'read', title: 'Access changes between periods',
      description: 'Compare a previous and a current access export: added and removed accounts, role changes, privilege gained, reactivated and deactivated accounts, new agents/service accounts and owner changes, with a review-first list.',
      inputSchema: { type: 'object', required: ['previous', 'current'], additionalProperties: false, properties: { previous: { ...str, description: 'Earlier access export' }, current: { ...str, description: 'Later access export' }, privileged_roles: roleList, policy: common.policy } },
      handler: async (a, ctx) => {
        const { opts: o, memory } = withMemory(effectiveOptions(loadPolicy(a, ctx), a), ctx, ['privileged_role']);
        const d = accessDiff(normalizeAccess(ctx.records(a.previous)), normalizeAccess(ctx.records(a.current)), o);
        const c = d.counts;
        return { summary: `${c.added} added, ${c.removed} removed, ${c.role_changed} role change(s), ${c.privilege_gained} privilege gain(s), ${c.reactivated} reactivated.${memory ? ` ${memory.used.length} learned privileged role(s) used.` : ''}`, ...d, ...(memory ? { memory } : {}) };
      },
    },
    {
      name: 'ladon_evidence_pack', kind: 'report', title: 'Write campaign evidence pack',
      description: 'From a filled recertification.csv, write recertification-evidence.json and .html into out_dir (default mythos-out/ladon/evidence): totals, decisions, reviewers, exceptions and the sha256 of the sheet. The record hash is logged in the audit line as output_sha256. Records what the sheet says; it is not proof the reviews happened.',
      inputSchema: { type: 'object', required: ['sheet'], additionalProperties: false, properties: { sheet: { ...str, description: 'Filled recertification.csv' }, as_of: date, campaign: { ...str, description: 'Campaign name, e.g. "Q4 2026 access review"' }, out_dir: str, language } },
      handler: async (a, ctx) => {
        const s = campaignStatus(ctx.records(a.sheet), a);
        const lang = normLang(a.language || ctx.lang);
        const p = evidencePack(s, { sheet_sha256: ctx.hashFile(a.sheet), sheet_path: a.sheet, campaign: a.campaign, lang });
        const out = ctx.outDir(a.out_dir || `${OUT}/evidence`);
        const files = [ctx.writeFile(out, 'recertification-evidence.json', p.json), ctx.writeFile(out, 'recertification-evidence.html', p.html)];
        return { summary: `Evidence pack written: ${s.decided}/${s.lines} decided, ${s.overdue} overdue, complete=${p.record.complete}.`, files, language: lang, complete: p.record.complete, totals: p.record.totals, sheet_sha256: p.record.sheet.sha256, output_sha256: p.record_sha256 };
      },
    },
    {
      name: 'ladon_request_revocation', kind: 'action', category: 'revoke_access', title: 'Request a revocation',
      description: 'After a named human approves (one click, even in Auto), record a revocation request in revocation-requests.csv for the system admin. Ladon does not connect to any system and does not remove access itself.',
      inputSchema: { type: 'object', required: ['system', 'user', 'reason'], properties: { system: str, user: str, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['system', 'user', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        const out = ctx.outDir(a.out_dir || OUT);
        const f = join(out, 'revocation-requests.csv');
        const cols = ['requested_at', 'system', 'user', 'reason', 'status'];
        const row = toCsv([{ requested_at: new Date().toISOString(), system: a.system, user: a.user, reason: a.reason, status: 'approved request - admin to action' }], cols);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Revocation request recorded for ${a.user} on ${a.system}. An admin must remove the access in that system.`, file: f };
      },
    },
    ...MEMORY.tools,
  ],
  policy: { rules: [
    { tool: 'ladon_review_access', decision: 'allow' },
    { tool: 'ladon_recert_sheet', decision: 'allow' },
    { tool: 'ladon_campaign_status', decision: 'allow' },
    { tool: 'ladon_access_diff', decision: 'allow' },
    { tool: 'ladon_evidence_pack', decision: 'allow' },
    { category: 'revoke_access', decision: 'ask', reason: 'Revoking access needs a named human, one click, even in Auto.' },
    ...MEMORY.rules,
    { tool: '*', decision: 'block', reason: 'Not on the Ladon allowlist.' },
  ] },
});
