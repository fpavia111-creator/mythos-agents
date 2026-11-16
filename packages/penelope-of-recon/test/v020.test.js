import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, sha256, validate } from 'mythos-agent-core';
import { manifest, normBank, normGL, reconcile, parseCamt053, parseBai2, parseOfx, detectFormat, suggestRules, rollForward, pattern, MATCH_RULES_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const read = (f) => readFileSync(join(fixtures, f), 'utf8');
const csvBank = () => normBank(parseCsv(read('bank-statement.csv')));
const glOct = () => normGL(parseCsv(read('gl-cash.csv')));
const strip = (rows) => rows.map(({ id, date, description, reference, amount }) => ({ id, date, description, reference, amount }));
const rt = (root = fixtures, o = {}) => new AgentRuntime(manifest, { root, audit: false, ...o });

test('CAMT.053, BAI2 and OFX parse to the same records as the CSV fixture', () => {
  const want = strip(csvBank());
  for (const [file, fn] of [['bank-statement.camt053.xml', parseCamt053], ['bank-statement.bai', parseBai2], ['bank-statement.ofx', parseOfx]]) {
    const p = fn(read(file));
    assert.deepEqual(strip(normBank(p.rows)), want, file);
    assert.equal(p.closing_balance, 12422.88, file);
  }
  assert.equal(parseCamt053(read('bank-statement.camt053.xml')).opening_balance, 10800.26);
  assert.equal(parseBai2(read('bank-statement.bai')).opening_balance, 10800.26);
});

test('format detection, bad files and masked account numbers', () => {
  assert.equal(detectFormat('x.xml', read('bank-statement.camt053.xml')), 'camt053');
  assert.equal(detectFormat('x.txt', read('bank-statement.bai')), 'bai2');
  assert.equal(detectFormat('x.qfx', ''), 'ofx');
  assert.equal(detectFormat('x.txt', 'hello'), null);
  assert.throws(() => parseCamt053('<Document/>'), /camt\.053/);
  assert.throws(() => parseBai2('02,x/'), /BAI2/);
  assert.throws(() => parseOfx('nothing'), /OFX/);
  for (const p of [parseCamt053(read('bank-statement.camt053.xml')), parseBai2(read('bank-statement.bai')), parseOfx(read('bank-statement.ofx'))]) {
    assert.equal(p.account_hint, '••••6789'); assert.ok(!JSON.stringify(p).includes('000123456789'));
  }
  // camt namespace prefixes and XML entities
  const ns = '<n:Document xmlns:n="urn:x"><n:BkToCstmrStmt><n:Stmt><n:Ntry><n:Amt Ccy="EUR">10.50</n:Amt><n:CdtDbtInd>DBIT</n:CdtDbtInd><n:BookgDt><n:Dt>2026-10-01</n:Dt></n:BookgDt><n:AddtlNtryInf>Fee &amp; charges</n:AddtlNtryInf></n:Ntry></n:Stmt></n:BkToCstmrStmt></n:Document>';
  const p = parseCamt053(ns); assert.deepEqual(p.rows[0], { date: '2026-10-01', description: 'Fee & charges', reference: '', amount: -10.5 }); assert.equal(p.currency, 'EUR');
});

test('reconcile reads any format; the statement closing balance is used for the tie-out', async () => {
  for (const bank of ['bank-statement.camt053.xml', 'bank-statement.bai', 'bank-statement.ofx']) {
    const r = await rt().call('penelope_reconcile', { bank, gl: 'gl-cash.csv', gl_balance: 12844.76 });
    assert.equal(r.status, 'executed', r.reason); assert.equal(r.result.matched_groups, 5, bank);
    assert.equal(r.result.balance.ties, true, bank); assert.match(r.result.balance.bank_balance_source, /closing balance/);
  }
  const s = await rt().call('penelope_read_statement', { bank: 'bank-statement.camt053.xml' });
  assert.equal(s.result.balance_check.ties, true); assert.equal(s.result.lines.length, 7);
  assert.equal((await rt().call('penelope_read_statement', { bank: 'bank-statement.csv', bank_format: 'mt940' })).status, 'error');
});

test('one GL line equal to several bank lines is proposed as group_bank', () => {
  const b = normBank([{ date: '2026-10-30', description: 'Payroll A', amount: '-700' }, { date: '2026-10-30', description: 'Payroll B', amount: '-300' }]);
  const g = normGL([{ date: '2026-10-30', memo: 'Payroll October', amount: '-1000' }]);
  const r = reconcile(b, g); assert.equal(r.matches[0].type, 'group_bank'); assert.deepEqual(r.matches[0].bank, ['B2', 'B3']);
});

test('a learned rule is shown, and applied only after the user accepts it', async () => {
  const root = tmpRoot('pen-rule-'); const auto = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['penelope_accept_match'] });
  assert.equal((await auto.call('penelope_accept_match', { bank_ids: 'B4', gl_ids: 'G4', note: 'ACH Acme' })).status, 'executed');
  assert.equal((await auto.call('penelope_accept_match', { bank_ids: 'B2', gl_ids: 'G2' })).status, 'executed');
  const s = await rt(root).call('penelope_suggest_rules', { bank: 'bank-statement.csv', gl: 'gl-cash.csv' });
  assert.equal(s.status, 'executed', s.reason);
  assert.equal(s.result.suggestions.length, 1, 'reference pair is skipped');
  const sug = s.result.suggestions[0];
  assert.equal(sug.bank_pattern, 'ach acme supply fictional'); assert.equal(sug.direction, 'out'); assert.equal(sug.max_days, 1); assert.match(sug.plain, /ach acme supply/);
  // Not applied yet: with date_window 0 the ACH pair stays unmatched.
  const before = await rt(root).call('penelope_reconcile', { bank: 'bank-statement.csv', gl: 'gl-cash.csv', date_window: 0 });
  assert.equal(before.result.matched_groups, 3);
  // Accepting needs a person's yes.
  const args = { bank_pattern: sug.bank_pattern, gl_pattern: sug.gl_pattern, direction: sug.direction, max_days: sug.max_days, support: sug.support };
  const ask = await new AgentRuntime(manifest, { root }).call('penelope_accept_rule', args);
  assert.equal(ask.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(ask.approval_id, 'Robin');
  const ok = await new AgentRuntime(manifest, { root }).call('penelope_accept_rule', args);
  assert.equal(ok.status, 'executed', ok.reason); assert.equal(ok.result.rule.id, sug.id);
  const after = await rt(root).call('penelope_reconcile', { bank: 'bank-statement.csv', gl: 'gl-cash.csv', date_window: 0, rules: 'mythos-out/penelope/match-rules.json' });
  const m = after.result.matches.find((x) => x.type === 'rule');
  assert.ok(m); assert.deepEqual([m.bank, m.gl], [['B4'], ['G4']]); assert.equal(after.result.matched_groups, 4);
  assert.equal((await rt(root).call('penelope_suggest_rules', { bank: 'bank-statement.csv', gl: 'gl-cash.csv', rules: 'mythos-out/penelope/match-rules.json' })).result.suggestions[0].already_accepted, true);
});

test('rules learn from words, not numbers; unmatched descriptions do not match', () => {
  assert.equal(pattern('ACH Acme #77 Inv 2026-10'), 'ach acme inv');
  const bank = normBank([{ date: '2026-11-09', description: 'ACH Acme Supply (fictional) 991', amount: '-60' }, { date: '2026-11-09', description: 'ACH Other', amount: '-60' }]);
  const gl = normGL([{ date: '2026-11-08', memo: 'Acme Supply bill pay (fictional)', amount: '-60' }]);
  const rule = { id: 'R-00000000', bank_pattern: 'ach acme supply fictional', gl_pattern: 'acme supply bill pay fictional', direction: 'out', max_days: 1 };
  const r = reconcile(bank, gl, { rules: [rule], date_window: 0 });
  assert.equal(r.matches[0].type, 'rule'); assert.deepEqual(r.matches[0].bank, ['B2']);
  const s = suggestRules(bank, gl, [{ bank_ids: 'B2 B3', gl_ids: 'G2' }]); assert.equal(s.skipped[0].reason, 'not one-to-one');
});

test('match-rules schema: three mutated configs fail with JSON-pointer errors', async () => {
  const good = { version: 1, rules: [{ id: 'R-0123abcd', bank_pattern: 'ach acme', gl_pattern: 'acme', max_days: 1, direction: 'out' }] };
  assert.ok(validate(MATCH_RULES_SCHEMA, good).ok);
  const root = tmpRoot('pen-cfg-');
  const cases = [
    ['unknown-key', { ...good, rules: [{ ...good.rules[0], max_day: 2 }] }, /\/rules\/0\/max_day/],
    ['wrong-type', { ...good, rules: [{ ...good.rules[0], max_days: '1' }] }, /\/rules\/0\/max_days/],
    ['missing-required', { version: 1, rules: [{ id: 'R-0123abcd', bank_pattern: 'x', gl_pattern: 'y', max_days: 1 }] }, /\/rules\/0\/direction/],
  ];
  for (const [name, cfg, re] of cases) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(cfg));
    const r = await rt(root).call('penelope_reconcile', { bank: 'bank-statement.csv', gl: 'gl-cash.csv', rules: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason + JSON.stringify(r.errors || []), re, name);
  }
});

test('month-end roll-forward: outstanding items carry forward and tie out', async () => {
  const prior = parseCsv(read('reconciliation-2026-10.csv'));
  const r = rollForward(prior, normBank(parseCsv(read('bank-2026-11.csv'))), normGL(parseCsv(read('gl-cash-2026-11.csv'))), { bank_balance: 16047.88, gl_balance: 15452.88, as_of: '2026-11-30' });
  assert.equal(r.carried_in, 2);
  assert.deepEqual(r.cleared.map((c) => [c.prior_item, c.cleared_by]), [['G9', 'B2']]);
  assert.deepEqual(r.still_outstanding.map((c) => [c.prior_item, c.age_days]), [['G8', 32]]);
  assert.deepEqual(r.new_outstanding.map((c) => c.description), ['Check 4106 Hooli Cleaning (fictional)']);
  assert.deepEqual(r.roll_forward, { opening_outstanding: 400, cleared: 800, new_outstanding: -220, closing_outstanding: -620, check: 0, ties: true });
  assert.equal(r.balance.ties, true); assert.equal(r.balance.adjusted_bank, 15427.88);
  assert.equal(r.prior_bank_only_to_check.length, 2);
  // Stale flag and a check that never clears
  const late = rollForward(prior, normBank(parseCsv(read('bank-2026-11.csv'))), normGL(parseCsv(read('gl-cash-2026-11.csv'))), { as_of: '2027-01-15', stale_days: 60 });
  assert.equal(late.stale, 1); assert.equal(late.closing_outstanding[0].prior_item, 'G8');
  // A carried check with a reference does not clear against a different check number.
  const other = rollForward([{ item: 'G1', type: 'outstanding_payment', date: '2026-10-01', description: 'Check 1', reference: '1001', amount: '-50' }], normBank([{ date: '2026-10-10', description: 'Check 1002', reference: '1002', amount: '-50' }]), []);
  assert.equal(other.cleared.length, 0);
});

test('workpaper adds HTML with sign-off lines; hashes match the files and reach the audit log', async () => {
  const root = tmpRoot('pen-wp-');
  const r = await new AgentRuntime(manifest, { root }).call('penelope_write_workpaper', { bank: 'bank-statement.ofx', gl: 'gl-cash.csv', gl_balance: 12844.76, out_dir: 'out' });
  assert.equal(r.status, 'executed', r.reason);
  const html = readFileSync(join(root, 'out', 'reconciliation.html'), 'utf8');
  assert.equal(r.result.output_sha256, sha256(html)); assert.match(html, /Reviewed by/); assert.match(html, /ties/); assert.ok(!/<script/i.test(html));
  assert.equal(r.result.file_sha256['reconciliation.csv'], sha256(readFileSync(join(root, 'out', 'reconciliation.csv'), 'utf8')));
  const audit = readFileSync(join(root, '.mythos', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.at(-1).output_sha256, r.result.output_sha256);
});

test('new tools keep the policy: accept_rule asks, entries stay one-click, invalid args refused first', async () => {
  const p = (t) => manifest.policy.rules.find((r) => r.tool === t).decision;
  assert.equal(p('penelope_accept_rule'), 'ask'); assert.equal(p('penelope_roll_forward'), 'allow');
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['penelope_request_adjusting_entry'] }), /one-click/);
  const bad = await rt(fixtures, { mode: 'auto' }).call('penelope_request_adjusting_entry', { date: '2026-11-30', amount: '-25', account: 'Bank fees expense', memo: 'Nov fee' });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments/);
  assert.equal((await rt(fixtures, { mode: 'review' }).call('penelope_accept_rule', { bank_pattern: 'a', gl_pattern: 'b', direction: 'in', max_days: 1 })).status, 'blocked');
  assert.ok(manifest.prompts.find((x) => x.name === 'month_end_bank_rec'));
});

test('a German MT940 statement in Windows-1252 is read, balanced and reconciled', async () => {
  const root = tmpRoot('penelope-mt940-');
  writeFileSync(join(root, 'gl-2026-11-de.csv'), 'Buchungsdatum,Buchungstext,Belegnummer,Soll,Haben\n2026-11-02,Bürobedarf Müller (fiktiv),INV-2026-118,,"1.250,00"\n2026-11-03,Zahlung Beispiel AG (fiktiv),RE-4711,"4.800,00",\n');
  const s = await rt(root).call('penelope_read_statement', { bank: 'exports/statement-mt940.sta' });
  assert.equal(s.status, 'executed', JSON.stringify(s));
  assert.equal(s.result.format, 'mt940'); assert.equal(s.result.lines.length, 3); assert.equal(s.result.balance_check.ties, true);
  assert.ok(s.result.lines.some((l) => /Bürobedarf Müller GmbH/.test(l.description)), 'umlauts decoded from Windows-1252');
  assert.ok(s.result.lines.some((l) => l.reference === 'INV-2026-118'), 'the EREF+ end-to-end reference becomes the reference');
  assert.ok(s.result.lines.some((l) => l.amount === -100), 'a reversed credit (RC) takes money out');
  const r = await rt(root).call('penelope_reconcile', { bank: 'exports/statement-mt940.sta', gl: 'gl-2026-11-de.csv' });
  assert.equal(r.status, 'executed', JSON.stringify(r)); assert.equal(r.result.matched_groups, 2, JSON.stringify(r.result));
});
