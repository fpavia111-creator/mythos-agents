// Contact lists from CRMs in other markets: consent, status and bounce values, and
// role mailboxes. Every address uses a reserved example domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, statusOf, normContacts } from '../src/index.js';

const base = { id: '', email: '', name: 'Fictional Person', company: '', last_activity: '2026-11-01', bounce: '', consent: '', consent_date: '', consent_source: 'form', unsubscribed: '', status: '' };
// Rows go through normContacts, as a file does.
const run = (rows) => audit(normContacts(rows.map((r, i) => ({ ...base, id: `C${i + 1}`, email: `person${i + 1}@example.com`, ...r }))), { as_of: '2026-11-16' }).items;

test('consent values in nine languages: yes is consent, no is no consent', () => {
  const yesVals = ['ja', 'oui', 'sí', 'sim', 'sì', 'はい', '同意済み', '已同意', '동의', 'eingewilligt', 'Accepté'];
  for (const v of yesVals) { const [it] = run([{ consent: v }]); assert.ok(!it.flags.includes('no_consent') && !it.flags.includes('consent_unknown'), v); }
  const noVals = ['nein', 'non', 'no', 'não', 'いいえ', '拒否', '不同意', '거부', 'widerrufen', 'Désabonné'];
  for (const v of noVals) { const [it] = run([{ consent: v }]); assert.ok(it.flags.includes('no_consent'), v); assert.equal(it.suggested_action, 'suppress', v); }
});

test('status and bounce words from other markets', () => {
  assert.equal(statusOf('Abgemeldet'), 'unsubscribed'); assert.equal(statusOf('配信停止'), 'unsubscribed'); assert.equal(statusOf('수신거부'), 'unsubscribed');
  assert.equal(statusOf('Abonné'), 'subscribed'); assert.equal(statusOf('Subscribed'), 'subscribed'); assert.equal(statusOf('cleaned'), 'cleaned', 'English values as before');
  const [a, b, c] = run([{ status: 'Abgemeldet', consent: 'ja' }, { bounce: 'ハードバウンス' }, { bounce: 'rebote temporal' }]);
  assert.equal(a.suggested_action, 'suppress');
  assert.ok(b.flags.includes('hard_bounce')); assert.ok(c.flags.includes('soft_bounce'));
});

test('role mailboxes in other languages are flagged; personal ones are not', () => {
  const items = audit(['kontakt@example.de', 'ventas@example.es', 'contato@example.com.br', 'amministrazione@example.it', 'eigyo@example.jp', 'maria.rossi@example.it'].map((email, i) => ({ ...base, id: `R${i}`, email, consent: 'yes', consent_date: '2026-10-01' })), { as_of: '2026-11-16' }).items;
  assert.deepEqual(items.map((x) => x.flags.includes('role_address')), [true, true, true, true, true, false]);
});
