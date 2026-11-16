import { defineManifest, toCsv, sha256, decodeText } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normBank, normGL, reconcile, workpaperCsv, summaryMarkdown, reconciliationHtml } from './recon.js';
import { detectFormat, parseBankText, TABLE_FORMATS } from './bankformats.js';
import { suggestRules, ruleId, MATCH_RULES_SCHEMA } from './rules.js';
import { rollForward } from './rollforward.js';
import { PROMPTS } from './prompts.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const nonEmpty = { type: 'string', minLength: 1 };
const FORMAT = { type: 'string', enum: ['auto', 'csv', 'tsv', 'xlsx', 'json', 'camt053', 'mt940', 'bai2', 'ofx'], description: 'Bank file format. auto (default) uses the extension, then the content.' };
const bankArg = { ...str, description: 'Bank statement: CSV, TSV, Excel or JSON (date, description, reference, amount or debit/credit; several bank download layouts are recognised, see "sources"), CAMT.053 XML, MT940 (.sta), BAI2 (.bai) or OFX/QFX' };
const glArg = { ...str, description: 'GL cash-account detail CSV, TSV, Excel or JSON: date, memo, reference, amount (or debit/credit). NetSuite, QuickBooks Online and Xero report layouts are recognised.' };
const rulesArg = { ...str, description: 'Optional accepted match-rules JSON (schema "match_rules", written by penelope_accept_rule). Rules apply only when this is passed.' };
const files = { bank: bankArg, gl: glArg, bank_format: FORMAT, bank_balance: num, gl_balance: num, date_window: { type: 'number', minimum: 0 }, amount_tolerance: { type: 'number', minimum: 0 }, max_group: { type: 'integer', minimum: 2, maximum: 4 }, rules: rulesArg };
const DEFAULT_OUT = 'mythos-out/penelope';

/** Read a bank statement in any supported format. Returns { format, rows (normalised), closing_balance, ... }. */
export function readStatement(ctx, path, format = 'auto') {
  const abs = ctx.path(path);
  let fmt = format && format !== 'auto' ? format : detectFormat(abs, ''); let text = null;
  // Text formats are decoded like any other file: MT940 and OFX are often Windows-1252.
  const readText = () => decodeText(readFileSync(abs), { lang: ctx.lang }).text;
  if (!fmt) { text = readText(); fmt = detectFormat(abs, text); }
  if (!fmt) throw new Error(`${path}: cannot tell the bank file format; pass bank_format (csv, tsv, xlsx, json, camt053, mt940, bai2, ofx)`);
  // Table files go through the core reader, so bank download layouts are recognised and mapped.
  if (TABLE_FORMATS.includes(fmt)) return { format: fmt, opening_balance: null, closing_balance: null, currency: '', account_hint: '', rows: normBank(ctx.records(path, 'bank')) };
  const p = parseBankText(fmt, text ?? readText());
  return { ...p, rows: normBank(p.rows) };
}
const loadRules = (a, ctx) => (a.rules ? ctx.readJson(a.rules, 'match_rules').rules : []);
function load(a, ctx) {
  const st = readStatement(ctx, a.bank, a.bank_format); const gl = normGL(ctx.records(a.gl));
  let bankBalance = a.bank_balance, source = a.bank_balance !== undefined ? 'argument' : null;
  if (bankBalance === undefined && st.closing_balance !== null && a.gl_balance !== undefined) { bankBalance = st.closing_balance; source = `${st.format} closing balance`; }
  const r = reconcile(st.rows, gl, { ...a, bank_balance: bankBalance, rules: loadRules(a, ctx) });
  if (r.balance) r.balance.bank_balance_source = source;
  return { bank: st.rows, gl, r, format: st.format };
}
function append(ctx, a, file, row, cols) {
  const out = ctx.outDir(a.out_dir || DEFAULT_OUT); const f = join(out, file);
  const csv = toCsv([row], cols); appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}
const need = (a, ks) => { for (const k of ks) if (a[k] === undefined || String(a[k]).trim() === '') throw new Error(`${k} is required`); };

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'penelope-of-recon',
  version: pkg.version,
  description: 'Bank-to-GL reconciliation from exports (CSV/JSON, CAMT.053, BAI2, OFX): proposes matches (reference, amount and date, batched deposits both ways, rules a person accepted), lists items on one side only, ties adjusted balances, rolls outstanding items forward month to month and drafts adjusting entries. Posting an adjusting entry is always one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { match_rules: MATCH_RULES_SCHEMA },
  prompts: PROMPTS,
  tools: [
    {
      name: 'penelope_reconcile', kind: 'read', title: 'Propose matches and tie balances',
      description: 'Propose matches between bank and GL lines, list bank-only and GL-only items, and tie adjusted balances when both balances are given (a CAMT/BAI2/OFX closing balance is used when bank_balance is left out).',
      inputSchema: { type: 'object', required: ['bank', 'gl'], properties: files },
      handler: async (a, ctx) => { const { r, format } = load(a, ctx); return { summary: `${r.matched_groups} proposed match(es); ${r.bank_only.length} bank-only, ${r.gl_only.length} GL-only${r.balance ? `; difference ${r.balance.difference} (${r.balance.ties ? 'ties' : 'does not tie'})` : ''}.`, bank_format: format, ...r }; },
    },
    {
      name: 'penelope_read_statement', kind: 'read', title: 'Read a bank statement file',
      description: 'Parse a bank statement (CSV/JSON, CAMT.053, BAI2, OFX) and show the lines Penelope will use, the opening/closing balance when the file has them, and a check that opening + lines = closing. Account numbers are masked to the last 4.',
      inputSchema: { type: 'object', required: ['bank'], properties: { bank: bankArg, bank_format: FORMAT } },
      handler: async (a, ctx) => {
        const st = readStatement(ctx, a.bank, a.bank_format); const total = Math.round(st.rows.reduce((t, x) => t + (x.amount || 0), 0) * 100) / 100;
        const check = st.opening_balance !== null && st.closing_balance !== null ? { opening: st.opening_balance, lines_total: total, closing: st.closing_balance, ties: Math.abs(st.opening_balance + total - st.closing_balance) < 0.005 } : null;
        return { summary: `${st.format}: ${st.rows.length} line(s), total ${total}${st.closing_balance !== null ? `, closing balance ${st.closing_balance}` : ''}${check ? ` (${check.ties ? 'opening + lines = closing' : 'opening + lines does NOT equal closing'})` : ''}.`, format: st.format, currency: st.currency, account_hint: st.account_hint, opening_balance: st.opening_balance, closing_balance: st.closing_balance, balance_check: check, lines: st.rows.map(({ id, date, description, reference, amount }) => ({ id, date, description, reference, amount })) };
      },
    },
    {
      name: 'penelope_write_workpaper', kind: 'report', title: 'Write the reconciliation workpaper',
      description: 'Write reconciliation.csv (blank reviewer columns), reconciliation.md, reconciliation.html (self-contained, sign-off lines) and proposed-entries.csv into out_dir (default mythos-out/penelope). The HTML hash is logged in the audit line.',
      inputSchema: { type: 'object', required: ['bank', 'gl'], properties: { ...files, out_dir: str } },
      handler: async (a, ctx) => {
        const { bank, gl, r } = load(a, ctx); const out = ctx.outDir(a.out_dir || DEFAULT_OUT); const at = new Date().toISOString();
        const entries = toCsv(r.bank_only.filter((b) => b.adjusting_entry).map((b) => ({ bank_line: b.id, date: b.date, amount: b.amount, account: b.adjusting_entry.account, memo: b.adjusting_entry.memo, status: 'proposed - not posted' })), ['bank_line', 'date', 'amount', 'account', 'memo', 'status']);
        const docs = { 'reconciliation.csv': workpaperCsv(r, bank, gl), 'reconciliation.md': summaryMarkdown(r, at), 'reconciliation.html': reconciliationHtml(r, bank, gl, { at, source: `${a.bank} and ${a.gl}` }), 'proposed-entries.csv': entries };
        const filesOut = Object.entries(docs).map(([n, t]) => ctx.writeFile(out, n, t));
        return { summary: `Workpaper written: ${r.matched_groups} proposed match(es), ${r.bank_only.filter((b) => b.adjusting_entry).length} proposed entr(ies).`, files: filesOut, file_sha256: Object.fromEntries(Object.entries(docs).map(([n, t]) => [n, sha256(t)])), output_sha256: sha256(docs['reconciliation.html']) };
      },
    },
    {
      name: 'penelope_roll_forward', kind: 'read', title: 'Month-end roll-forward',
      description: 'Carry last period\'s outstanding items (from its reconciliation.csv) into this period: which cleared the bank, which are still open with age and a stale flag, new outstanding items, opening − cleared + new = closing, and the adjusted-balance tie-out when both balances are given.',
      inputSchema: { type: 'object', required: ['prior', 'bank', 'gl'], properties: { prior: { ...str, description: "Last period's reconciliation.csv from penelope_write_workpaper" }, ...files, as_of: { type: 'string', format: 'date', description: 'Age items to this date (default: latest date in the files)' }, stale_days: { type: 'integer', minimum: 1, description: 'Flag items older than this (default 60)' } } },
      handler: async (a, ctx) => {
        const st = readStatement(ctx, a.bank, a.bank_format); const gl = normGL(ctx.records(a.gl));
        const bankBalance = a.bank_balance ?? (a.gl_balance !== undefined && st.closing_balance !== null ? st.closing_balance : undefined);
        const r = rollForward(ctx.records(a.prior), st.rows, gl, { ...a, bank_balance: bankBalance, rules: loadRules(a, ctx) });
        return { summary: `Carried ${r.carried_in}, cleared ${r.cleared.length}, still open ${r.still_outstanding.length}, new ${r.new_outstanding.length}, stale ${r.stale}; roll-forward ${r.roll_forward.ties ? 'ties' : 'does not tie'}${r.balance ? `; adjusted balances ${r.balance.ties ? 'tie' : `differ by ${r.balance.difference}`}` : ''}.`, ...r };
      },
    },
    {
      name: 'penelope_suggest_rules', kind: 'read', title: 'Suggest match rules from accepted matches',
      description: 'Learn match rules from matches a person accepted (accepted-matches.csv): description words on each side, money in/out and the largest gap in days. Suggestions only; nothing changes until a person accepts a rule.',
      inputSchema: { type: 'object', required: ['bank', 'gl'], properties: { bank: bankArg, gl: glArg, bank_format: FORMAT, accepted: { ...str, description: `Accepted matches CSV (default ${DEFAULT_OUT}/accepted-matches.csv)` }, rules: rulesArg, min_support: { type: 'integer', minimum: 1, description: 'Accepted pairs needed per rule (default 1)' } } },
      handler: async (a, ctx) => {
        const accepted = a.accepted || `${DEFAULT_OUT}/accepted-matches.csv`;
        if (!ctx.exists(accepted)) throw new Error(`${accepted} not found: accept some matches first (penelope_accept_match)`);
        const st = readStatement(ctx, a.bank, a.bank_format);
        const s = suggestRules(st.rows, normGL(ctx.records(a.gl)), ctx.records(accepted), { min_support: a.min_support ?? 1, existing: loadRules(a, ctx) });
        return { summary: `${s.suggestions.length} rule suggestion(s) from ${accepted}; ${s.skipped.length} pair(s) skipped.`, ...s };
      },
    },
    {
      name: 'penelope_accept_rule', kind: 'write', title: 'Accept a match rule',
      description: 'Record a match rule a person accepted in match-rules.json (out_dir, default mythos-out/penelope). Needs a human yes unless opted in to Auto. Rules apply only when that file is passed as "rules".',
      inputSchema: { type: 'object', required: ['bank_pattern', 'gl_pattern', 'direction', 'max_days'], properties: { bank_pattern: nonEmpty, gl_pattern: nonEmpty, direction: { enum: ['in', 'out'] }, max_days: { type: 'integer', minimum: 0, maximum: 31 }, amount_tolerance: { type: 'number', minimum: 0 }, support: { type: 'integer', minimum: 0 }, note: str, out_dir: str } },
      handler: async (a, ctx) => {
        const out = ctx.outDir(a.out_dir || DEFAULT_OUT); const file = relative(ctx.root, join(out, 'match-rules.json'));
        const doc = ctx.exists(file) ? ctx.readJson(file, 'match_rules') : { version: 1, note: 'Match rules accepted by a person. Used only when passed to penelope_reconcile as "rules".', rules: [] };
        const rule = { id: ruleId(a.bank_pattern.trim().toLowerCase(), a.gl_pattern.trim().toLowerCase(), a.direction), bank_pattern: a.bank_pattern.trim().toLowerCase(), gl_pattern: a.gl_pattern.trim().toLowerCase(), max_days: a.max_days, direction: a.direction,
          ...(a.amount_tolerance !== undefined ? { amount_tolerance: a.amount_tolerance } : {}), ...(a.support !== undefined ? { support: a.support } : {}), accepted_at: new Date().toISOString(), ...(a.note ? { note: a.note } : {}) };
        doc.rules = [...doc.rules.filter((r) => r.id !== rule.id), rule];
        ctx.validate(MATCH_RULES_SCHEMA, doc, 'match-rules.json');
        const text = JSON.stringify(doc, null, 2) + '\n';
        return { summary: `Rule ${rule.id} accepted (${doc.rules.length} rule(s) in ${file}). Pass rules: "${file}" to use it.`, rule, file: ctx.writeFile(out, 'match-rules.json', text), output_sha256: sha256(text) };
      },
    },
    {
      name: 'penelope_accept_match', kind: 'write', title: 'Accept a proposed match',
      description: 'Record that a person accepted a proposed match in accepted-matches.csv. Needs a human yes unless opted in to Auto. Changes nothing in the ledger.',
      inputSchema: { type: 'object', required: ['bank_ids', 'gl_ids'], properties: { bank_ids: nonEmpty, gl_ids: nonEmpty, note: str, out_dir: str } },
      handler: async (a, ctx) => { need(a, ['bank_ids', 'gl_ids']); return { summary: `Match ${a.bank_ids} ↔ ${a.gl_ids} recorded as accepted.`, file: append(ctx, a, 'accepted-matches.csv', { accepted_at: new Date().toISOString(), bank_ids: a.bank_ids, gl_ids: a.gl_ids, note: a.note || '' }, ['accepted_at', 'bank_ids', 'gl_ids', 'note']) }; },
    },
    {
      name: 'penelope_request_adjusting_entry', kind: 'action', category: 'move_money', title: 'Record an adjusting entry request (one-click)',
      description: 'After one named human click (even in Auto), record an approved adjusting entry in adjusting-entry-requests.csv for a person to post. Never posts to the ledger.',
      inputSchema: { type: 'object', required: ['date', 'amount', 'account', 'memo'], properties: { date: nonEmpty, amount: num, account: nonEmpty, memo: nonEmpty, bank_line: str, out_dir: str } },
      handler: async (a, ctx) => { need(a, ['date', 'amount', 'account', 'memo']); return { summary: `Adjusting entry request recorded (${a.amount} to ${a.account}). Nothing was posted.`, file: append(ctx, a, 'adjusting-entry-requests.csv', { requested_at: new Date().toISOString(), date: a.date, amount: a.amount, account: a.account, memo: a.memo, bank_line: a.bank_line || '', status: 'approved request - a person posts it in the ledger' }, ['requested_at', 'date', 'amount', 'account', 'memo', 'bank_line', 'status']) }; },
    },
    { name: 'ledger_post_journal', kind: 'action', category: 'move_money', title: 'Post to ledger (always refused)', description: 'Listed so agents can see it is refused. Penelope never writes to a ledger or ERP.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'penelope_reconcile', decision: 'allow' },
    { tool: 'penelope_read_statement', decision: 'allow' },
    { tool: 'penelope_write_workpaper', decision: 'allow' },
    { tool: 'penelope_roll_forward', decision: 'allow' },
    { tool: 'penelope_suggest_rules', decision: 'allow' },
    { tool: 'penelope_accept_rule', decision: 'ask', reason: 'A match rule changes future matching: a person accepts it (or opts it in to Auto).' },
    { tool: 'penelope_accept_match', decision: 'ask', reason: 'Accepting a match needs a human yes (or an Auto opt-in).' },
    { tool: 'ledger_post_journal', decision: 'block', reason: 'Penelope never posts to a ledger or ERP.' },
    { tool: 'penelope_request_adjusting_entry', decision: 'ask', reason: 'Adjusting entries change the books: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Penelope allowlist.' },
  ] },
});
