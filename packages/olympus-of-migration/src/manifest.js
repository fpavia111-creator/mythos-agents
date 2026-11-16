import { defineManifest, toCsv, sha256, canonical, htmlPage, escapeHtml, LANGS, normLang } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { compareExports, tieOutBalances, checkFields, compareRuns, actionList, exceptionRows, reportMarkdown, reportWords } from './checks.js';
import { migrationRulesSchema, fieldRuleSchema } from './schemas.js';
import { MEMORY, MEMORY_KINDS, withMemory, memoryText } from './memory.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const tolerance = { type: 'number', minimum: 0, description: 'Differences up to and including this count as tied (default 0.005)' };
const fxRates = { type: 'object', additionalProperties: { type: 'number', exclusiveMinimum: 0 }, description: 'Rates to base_currency, e.g. {"EUR": 1.08}. You supply them; Olympus never looks rates up.' };
const base = { type: 'string', pattern: '^[A-Za-z]{3}$' };
const config = { ...str, description: 'Migration rules JSON (schema "migration_rules"): tolerance, columns, FX rates and field rules' };

/**
 * Load the optional rules file, then let explicit arguments win, then fill what is
 * still unset from accepted memory facts (and add learned field rules). The settings
 * carry a non-enumerable "memory" note: { used, skipped } or null.
 */
function settings(a, ctx, { fields = true, field_rules } = {}) {
  const rules = a.config ? ctx.readJson(a.config, 'migration_rules') : {};
  const pickKeys = ['key', 'target_key', 'amount_column', 'account_column', 'balance_column', 'subsidiary_column', 'currency_column', 'tolerance', 'base_currency', 'fx_rates'];
  const out = { name: rules.name || null, field_rules: field_rules !== undefined ? field_rules : rules.field_rules || null };
  for (const k of pickKeys) out[k] = a[k] !== undefined ? a[k] : rules[k];
  const m = withMemory(out, ctx, { fields });
  Object.defineProperty(m.settings, 'memory', { value: m.memory, enumerable: false });
  return m.settings;
}
const memNote = (s) => (s.memory && s.memory.used.length ? ` ${s.memory.used.length} learned fact(s) used.` : '');
const memOut = (s) => (s.memory ? { memory: s.memory } : {});

const tbOpts = (s, a = {}) => ({ tolerance: s.tolerance, subsidiary_column: s.subsidiary_column, currency_column: s.currency_column, fx_rates: s.fx_rates, base_currency: s.base_currency, account_column: a.account_column ?? s.account_column, balance_column: a.balance_column ?? s.balance_column });

function reportHtml({ title, cmp, tb, fields, actions, generatedAt, memory = null, lang = 'en' }) {
  const e = escapeHtml; const w = reportWords(lang, memoryText); const { t } = w;
  const rows = (list, cols) => `<table><thead><tr>${cols.map((c) => `<th>${e(c[0])}</th>`).join('')}</tr></thead><tbody>${list.map((r) => `<tr>${cols.map((c) => `<td>${e(String(c[1](r) ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let b = `<p>${e(t('generated_html', { at: generatedAt }))}</p>`;
  b += `<h2>${e(t('verdict'))}</h2><ul><li>${e(t('data_status'))}: <strong>${e(w.loud(cmp.status))}</strong>${tb ? ` · ${e(t('tb_status'))}: <strong>${e(w.loud(tb.status))}</strong>` : ''}${fields ? ` · ${e(t('fr_status'))}: <strong>${e(w.loud(fields.status))}</strong>` : ''}</li><li>${e(t('go_live'))}: <strong>${e(t('not_approved'))}</strong>. ${e(t('go_live_note'))}</li></ul>`;
  if (actions.length) b += `<h2>${e(t('next_actions'))}</h2>${rows(actions, [[t('col_n'), (r) => r.n], [t('col_priority'), (r) => `P${r.priority}`], [t('col_why'), (r) => w.why(r)], [t('col_action'), (r) => w.action(r)]])}`;
  b += `<h2>${e(t('findings'))}</h2>${cmp.findings.length ? rows(cmp.findings, [[t('severity'), (r) => w.word(r.severity)], [t('code'), (r) => r.code], [t('message'), (r) => w.finding(r)]]) : `<p>${e(t('no_findings'))}</p>`}`;
  if (tb && tb.not_tied.length) b += `<h2>${e(t('tb_not_tied'))}</h2>${rows(tb.not_tied, [[t('line'), (r) => [r.subsidiary, r.account, r.currency].filter(Boolean).join(' · ')], [t('source'), (r) => r.source ?? t('unknown')], [t('target'), (r) => r.target ?? t('unknown')], [t('difference'), (r) => r.difference ?? t('na')], [t('state'), (r) => w.word(r.state)]])}`;
  if (memory && (memory.used.length || memory.skipped.length)) b += `<h2>${e(t('learned_heading'))}</h2><p>${e(t('learned_intro'))}</p><ul>${memory.used.map((f) => `<li><code>${e(f.id)}</code> ${e(w.fact(f))} (${e(t('accepted_by', { name: f.accepted_by }))})</li>`).join('')}${memory.skipped.map((f) => `<li><code>${e(f.id)}</code> ${e(w.fact(f))}: ${e(w.notUsed(f))}</li>`).join('')}</ul>`;
  b += `<h2>${e(t('limits'))}</h2><ul><li>${e(t('limit_1'))}</li><li>${e(t('limit_2'))}</li><li>${e(t('limit_3'))}</li></ul>`;
  if (!w.en) b += `<p class="mut"><em>${e(t('translation_note'))}</em></p>`;
  return htmlPage({ title: title || t('report_title'), bodyHtml: b, footer: t('footer'), lang });
}

const language = { type: 'string', enum: LANGS, description: 'Language of the report text: en, de, fr, es, pt (Brazil), it, ja, zh (simplified) or ko. Default: the agent\'s --lang, else English. Codes, findings.json and exceptions.csv stay in English.' };

export const manifest = defineManifest({
  name: 'olympus-of-migration',
  version: pkg.version,
  description: 'Checks NetSuite (or other ERP) migration export files before go-live and writes a readiness report. Read-only on your data; never approves go-live.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  configSchemas: { migration_rules: migrationRulesSchema },
  memory: { prefix: 'olympus', kinds: MEMORY_KINDS },
  tools: [
    {
      name: 'olympus_compare_exports', kind: 'read', title: 'Compare source and target exports',
      description: 'Compare a source-system export with a target (e.g. NetSuite sandbox) export (CSV/JSON): missing and extra records, duplicate keys, field differences and amount totals, optionally per subsidiary.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, key: { ...str, description: 'Key column, e.g. externalid' }, target_key: str, amount_column: str, compare_columns: { type: 'array', items: str }, subsidiary_column: { ...str, description: 'Also tie amount totals per subsidiary' }, tolerance, config } },
      handler: async (a, ctx) => {
        const s = settings(a, ctx, { fields: false });
        const r = compareExports(ctx.records(a.source), ctx.records(a.target), { ...s, compare_columns: a.compare_columns });
        return { summary: `${r.status}: ${r.counts.missing_in_target} missing, ${r.counts.extra_in_target} extra, ${r.counts.field_mismatches} field differences${r.totals.difference !== null ? `, totals differ by ${r.totals.difference}` : ''}.${memNote(s)} Go-live not approved.`, ...r, ...memOut(s) };
      },
    },
    {
      name: 'olympus_tie_out_balances', kind: 'read', title: 'Tie out trial balances',
      description: 'Tie out two trial-balance exports by account, optionally by subsidiary and currency (converted with FX rates you supply). Unknown or blank balances, and currencies with no rate, are reported, never guessed.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, account_column: str, balance_column: str, subsidiary_column: str, currency_column: str, fx_rates: fxRates, base_currency: base, tolerance, config } },
      handler: async (a, ctx) => {
        const s = settings(a, ctx, { fields: false });
        const r = tieOutBalances(ctx.records(a.source), ctx.records(a.target), tbOpts(s, a));
        const subs = r.by_subsidiary ? `; ${r.by_subsidiary.map((g) => `${g.subsidiary} ${g.state}${g.difference ? ` (${g.difference}${g.currency ? ' ' + g.currency : ''})` : ''}`).join(', ')}` : '';
        return { summary: `${r.tied}/${r.accounts} accounts tie (${r.status})${subs}.${memNote(s)}`, ...r, ...memOut(s) };
      },
    },
    {
      name: 'olympus_check_fields', kind: 'read', title: 'Check field rules',
      description: 'Check one export against field rules (required, unique, number/integer/date type, allowed values, pattern, min/max, max length). Rules come from "rules" or the field_rules in a migration_rules config. Returns row numbers that match the spreadsheet.',
      inputSchema: { type: 'object', required: ['file'], properties: { file: str, rules: { type: 'array', items: fieldRuleSchema, minItems: 1 }, config } },
      handler: async (a, ctx) => {
        const s = settings({ config: a.config }, ctx, a.rules ? { field_rules: a.rules } : {});
        const rules = s.field_rules;
        if (!rules || !rules.length) throw new Error('pass "rules" or a "config" with field_rules (or accept a learned field_rule)');
        const r = checkFields(ctx.records(a.file), rules);
        return { summary: `${a.file}: ${r.status}, ${r.violation_count} violation(s) across ${r.rules.length} rule(s).${memNote(s)}`, ...r, ...memOut(s) };
      },
    },
    {
      name: 'olympus_compare_runs', kind: 'read', title: 'Compare two trial loads',
      description: 'Compare two findings.json files from earlier and later readiness reports: findings resolved, new and still open; records fixed and newly missing; trial-balance lines fixed and new.',
      inputSchema: { type: 'object', required: ['previous', 'current'], properties: { previous: { ...str, description: 'findings.json from the earlier run' }, current: { ...str, description: 'findings.json from the later run' } } },
      handler: async (a, ctx) => {
        const r = compareRuns(ctx.readJson(a.previous), ctx.readJson(a.current));
        return { summary: `${r.previous.status} → ${r.current.status} (${r.trend}): ${r.findings.resolved.length} finding(s) resolved, ${r.findings.new.length} new, ${r.missing_in_target.fixed.length} missing record(s) fixed. Go-live not approved.`, ...r };
      },
    },
    {
      name: 'olympus_readiness_report', kind: 'report', title: 'Write readiness report',
      description: 'Write readiness-report.md, readiness-report.html, findings.json and exceptions.csv into an output folder (default mythos-out/olympus), with a prioritised action list. Records the report hash in the audit log. Does not change any input file.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, key: str, amount_column: str, subsidiary_column: str, source_tb: str, target_tb: str, currency_column: str, fx_rates: fxRates, base_currency: base, tolerance, config, previous_findings: { ...str, description: 'findings.json from an earlier run, to show what changed' }, out_dir: str, title: str, language } },
      handler: async (a, ctx) => {
        const s = settings(a, ctx);
        const cmp = compareExports(ctx.records(a.source), ctx.records(a.target), s);
        const tb = a.source_tb && a.target_tb ? tieOutBalances(ctx.records(a.source_tb), ctx.records(a.target_tb), tbOpts(s)) : null;
        const fields = s.field_rules && s.field_rules.length ? checkFields(ctx.records(a.target), s.field_rules) : null;
        const actions = actionList({ cmp, tb, fields });
        const generatedAt = new Date().toISOString();
        const findings = { generatedAt, rules: s.name, compare: cmp, trial_balance: tb, field_rules: fields, actions, ...(s.memory ? { learned_facts: s.memory } : {}) };
        const runs = a.previous_findings ? compareRuns(ctx.readJson(a.previous_findings), findings) : null;
        if (runs) findings.change_since_previous = runs;
        const dir = ctx.outDir(a.out_dir || 'mythos-out/olympus');
        const lang = normLang(a.language || ctx.lang);
        const texts = {
          'readiness-report.md': reportMarkdown({ title: a.title, cmp, tb, fields, actions, runs, generatedAt, rulesName: s.name, memory: s.memory, memoryText, lang }),
          'readiness-report.html': reportHtml({ title: a.title, cmp, tb, fields, actions, generatedAt, memory: s.memory, lang }),
          'findings.json': JSON.stringify(findings, null, 2),
          'exceptions.csv': toCsv(exceptionRows({ cmp, tb, fields }), ['n', 'type', 'key', 'column', 'source', 'target', 'detail', 'owner', 'resolution']),
        };
        const files = []; const hashes = {};
        for (const [name, text] of Object.entries(texts)) { files.push(ctx.writeFile(dir, name, text)); hashes[name] = sha256(text); }
        const outputSha = sha256(canonical(hashes));
        return {
          summary: `Report written (${cmp.status}${tb ? ', TB ' + tb.status : ''}${fields ? ', fields ' + fields.status : ''}; ${actions.length} action(s)). Report hash ${outputSha.slice(0, 12)}.${memNote(s)} Go-live not approved.`,
          status: cmp.status, go_live: 'not_approved', language: lang, files, file_sha256: hashes, output_sha256: outputSha, actions, ...memOut(s),
        };
      },
    },
    {
      name: 'olympus_approve_go_live', kind: 'action', category: 'go_live', title: 'Approve go-live (refused)',
      description: 'Listed so agents can see it is refused. Olympus never approves go-live; a named human signs off outside the agent.',
      inputSchema: { type: 'object', properties: {} },
    },
    ...MEMORY.tools,
  ],
  prompts: [
    {
      name: 'olympus_go_live_readiness', title: 'Go-live readiness check',
      description: 'Walk through a migration readiness check end to end: compare exports, tie out the trial balance, check field rules, compare with the last trial load and write the report. Go-live stays a human decision.',
      arguments: [
        { name: 'source', description: 'Source-system export (CSV/JSON) under --root', required: true },
        { name: 'target', description: 'Target (e.g. NetSuite sandbox) export under --root', required: true },
        { name: 'source_tb', description: 'Source trial balance export', required: false },
        { name: 'target_tb', description: 'Target trial balance export', required: false },
        { name: 'config', description: 'migration_rules JSON (tolerance, columns, FX rates, field rules)', required: false },
        { name: 'previous_findings', description: 'findings.json from the previous trial load', required: false },
      ],
      text: [
        'You are helping a finance/ERP team decide whether a data migration is ready for go-live. Use the olympus-of-migration tools only. All work is on local export files; do not ask for credentials.',
        '',
        '0. Call olympus_recall to see what Olympus has learned about this customer\'s exports. Accepted facts (column names, extra field rules) are applied automatically when the call and config leave them unset, and are listed under "memory" in each result; waiting facts are not applied. If the user tells you something Olympus should remember (for example "their key column is legacy_id"), call olympus_learn with the matching kind and tell the user it waits for a named person to accept it ("olympus-of-migration memory accept <id> --as Name", or olympus_accept_learning, which always asks). Tolerances and FX rates are never learned; pass them each time or put them in the config.',
        '1. If a config is given ({{config}}), first tell the user to run `olympus-of-migration validate-config migration_rules {{config}}` if any tool reports an invalid config.',
        '2. Call olympus_compare_exports with source={{source}}, target={{target}} and config={{config}} (omit config if it is "[config]"). Report missing records, duplicates, field differences and totals. Do not explain away a blocking finding.',
        '3. If both trial balances are given, call olympus_tie_out_balances with source={{source_tb}}, target={{target_tb}} and the same config. List every line that does not tie and every unknown balance. Never suggest a value for a blank balance. If FX rates are missing for a currency, say so; never invent a rate.',
        '4. If the config has field_rules (or learned field rules were accepted), call olympus_check_fields on {{target}} and summarise violations by rule with row numbers.',
        '5. If a previous findings.json is given ({{previous_findings}}), call olympus_compare_runs and say what was fixed, what is new and what is still open.',
        '6. Call olympus_readiness_report with the same arguments (and previous_findings when given). Give the user the file paths and the report hash (output_sha256); it is recorded in the audit log.',
        '7. Present the prioritised action list from the report: P1 items block go-live.',
        '',
        'Human step: go-live is approved only by a named person outside this agent, after reading the report. olympus_approve_go_live is blocked in every mode; do not call it to "try". The report is not accounting, tax or audit advice.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'olympus_compare_exports', decision: 'allow' },
    { tool: 'olympus_tie_out_balances', decision: 'allow' },
    { tool: 'olympus_check_fields', decision: 'allow' },
    { tool: 'olympus_compare_runs', decision: 'allow' },
    { tool: 'olympus_readiness_report', decision: 'allow' },
    { tool: 'olympus_approve_go_live', decision: 'block', reason: 'Olympus never approves go-live. A named human signs off after reading the report.' },
    ...MEMORY.rules,
    { tool: '*', decision: 'block', reason: 'Not on the Olympus allowlist.' },
  ] },
});
