// Olympus on exports from Japan, Germany and Brazil, and the readiness report in
// other languages. Every company, account and amount here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';
import { compareExports, tieOutBalances, reportMarkdown, actionList } from '../src/checks.js';
import { OLYMPUS_TEXT } from '../src/text.js';

const dir = () => mkdtempSync(join(tmpdir(), 'olympus-intl-'));
// Write text in a legacy encoding (Python's codecs; Node can only write UTF-8).
const encode = (file, text, enc) => execFileSync('python3', ['-c', 'import sys; open(sys.argv[1], "wb").write(sys.stdin.read().encode(sys.argv[2]))', file, enc], { input: text });
let hasPython = true; try { execFileSync('python3', ['-c', 'pass']); } catch { hasPython = false; }

test('Japanese headers are told apart and found without naming them', () => {
  const src = [{ 伝票番号: 'D-1', 取引先: '架空商事', 金額: '1,200円' }, { 伝票番号: 'D-2', 取引先: 'サンプル運輸', 金額: '△300' }];
  const tgt = [{ 伝票番号: 'D-1', 取引先: '架空商事', 金額: '1200' }, { 伝票番号: 'D-2', 取引先: 'サンプル運輸', 金額: '-300' }];
  const r = compareExports(src, tgt);
  assert.deepEqual(r.key, { source: '伝票番号', target: '伝票番号' });
  assert.equal(r.totals.source.column, '金額'); assert.equal(r.totals.source.total, 900); assert.equal(r.totals.difference, 0);
  assert.equal(r.counts.field_mismatches, 0, '1,200円 and 1200 are the same amount'); assert.equal(r.status, 'clean');
});

test('German trial balance: "1.234" is a thousand and more when the column uses decimal commas', () => {
  const src = [{ Konto: '1200', Saldo: '1.234' }, { Konto: '1400', Saldo: '2.500,50' }, { Konto: '3000', Saldo: '-3.734,50' }];
  const tgt = [{ Konto: '1200', Saldo: '1234,00' }, { Konto: '1400', Saldo: '2500,5' }, { Konto: '3000', Saldo: '-3734,5' }];
  const tb = tieOutBalances(src, tgt, {});
  assert.equal(tb.status, 'ties', JSON.stringify(tb.not_tied)); assert.equal(tb.accounts, 3); assert.equal(tb.net.source, 0);
});

test('Brazilian invoice export: R$ amounts and Portuguese column names', () => {
  const src = [{ 'ID externo': 'NF-1', Valor: 'R$ 1.234,56' }, { 'ID externo': 'NF-2', Valor: 'R$ 10,00' }];
  const tgt = [{ 'ID externo': 'NF-1', Valor: '1234.56' }];
  const r = compareExports(src, tgt);
  assert.equal(r.key.source, 'ID externo'); assert.equal(r.totals.source.total, 1244.56); assert.equal(r.totals.difference, 10);
  assert.deepEqual(r.missing_in_target, ['NF-2']);
});

test('Shift_JIS trial balances from a Japanese system tie out end to end', { skip: !hasPython && 'python3 not available to write Shift_JIS' }, async () => {
  const d = dir();
  encode(join(d, 'src-tb.csv'), '勘定科目,残高\r\n現金,"1,000"\r\n売掛金,"2,500"\r\n買掛金,"△3,500"\r\n', 'cp932');
  encode(join(d, 'tgt-tb.csv'), '勘定科目,残高\r\n現金,1000\r\n売掛金,2400\r\n買掛金,-3500\r\n', 'cp932');
  const rt = new AgentRuntime(manifest, { root: d, lang: 'ja' });
  const r = await rt.call('olympus_tie_out_balances', { source: 'src-tb.csv', target: 'tgt-tb.csv' });
  assert.equal(r.status, 'executed', JSON.stringify(r));
  assert.equal(r.result.accounts, 3); assert.equal(r.result.not_tied.length, 1); assert.equal(r.result.not_tied[0].account, '売掛金'); assert.equal(r.result.not_tied[0].difference, 100);
  assert.ok(r.warnings.some((w) => /Shift_JIS/.test(w)), 'the guessed encoding is reported');
});

test('readiness report in Japanese, German and Korean; English stays as it was', async () => {
  const d = dir();
  writeFileSync(join(d, 's.csv'), 'externalid,amount\nA-1,100\nA-2,50\n');
  writeFileSync(join(d, 't.csv'), 'externalid,amount\nA-1,100\n');
  const rt = new AgentRuntime(manifest, { root: d, lang: 'ja' });
  let r = await rt.call('olympus_readiness_report', { source: 's.csv', target: 't.csv', out_dir: 'ja' });
  assert.equal(r.status, 'executed', JSON.stringify(r)); assert.equal(r.result.language, 'ja');
  const ja = readFileSync(join(d, 'ja/readiness-report.md'), 'utf8');
  assert.match(ja, /# 移行準備状況レポート/); assert.match(ja, /本番稼働: \*\*未承認\.\*\*/); assert.match(ja, /移行元の 1 件が移行先にありません: A-2/); assert.match(ja, /Claude による翻訳/);
  assert.match(ja, /`missing_in_target`/, 'codes stay in English');
  const html = readFileSync(join(d, 'ja/readiness-report.html'), 'utf8'); assert.match(html, /<html lang="ja">/); assert.match(html, /移行準備状況レポート/);
  const findings = JSON.parse(readFileSync(join(d, 'ja/findings.json'), 'utf8')); assert.match(findings.compare.findings[0].message, /source record\(s\) are not in the target/);
  r = await rt.call('olympus_readiness_report', { source: 's.csv', target: 't.csv', out_dir: 'de', language: 'de' });
  const de = readFileSync(join(d, 'de/readiness-report.md'), 'utf8');
  assert.match(de, /Produktivstart: \*\*nicht freigegeben\.\*\*/); assert.match(de, /1 Quelldatensätze fehlen im Ziel/); assert.match(de, /BLOCKIEREND/);
  r = await rt.call('olympus_readiness_report', { source: 's.csv', target: 't.csv', out_dir: 'ko', language: 'ko' });
  assert.match(readFileSync(join(d, 'ko/readiness-report.md'), 'utf8'), /원본 레코드 1건이 대상에 없습니다/);
  r = await new AgentRuntime(manifest, { root: d }).call('olympus_readiness_report', { source: 's.csv', target: 't.csv', out_dir: 'en' });
  const en = readFileSync(join(d, 'en/readiness-report.md'), 'utf8');
  assert.match(en, /# Migration readiness report/); assert.match(en, /Data status: \*\*BLOCKING\*\*/); assert.match(en, /- \*\*blocking\*\* `missing_in_target`: 1 source record\(s\) are not in the target: A-2/);
  assert.doesNotMatch(en, /Claude/);
  r = await rt.call('olympus_readiness_report', { source: 's.csv', target: 't.csv', language: 'tlh' });
  assert.equal(r.status, 'error', 'an unknown language is refused by the schema');
});

test('every report string exists in all nine languages, with the same placeholders', () => {
  for (const [k, v] of Object.entries(OLYMPUS_TEXT)) {
    const want = (v.en.match(/\{\w+\}/g) || []).sort().join();
    for (const l of ['de', 'fr', 'es', 'pt', 'it', 'ja', 'zh', 'ko']) {
      assert.equal(typeof v[l], 'string', `${k}.${l}`);
      if (k !== 'translation_note') assert.ok(v[l].length, `${k}.${l} is empty`);
      assert.equal((v[l].match(/\{\w+\}/g) || []).sort().join(), want, `${k}.${l} placeholders`);
    }
  }
  // Every action and finding code has a translation.
  const cmp = compareExports([{ id: '1', amount: '5' }, { id: '1', amount: 'x' }, { id: '', amount: '1' }], [{ id: '2', amount: '1' }, { id: '2', amount: '1' }], { subsidiary_column: 'sub' });
  const md = reportMarkdown({ cmp, tb: null, fields: null, actions: actionList({ cmp }), runs: null, generatedAt: '2026-11-16T00:00:00Z', lang: 'fr' });
  for (const f of cmp.findings) assert.ok(OLYMPUS_TEXT[`f_${f.code}`], f.code);
  assert.doesNotMatch(md, /source record\(s\)|duplicate key\(s\)/, 'no English finding left in a French report');
});
