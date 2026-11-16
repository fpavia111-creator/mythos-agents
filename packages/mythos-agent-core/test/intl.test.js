// Exports from the seven biggest business-software markets and the two blind
// spots (Italian, Korean): encodings, amounts, dates, column names, and the
// language of the pages people read. Every fixture is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntime, defineManifest, normHeader, cleanAmount, inferDecimal, toNumber, numberReader, parseAnyDate, readTable, adaptRecords,
  decodeText, encodingName, translatedNames, namesFor, COLUMN_WORDS, COLUMN_LANGUAGES, foldText, normLang, makeText, CORE_TEXT, LANGS, htmlPage, serveApprovals, ApprovalStore, normalizeName, stripLegalTail,
} from '../src/index.js';
import { tmp } from './helpers.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intl');

test('header names compare in any script; ASCII headers compare exactly as before', () => {
  assert.equal(normHeader(' E-mail Address '), 'emailaddress'); assert.equal(normHeader('#'), '#'); assert.equal(normHeader('——————'), '');
  assert.equal(normHeader('Währung'), 'wahrung'); assert.equal(normHeader('WÄHRUNG'), normHeader('Wahrung'));
  assert.equal(normHeader('Straße'), 'strasse'); assert.equal(normHeader('Ａｍｏｕｎｔ'), 'amount');
  assert.equal(normHeader('勘定科目'), '勘定科目'); assert.equal(normHeader('거래 일자'), '거래일자'); assert.equal(normHeader('金额（元）'), '金额元');
  assert.notEqual(normHeader('金額'), normHeader('摘要'), 'two CJK headers no longer both become ""');
  assert.equal(normHeader('ガス代'), 'ガス代', 'Japanese voiced marks survive');
  assert.equal(foldText('Société Générale S.A.'), 'societe generale s a'); assert.equal(foldText('株式会社　山田'), '株式会社 山田');
});

test('amounts as each market writes them', () => {
  const cases = {
    '1.234,56 €': '1234.56', '-12,50': '-12.50', '1 234,56': '1234.56', '1 234,56': '1234.56', '12,5': '12.5',
    'R$ 1.234,56': '1234.56', '-R$ 12,50': '-12.50', 'CHF 1’234.50': '1234.50', '1 234,56 zł': '1234.56', '1.234,56 kr.': '1234.56',
    '1,200円': '1200', '￥1,200': '1200', '△3,400': '-3400', '▲1,000': '-1000', '１２３': '123', '－５': '-5',
    '₩12,000': '12000', '￦12,000': '12000', '12,000원': '12000', '-3,400원': '-3400', '¥1,200.00': '1200.00', '1,200元': '1200', 'RMB 88': '88', 'NT$1,200': '1200',
    '₹1,00,000': '100000', 'Rs. 12,34,567.50': '1234567.50', 'EUR -12,50': '-12.50', 'usd 7': '7',
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(cleanAmount(k), v, k);
  for (const bad of ['INV12', '12 apples', 'n/a', 'abc', '1,2,3x', '12%', '2026-11-14']) assert.equal(cleanAmount(bad), null, bad);
  assert.equal(inferDecimal(['1.234,56', '12,50', '1.000']), ',');
  assert.equal(inferDecimal(['1,234.56', '12.50']), '.');
});

test('toNumber no longer reads European decimals as thousands', () => {
  assert.equal(toNumber('12,5'), 12.5, 'was 125');
  assert.equal(toNumber('1.234,56'), 1234.56, 'was 1.23456');
  assert.equal(toNumber('1 234,56'), 1234.56, 'was 123456');
  assert.equal(toNumber('1,200円'), 1200); assert.equal(toNumber('△1,200'), -1200); assert.equal(toNumber('₹1,00,000'), 100000);
  // What read before reads the same.
  for (const [k, v] of [['$1,500.25', 1500.25], ['(200)', -200], ['1,234', 1234], ['1e3', 1000], ['-0.5', -0.5], ['12-', -12], [7, 7]]) assert.equal(toNumber(k), v, String(k));
  for (const bad of ['', 'n/a', 'INV12', null, undefined, NaN]) assert.equal(toNumber(bad), null, String(bad));
  // With the column's decimal mark known, "1.234" is a thousand and more.
  assert.equal(toNumber('1.234'), 1.234); assert.equal(toNumber('1.234', { decimal: ',' }), 1234);
  const read = numberReader(['1.234,56', '2.000,00', '1.234']); assert.equal(read('1.234'), 1234); assert.equal(read('12,5'), 12.5);
});

test('dates in German, French, Spanish, Portuguese, Italian, Japanese, Chinese and Korean forms', () => {
  const d = (v, o) => { const r = parseAnyDate(v, o); return r && r.date; };
  const cases = {
    '14. November 2026': '2026-11-14', '14. Nov. 2026': '2026-11-14', '3. März 2026': '2026-03-03', 'Montag, 16. November 2026': '2026-11-16',
    '14 novembre 2026': '2026-11-14', '1er décembre 2026': '2026-12-01', 'lundi 16 novembre 2026': '2026-11-16', '14 févr. 2026': '2026-02-14', '14 août 2026': '2026-08-14',
    '14 de noviembre de 2026': '2026-11-14', 'lunes, 16 de noviembre de 2026': '2026-11-16', '14-ene-2026': '2026-01-14',
    '16 de novembro de 2026': '2026-11-16', 'segunda-feira, 16 de novembro de 2026': '2026-11-16', '3 de março de 2026': '2026-03-03', '14 out 2026': '2026-10-14',
    '14 novembre 2026 ': '2026-11-14', '14 ott 2026': '2026-10-14', '1 gennaio 2026': '2026-01-01', '14 dicembre 2026': '2026-12-14',
    '2026年11月14日': '2026-11-14', '２０２６年１１月１４日': '2026-11-14', '令和8年11月14日': '2026-11-14', '令和元年5月1日': '2019-05-01', 'R8.11.14': '2026-11-14', '平成31年4月30日': '2019-04-30',
    '2026年11月14号': '2026-11-14', '民國115年11月14日': '2026-11-14',
    '2026. 11. 14.': '2026-11-14', '2026년 11월 14일': '2026-11-14', '2026.11.14': '2026-11-14',
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(d(k), v, k);
  assert.equal(parseAnyDate('2026年11月14日 14時05分').iso, '2026-11-14T14:05:00');
  assert.equal(parseAnyDate('2026/11/14 午後2:05').iso, '2026-11-14T14:05:00');
  assert.equal(parseAnyDate('2026. 11. 14. 오후 2:05').iso, '2026-11-14T14:05:00');
  assert.equal(parseAnyDate('14/11/2026 à 10h30').iso, '2026-11-14T10:30:00');
  // Era dates outside their era, and garbage, are not dates.
  for (const bad of ['平成32年1月1日', '令和1年4月30日', 'Janxyz 3 2026', 'jui 3 2026', 'abc 2026', '2026年13月1日']) assert.equal(parseAnyDate(bad), null, bad);
  // English as before.
  assert.equal(d('Nov 3, 2026'), '2026-11-03'); assert.equal(d('Tue, 3 Nov 2026'), '2026-11-03'); assert.equal(d('Mar 14, 2026'), '2026-03-14');
});

test('text encodings: legacy CJK and European files decode, and a guess says so', () => {
  const want = { 'ja-shift_jis.csv': ['shift_jis', '日付'], 'ko-euc-kr.csv': ['euc-kr', '거래일자'], 'zh-gbk.csv': ['gb18030', '日期'], 'zh-big5.csv': ['big5', '日期'], 'de-windows-1252.csv': ['windows-1252', 'Datum'],
    'nohdr-ja.csv': ['shift_jis', '項目'], 'nohdr-ko.csv': ['euc-kr', '항목'], 'nohdr-zh.csv': ['gb18030', '项目'], 'nohdr-de.csv': ['windows-1252', 'Posten'] };
  for (const [f, [enc, first]] of Object.entries(want)) {
    const t = readTable(join(FX, f));
    assert.equal(t.encoding.name, enc, f); assert.equal(t.encoding.how, 'guessed', f); assert.equal(t.matrix[0][0], first, f);
  }
  assert.deepEqual(readTable(join(FX, 'fr-utf8-bom.csv')).encoding, { name: 'utf-8', how: 'bom' });
  assert.deepEqual(readTable(join(FX, 'pt-br.csv')).encoding, { name: 'utf-8', how: 'utf-8' });
  const u16 = readTable(join(FX, 'ja-utf16.txt')); assert.equal(u16.encoding.name, 'utf-16le'); assert.equal(u16.delimiter, '\t'); assert.equal(u16.matrix[1][1], '事務用品');
  // Set by the user: no guess.
  const set = readTable(join(FX, 'ja-shift_jis.csv'), { encoding: 'cp932' }); assert.deepEqual(set.encoding, { name: 'shift_jis', how: 'set' });
  assert.equal(encodingName('SJIS'), 'shift_jis'); assert.equal(encodingName('cp949'), 'euc-kr'); assert.equal(encodingName('klingon'), null);
  assert.throws(() => decodeText(Buffer.from('a'), { encoding: 'klingon' }), /unknown encoding/);
  // A UTF-8 file never goes through the guess, whatever language it is in.
  assert.equal(decodeText(Buffer.from('金額,日付\n1,2\n')).how, 'utf-8');
});

const LEDGER = {
  label: 'Ledger lines', args: ['file'],
  fields: {
    date: { type: 'date', aliases: ['Transaction Date'], required: true },
    description: { aliases: ['Memo'] },
    vendor: { aliases: ['Supplier'] },
    amount: { type: 'money', aliases: ['Total'], required: true },
    currency: { aliases: ['Curr'] },
  },
};

test('exports from each market map onto the agent\'s own columns', () => {
  const read = (f) => adaptRecords(readTable(join(FX, f)), LEDGER, { kind: 'ledger', arg: 'file', file: f });
  const expect = {
    'ja-shift_jis.csv': [['2026-11-14', '1200'], ['2026-11-15', '-3400'], ['2026-11-16', '12000']],
    'ko-euc-kr.csv': [['2026-11-14', '12000'], ['2026-11-15', '-3400']],
    'zh-gbk.csv': [['2026-11-14', '1200.00'], ['2026-11-15', '-340.50']],
    'zh-big5.csv': [['2026-11-14', '1200'], ['2026-11-15', '-340']],
    'de-windows-1252.csv': [['2026-11-14', '1234.56'], ['2026-11-15', '-12.50'], ['2026-11-16', '2000.00']],
    'fr-utf8-bom.csv': [['2026-11-14', '1234.56'], ['2026-11-15', '-12.50']],
    'pt-br.csv': [['2026-11-14', '1234.56'], ['2026-11-16', '-12.50']],
  };
  for (const [f, rows] of Object.entries(expect)) {
    const r = read(f);
    assert.deepEqual(r.rows.map((x) => [x.date, x.amount]), rows, f);
    assert.deepEqual(r.report.missing, [], f);
    assert.ok(r.report.translated_columns && r.report.translated_columns.amount, f);
    for (const k of ['description', 'vendor', 'currency']) assert.ok(r.rows[0][k], `${f}: ${k}`);
  }
  const de = read('de-windows-1252.csv');
  assert.deepEqual(de.report.translated_columns.amount, { column: 'Betrag', language: 'de' });
  assert.equal(de.report.decimal_mark, ','); assert.equal(de.report.encoding, 'windows-1252');
  assert.ok(de.report.warnings.some((w) => /not UTF-8; it was read as Windows-1252/.test(w)));
  assert.equal(de.rows[1].description, 'Fahrtkosten Köln');
  const fr = read('fr-utf8-bom.csv');
  assert.equal(fr.report.encoding, undefined, 'UTF-8 is not reported'); assert.ok(!fr.report.warnings.some((w) => /UTF-8/.test(w)));
  assert.equal(fr.report.dates_read_as, 'day/month/year');
});

test('translated names only fill fields that are still empty, and never take a used column', () => {
  const t = (rows) => ({ format: 'csv', matrix: rows });
  // English alias wins; the German column stays unmapped.
  let r = adaptRecords(t([['Total', 'Betrag', 'Transaction Date'], ['5', '9', '2026-11-14']]), LEDGER, {});
  assert.equal(r.rows[0].amount, '5'); assert.equal(r.report.translated_columns, undefined); assert.ok(r.report.unmapped.includes('Betrag'));
  // The agent's own names: untouched, as before.
  r = adaptRecords(t([['date', 'amount', 'Betrag'], ['2026-11-14', '5', '9']]), LEDGER, {});
  assert.equal(r.report.adapted, false); assert.equal(r.rows[0].Betrag, '9');
  // Opting out and pointing a field at another concept.
  const DEF = { fields: { debit: { type: 'money', translate: 'ledger_debit' }, credit: { type: 'money', translate: false }, amount: { type: 'money' } } };
  r = adaptRecords(t([['Soll', 'Haben', 'Ausgang'], ['10', '20', '30']]), DEF, {});
  assert.equal(r.rows[0].debit, '10', 'ledger debit, not a bank withdrawal'); assert.equal(r.rows[0].credit, undefined); assert.ok(!r.report.mapped.credit);
  // Every dictionary entry has all eight languages.
  for (const [k, v] of Object.entries(COLUMN_WORDS)) for (const l of COLUMN_LANGUAGES) assert.ok(Array.isArray(v[l]) && v[l].length, `${k}.${l}`);
  assert.ok(translatedNames('amount').some((x) => x.word === '금액' && x.lang === 'ko')); assert.ok(translatedNames('description').some((x) => x.word === '摘要' && x.lang === 'ja, zh')); assert.deepEqual(namesFor('balance', 'ja'), ['残高', '期末残高']);
});

test('yes and no in a yes/no column, in all nine languages and as form marks', () => {
  const DEF = { fields: { user: { required: true, aliases: ['User Name'] }, mfa: { type: 'bool', aliases: ['MFA Enabled'] } } };
  const yes = ['yes', 'Ja', 'oui', 'Sí', 'sim', 'sì', 'はい', '有効', '○', '是', '已启用', '예', '사용'];
  const no = ['no', 'Nein', 'non', 'não', 'いいえ', '無効', '×', '否', '未启用', '아니요', '미사용'];
  const t = { format: 'csv', matrix: [['User Name', 'MFA Enabled'], ...yes.map((v) => ['a', v]), ...no.map((v) => ['b', v]), ['c', 'vielleicht']] };
  const r = adaptRecords(t, DEF, {});
  assert.deepEqual(r.rows.map((x) => x.mfa), [...yes.map(() => 'yes'), ...no.map(() => 'no'), 'vielleicht'], 'an unknown word is kept as it is');
});

test('file names and slugs keep Japanese, Chinese and Korean names, and stay safe', async () => {
  const { safeFileName, slugify, uniqueNames, normalizeName } = await import('../src/index.js');
  assert.equal(safeFileName('株式会社架空商事'), '株式会社架空商事'); assert.equal(safeFileName('가상상사'), '가상상사'); assert.equal(safeFileName('Müller GmbH'), 'Muller-GmbH');
  assert.equal(safeFileName('../../etc/passwd'), 'etc-passwd'); assert.equal(safeFileName('evil\u202Etxt.exe'), 'evil-txt.exe', 'direction overrides are dropped'); assert.equal(safeFileName('CON'), '_CON');
  assert.equal(slugify('Acme, Inc.'), 'acme-inc'); assert.equal(slugify('虚构贸易有限公司'), '虚构贸易有限公司'); assert.equal(slugify('', 'vendor'), 'vendor');
  const u = uniqueNames(); assert.deepEqual(['a.md', 'A.md', 'a.md', 'b'].map(u), ['a.md', 'A-2.md', 'a-3.md', 'b']);
  assert.equal(normalizeName('ｶ)ｶｸｳｼｮｳｼﾞ'), 'カクウショウジ', 'half-width bank names are unified and lose the カ) legal form');
});

test('mythos-sources.json can set a file\'s encoding; an unknown one is refused', async () => {
  const root = tmp(); copyFileSync(join(FX, 'zh-gbk.csv'), join(root, 'a.csv'));
  const m = defineManifest({
    name: 'ledger-pack', version: '0.0.1', description: 'Test.', model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
    tools: [{ name: 'read_ledger', kind: 'read', description: 'reads', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } }, handler: async (a, ctx) => ({ summary: 'ok', rows: ctx.records(a.file), lang: ctx.lang }) }],
    policy: { rules: [{ tool: 'read_ledger', decision: 'allow' }, { tool: '*', decision: 'block' }] },
    sources: { ledger: LEDGER },
  });
  let rt = new AgentRuntime(m, { root, lang: 'zh-CN' });
  let r = await rt.call('read_ledger', { file: 'a.csv' });
  assert.equal(r.status, 'executed'); assert.equal(r.result.lang, 'zh'); assert.equal(r.result.rows[0].amount, '1200.00');
  assert.ok(r.warnings.some((w) => /read as GB18030/.test(w)));
  writeFileSync(join(root, 'mythos-sources.json'), JSON.stringify({ files: { 'a.csv': { encoding: 'gbk' } } }));
  rt = new AgentRuntime(m, { root });
  r = await rt.call('read_ledger', { file: 'a.csv' });
  assert.equal(r.result.rows[1].description, '差旅费'); assert.ok(!(r.warnings || []).some((w) => /a guess/.test(w))); assert.equal(r.result.lang, 'en');
  writeFileSync(join(root, 'mythos-sources.json'), JSON.stringify({ files: { 'a.csv': { encoding: 'klingon' } } }));
  r = await new AgentRuntime(m, { root }).call('read_ledger', { file: 'a.csv' });
  assert.equal(r.status, 'error'); assert.match(r.reason, /klingon/);
});

test('a file read without column mapping still warns when its encoding was guessed', async () => {
  const root = tmp(); copyFileSync(join(FX, 'ko-euc-kr.csv'), join(root, 'k.csv'));
  const m = defineManifest({
    name: 'raw-pack', version: '0.0.1', description: 'Test.', model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
    tools: [{ name: 'read_raw', kind: 'read', description: 'reads', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } }, handler: async (a, ctx) => ({ summary: 'ok', rows: ctx.records(a.file) }) }],
    policy: { rules: [{ tool: 'read_raw', decision: 'allow' }, { tool: '*', decision: 'block' }] },
  });
  const r = await new AgentRuntime(m, { root }).call('read_raw', { file: 'k.csv' });
  assert.equal(r.result.rows[0]['적요'], '사무용품'); assert.ok(r.warnings.some((w) => /EUC-KR/.test(w)));
});

test('languages: names, fallbacks and every core string in all nine', () => {
  assert.equal(normLang('pt-BR'), 'pt'); assert.equal(normLang('zh_Hans_CN'), 'zh'); assert.equal(normLang('ja-JP'), 'ja'); assert.equal(normLang('xx'), 'en'); assert.equal(normLang(undefined), 'en');
  const t = makeText({ hi: { en: 'Hello {name}', de: 'Hallo {name}' } }, 'de'); assert.equal(t('hi', { name: 'Ana' }), 'Hallo Ana');
  assert.equal(makeText({ hi: { en: 'Hello' } }, 'ko')('hi'), 'Hello', 'missing language falls back to English');
  for (const [k, v] of Object.entries(CORE_TEXT)) for (const l of LANGS) assert.equal(typeof v[l], 'string', `${k}.${l}`);
  assert.match(htmlPage({ title: 'x', bodyHtml: '', lang: 'pt' }), /<html lang="pt-BR">/); assert.match(htmlPage({ title: 'x', bodyHtml: '' }), /<html lang="en">/);
});

test('the approvals page speaks the approver\'s language and keeps the one-click warning', async () => {
  const root = tmp(); const state = join(root, '.mythos'); mkdirSync(state, { recursive: true });
  const store = new ApprovalStore(state);
  store.request({ agent: 'demo-pack', tool: 'revoke', args: { user: 'ana' }, reason: 'needs a person', category: 'revoke_access', one_click: true });
  const s = await serveApprovals({ stateDir: state, port: 0, lang: 'ja', agent: 'demo-pack' });
  try {
    const ja = await (await fetch(s.url)).text();
    assert.match(ja, /<html lang="ja">/); assert.match(ja, /1回だけ承認/); assert.match(ja, /ワンクリック操作/); assert.match(ja, /アクセス取り消し/); assert.match(ja, /Claude による翻訳/);
    const ko = await (await fetch(`${s.url}?lang=ko`)).text();
    assert.match(ko, /<html lang="ko">/); assert.match(ko, /한 번 승인/); assert.match(ko, /value="ko"/);
    const en = await (await fetch(`${s.url}?lang=en`)).text();
    assert.match(en, /Approve once/); assert.doesNotMatch(en, /Claude による/);
  } finally { await s.close(); }
});

test('Latin American and Southern European details: month words between slashes, legal forms at the end', () => {
  for (const [v, want] of [['14/NOV/2026', '2026-11-14'], ['03/ene/2026', '2026-01-03'], ['14/out/2026', '2026-10-14'], ['14-Nov-26', '2026-11-14']]) assert.equal(parseAnyDate(v)?.date, want, v);
  assert.equal(parseAnyDate('14/xyz/2026'), null, 'an unknown word is not a month');
  for (const n of ['Ejemplo S.L.', 'Ejemplo, S.A. de C.V.', 'Ejemplo S. de R.L. de C.V.', 'Exemplo S/A', 'Exemplo EPP', 'Beispiel SE']) assert.ok(['ejemplo', 'exemplo', 'beispiel'].includes(normalizeName(n)), n);
  assert.equal(normalizeName('SL Green Realty'), 'sl green realty', 'S.L. only counts at the end');
  assert.equal(stripLegalTail('acme s.a. de c.v.').trim(), 'acme');
});

test('Windows-1252 bytes 0x80-0x9F decode to the euro sign, quotes and dashes on every Node version', () => {
  const buf = Buffer.from([0x42, 0x65, 0x74, 0x72, 0x61, 0x67, 0x3b, 0x80, 0x20, 0x93, 0x78, 0x94, 0x20, 0x96, 0x20, 0xe9, 0x0a]);
  const set = decodeText(buf, { encoding: 'windows-1252' });
  assert.equal(set.text, 'Betrag;€ “x” – é\n');
  assert.equal(decodeText(buf, { encoding: 'latin1' }).text, set.text, 'ISO-8859-1 reads as browsers read it');
  const guessed = decodeText(buf, { lang: 'de' });
  assert.equal(guessed.encoding, 'windows-1252'); assert.equal(guessed.text, set.text);
  assert.equal(cleanAmount('1.234,56 ' + set.text[7]), '1234.56');
});
