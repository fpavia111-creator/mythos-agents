// Ladon on access exports from Japan, Korea and Germany, and the summary and
// evidence page in other languages. Every person, company and account is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AgentRuntime, parseCsv } from 'mythos-agent-core';
import { manifest, normalizeAccess, reviewAccess, campaignStatus, evidencePack, statusWord, summaryMarkdown, LADON_TEXT } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), 'ladon-intl-'));
// Write text in a legacy encoding (Python's codecs; Node can only write UTF-8).
const encode = (file, text, enc) => execFileSync('python3', ['-c', 'import sys; open(sys.argv[1], "wb").write(sys.stdin.buffer.read().decode("utf-8").encode(sys.argv[2]))', file, enc], { input: text });
let hasPython = true; try { execFileSync('python3', ['-c', 'pass']); } catch { hasPython = false; }

test('status words from other languages: disabled rows are skipped, leavers are found', () => {
  assert.equal(statusWord('Gesperrt'), 'disabled'); assert.equal(statusWord('Désactivé'), 'disabled'); assert.equal(statusWord('無効'), 'disabled');
  assert.equal(statusWord('削除済み'), 'deleted'); assert.equal(statusWord('휴면'), 'inactive'); assert.equal(statusWord('Activo'), 'active');
  assert.equal(statusWord('Probezeit'), 'probezeit', 'an unknown word keeps its own value');
  const rows = normalizeAccess([
    { system: 'ERP', user: 'Kim Minji', email: 'minji@example.com', role: '관리자', status: '활성', mfa: '아니요', last_login: '2026-11-01' },
    { system: 'ERP', user: 'Lee Jun', email: 'jun@example.com', role: '조회', status: '비활성', last_login: '2026-11-01' },
    { system: 'ERP', user: 'Anna Beispiel', email: 'anna@example.com', role: 'Lesen', status: 'aktiv', last_login: '2026-11-01' },
  ]);
  const roster = new Map([['anna@example.com', { status: 'ausgeschieden', manager: 'Max Muster' }], ['minji@example.com', { status: '재직', manager: 'Park Boss' }]]);
  const r = reviewAccess(rows, roster, { as_of: '2026-11-16' });
  assert.equal(r.accounts, 2); assert.equal(r.skipped_disabled, 1);
  const kim = r.items.find((i) => i.user === 'Kim Minji'), anna = r.items.find((i) => i.user === 'Anna Beispiel');
  assert.ok(kim.flags.includes('privileged_role'), '관리자 (administrator) is privileged');
  assert.ok(kim.flags.includes('privileged_without_mfa'), '아니요 in the MFA column means no MFA');
  assert.ok(anna.flags.includes('terminated_in_hr'), '"ausgeschieden" is a leaver');
});

test('privileged roles, SoD rules and learned roles written in Japanese, Chinese or Korean match', () => {
  const rows = normalizeAccess([
    { system: '会計', user: '山田 太郎', email: 'yamada@example.com', role: 'システム管理者', last_login: '2026-11-01' },
    { system: '会計', user: '佐藤 花子', email: 'sato@example.com', role: '仕入先登録', last_login: '2026-11-01' },
    { system: '銀行', user: '佐藤 花子', email: 'sato@example.com', role: '支払実行', last_login: '2026-11-01' },
    { system: 'Treasury', user: 'Wang Fang', email: 'wang@example.com', role: '金庫番', last_login: '2026-11-01' },
    { system: 'Sport', user: 'Coach', email: 'coach@example.com', role: 'Badminton coach', last_login: '2026-11-01' },
  ]);
  const r = reviewAccess(rows, null, { as_of: '2026-11-16', sod_rules: [{ name: 'vendor-vs-payment', roles_a: ['仕入先登録'], roles_b: ['支払実行'] }], extra_privileged_roles: ['金庫番'] });
  const by = (u, s) => r.items.find((i) => i.user === u && (!s || i.system === s));
  assert.ok(by('山田 太郎').flags.includes('privileged_role'));
  assert.equal(r.sod_conflicts.length, 1, 'a rule written in Japanese finds the conflict'); assert.equal(r.sod_conflicts[0].person, 'sato@example.com');
  assert.ok(by('Wang Fang').flags.includes('privileged_role'), 'a learned role in Chinese characters matches');
  assert.ok(!by('Coach').flags.includes('privileged_role'), 'Admin is still not found inside Badminton');
});

test('a Shift_JIS access export and HR roster with Japanese headers, summary in Japanese', { skip: !hasPython && 'python3 not available to write Shift_JIS' }, async () => {
  const d = dir();
  encode(join(d, 'access.csv'), [
    'システム,ユーザー,メールアドレス,権限,最終ログイン,状態,多要素認証,担当者',
    '会計システム,山田 太郎,yamada@example.com,システム管理者,2026/10/01,有効,いいえ,架空 次郎',
    '会計システム,佐藤 花子,sato@example.com,閲覧者,2026/11/01,有効,はい,架空 次郎',
    '会計システム,鈴木 一郎,suzuki@example.com,閲覧者,2026/11/01,無効,はい,架空 次郎',
  ].join('\r\n') + '\r\n', 'cp932');
  encode(join(d, 'roster.csv'), 'メールアドレス,氏名,状態,退職日,上長\r\nyamada@example.com,山田 太郎,在職,,架空 次郎\r\nsato@example.com,佐藤 花子,退職,2026/10/31,架空 次郎\r\n', 'cp932');
  const rt = new AgentRuntime(manifest, { root: d, lang: 'ja' });
  const r = await rt.call('ladon_recert_sheet', { access: 'access.csv', roster: 'roster.csv', as_of: '2026-11-16' });
  assert.equal(r.status, 'executed', JSON.stringify(r)); assert.equal(r.result.language, 'ja');
  assert.ok(r.warnings.some((w) => /Shift_JIS/.test(w)), 'the guessed encoding is reported');
  const sheet = parseCsv(readFileSync(join(d, 'mythos-out/ladon/recertification.csv'), 'utf8'));
  assert.equal(sheet.length, 2, 'the 無効 (disabled) row is skipped');
  assert.ok('reviewer_decision' in sheet[0], 'CSV columns stay in English');
  const yamada = sheet.find((x) => x.user === '山田 太郎'), sato = sheet.find((x) => x.user === '佐藤 花子');
  assert.match(yamada.flags, /privileged_role/); assert.match(yamada.flags, /privileged_without_mfa/);
  assert.match(sato.flags, /terminated_in_hr/); assert.equal(sato.suggested_action, 'revoke candidate');
  const md = readFileSync(join(d, 'mythos-out/ladon/recertification-summary.md'), 'utf8');
  assert.match(md, /# アクセス権の棚卸し/); assert.match(md, /多要素認証のない特権アカウント/); assert.match(md, /人事名簿で退職者/);
  assert.match(md, /Claude による翻訳/); assert.match(md, /`reviewer_decision`/, 'column names stay in English');
  assert.match(md, /証拠にはなりません/, 'the limitation sentence is kept');
});

test('evidence page in German; the JSON record and its hash do not change with the language', async () => {
  const s = campaignStatus(parseCsv(readFileSync(join(fixtures, 'recertification-filled.csv'), 'utf8')), { as_of: '2026-12-01' });
  const en = evidencePack(s, { sheet_sha256: 'x', sheet_path: 'p' }), de = evidencePack(s, { sheet_sha256: 'x', sheet_path: 'p', lang: 'de' });
  assert.equal(de.record_sha256, en.record_sha256); assert.equal(de.json, en.json);
  assert.match(de.html, /<html lang="de">/); assert.match(de.html, /Stichtag 2026-12-01/); assert.match(de.html, /Überfällig/); assert.match(de.html, /kein Prüfungsurteil/);
  assert.match(en.html, /As of 2026-12-01/); assert.match(en.html, /access recertification — evidence/);
  if (s.overdue) assert.match(de.html, /überfällig \(fällig/);
  const root = mkdtempSync(join(tmpdir(), 'ladon-intl-ev-')); cpSync(fixtures, root, { recursive: true });
  const r = await new AgentRuntime(manifest, { root }).call('ladon_evidence_pack', { sheet: 'recertification-filled.csv', as_of: '2026-12-01', language: 'ko' });
  assert.equal(r.status, 'executed', JSON.stringify(r)); assert.equal(r.result.language, 'ko');
  assert.match(readFileSync(r.result.files[1], 'utf8'), /감사 의견도 아닙니다/);
});

test('English summary is unchanged by the language work', () => {
  const rows = normalizeAccess([{ system: 'X', user: 'Pat', email: 'pat@example.com', role: 'Admin', owner: 'Lee', last_login: 'never' }]);
  const md = summaryMarkdown(reviewAccess(rows, null, { as_of: '2026-11-16' }), '2026-11-16T00:00:00Z');
  assert.match(md, /^# Access recertification\n/); assert.match(md, /Role looks privileged/); assert.match(md, /\| medium \| 2026-11-30 \|/);
  assert.doesNotMatch(md, /Claude/);
});

test('every Ladon string exists in all nine languages, with the same placeholders', () => {
  for (const [k, v] of Object.entries(LADON_TEXT)) {
    const want = (v.en.match(/\{\w+\}/g) || []).sort().join();
    for (const l of ['de', 'fr', 'es', 'pt', 'it', 'ja', 'zh', 'ko']) {
      assert.equal(typeof v[l], 'string', `${k}.${l}`);
      if (k !== 'translation_note') assert.ok(v[l].length, `${k}.${l} is empty`);
      assert.equal((v[l].match(/\{\w+\}/g) || []).sort().join(), want, `${k}.${l} placeholders`);
    }
  }
});
