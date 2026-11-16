// Real-export adapters: sample bank downloads and GL reports in fixtures/exports
// are recognised and mapped onto Penelope's own columns. Each sample holds the
// same (fictional) month as the native fixtures, so the result must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsvRows, writeXlsx } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rec = async (bank, gl, root = fixtures, extra = {}) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('penelope_reconcile', { bank, gl, ...extra });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const shape = (r) => [r.result.matched_groups, r.result.bank_only.map((x) => x.amount).sort(), r.result.gl_only.map((x) => x.amount).sort()];
const NATIVE = [5, [-25, 3.12], [-400, 800]];

test('native files are read untouched', async () => {
  const r = await rec('bank-statement.csv', 'gl-cash.csv');
  assert.equal(r.sources, undefined); assert.deepEqual(shape(r), NATIVE);
});

for (const [file, profile] of [['chase-checking.csv', 'chase_checking'], ['bofa-checking.csv', 'bofa_checking'], ['wells-fargo.csv', 'wells_fargo_csv'], ['capital-one-360.csv', 'capital_one_360'], ['mercury.csv', 'mercury'], ['xero-statement.csv', 'xero_statement_csv']]) {
  test(`bank download ${file} is recognised as ${profile} and reconciles like the native file`, async () => {
    const r = await rec(`exports/${file}`, 'gl-cash.csv');
    const s = r.sources.find((x) => x.kind === 'bank'); assert.equal(s.profile, profile); assert.equal(s.rows, 7); assert.deepEqual(s.warnings, []);
    assert.deepEqual(shape(r), NATIVE);
  });
}

test('bank layouts: summary block and beginning balance skipped, unsigned amounts signed by type, failed rows skipped, headerless columns named', async () => {
  const bofa = (await rec('exports/bofa-checking.csv', 'gl-cash.csv')).sources[0]; assert.equal(bofa.header_row, 6); assert.equal(bofa.skipped_rows, 6, 'five summary lines and the beginning balance line');
  const cap = await rec('exports/capital-one-360.csv', 'gl-cash.csv'); assert.ok(cap.result.bank_only.some((x) => x.amount === -25), 'Debit rows are money out');
  assert.equal((await rec('exports/mercury.csv', 'gl-cash.csv')).sources[0].skipped_rows, 1);
  const wf = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('penelope_read_statement', { bank: 'exports/wells-fargo.csv' });
  assert.equal(wf.status, 'executed', wf.reason); assert.equal(wf.sources[0].profile, 'wells_fargo_csv'); assert.match(wf.sources[0].note, /no header row/);
  assert.match(wf.result.summary, /7 line\(s\), total 1622\.62/);
  const xero = (await rec('exports/xero-statement.csv', 'gl-cash.csv')).sources[0]; assert.equal(xero.dates_read_as, 'day/month/year');
});

test('a card account download is recognised and its note says how the signs run', async () => {
  const r = await new AgentRuntime(manifest, { root: fixtures, audit: false }).call('penelope_read_statement', { bank: 'exports/chase-card.csv' });
  assert.equal(r.sources[0].profile, 'chase_card'); assert.match(r.sources[0].note, /purchases are negative/);
});

for (const [file, profile] of [['netsuite-gl.csv', 'netsuite_transactions'], ['qbo-transaction-detail.csv', 'qbo_transaction_detail'], ['xero-account-transactions.csv', 'xero_account_transactions']]) {
  test(`GL report ${file} is recognised as ${profile}; headings, balances and totals are skipped`, async () => {
    const r = await rec('bank-statement.csv', `exports/${file}`);
    const s = r.sources.find((x) => x.kind === 'gl'); assert.equal(s.profile, profile); assert.equal(s.rows, 8); assert.ok(s.skipped_rows >= 1); assert.deepEqual(s.warnings, []);
    assert.deepEqual(shape(r), NATIVE);
  });
}

test('both sides from exports, the QuickBooks report as an Excel file, and balances tie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pen-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'gl.xlsx'), writeXlsx({ 'Transaction Detail by Account': parseCsvRows(readFileSync(join(fixtures, 'exports/qbo-transaction-detail.csv'), 'utf8')) }));
  const r = await rec('exports/chase-checking.csv', 'gl.xlsx', root, { bank_balance: 11622.62, gl_balance: 12044.5 });
  assert.deepEqual(r.sources.map((s) => [s.kind, s.profile, s.format]), [['bank', 'chase_checking', 'csv'], ['gl', 'qbo_transaction_detail', 'xlsx']]);
  assert.deepEqual(shape(r), NATIVE); assert.equal(r.result.balance.ties, true);
});

test('a NetSuite search with debit and credit columns, and a bank file with withdrawal and deposit columns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pen-src-'));
  writeFileSync(join(root, 'gl.csv'), 'Date,Document Number,Name,Memo,Amount (Debit),Amount (Credit)\n10/1/2026,DEP-1001,Northwind (fictional),Customer receipt,"2,500.00",\n10/3/2026,4101,,Rent October,,"1,200.00"\n');
  writeFileSync(join(root, 'bank.tsv'), 'Value Date\tNarrative\tCheque Number\tPaid Out\tPaid In\n02.10.2026\tDeposit\tDEP-1001\t\t2.500,00\n05.10.2026\tCheque 4101\t4101\t1.200,00\t\n');
  const r = await rec('bank.tsv', 'gl.csv', root);
  assert.equal(r.result.matched_groups, 2); assert.equal(r.result.bank_only.length + r.result.gl_only.length, 0);
  const [b, g] = r.sources; assert.equal(b.format, 'tsv'); assert.equal(b.decimal_mark, ','); assert.equal(b.mapped.debit, 'Paid Out'); assert.equal(g.mapped.credit, 'Amount (Credit)');
});

test('the mapping can be forced per file in mythos-sources.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pen-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'odd.csv'), 'When;What;Sum\n2026-10-02;Deposit;2500.00\n2026-10-31;Monthly service fee;-25.00\n');
  const bare = await new AgentRuntime(manifest, { root, audit: false }).call('penelope_read_statement', { bank: 'odd.csv' });
  assert.match(bare.warnings[0], /odd.csv: None of this file's columns was recognised as: date/); assert.equal(bare.sources[0].adapted, false);
  writeFileSync(join(root, 'mythos-sources.json'), JSON.stringify({ files: { 'odd.csv': { columns: { date: 'When', description: 'What', amount: 'Sum' } } } }));
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('penelope_read_statement', { bank: 'odd.csv' });
  assert.equal(r.status, 'executed', r.reason); assert.match(r.result.summary, /2 line\(s\), total 2475/);
});
