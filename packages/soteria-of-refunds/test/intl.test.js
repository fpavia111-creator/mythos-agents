// Disputes written in the cardholder's language, and the JCB and UnionPay networks.
// Every reason text here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDispute, detectNetwork } from '../src/index.js';

test('reason text in nine languages lands in the right category instead of "general"', () => {
  const cases = [
    ['Ware nicht erhalten', 'not_received'], ['Produit non reçu', 'not_received'], ['Produto não recebido', 'not_received'], ['商品が届いていない', 'not_received'], ['未收到货物', 'not_received'], ['상품을 받지 못했습니다', 'not_received'],
    ['Cobro duplicado', 'duplicate'], ['二重請求', 'duplicate'], ['重复扣款', 'duplicate'], ['중복 결제', 'duplicate'],
    ['身に覚えのない請求', 'fraud'], ['盗刷', 'fraud'], ['Transacción no autorizada', 'fraud'], ['부정사용 의심', 'fraud'],
    ['Prodotto danneggiato', 'not_as_described'], ['説明と異なる商品', 'not_as_described'], ['파손된 상품', 'not_as_described'],
    ['Abonnement gekündigt', 'cancelled_recurring'], ['구독 해지 후 정기결제', 'cancelled_recurring'],
    ['Remboursement non reçu', 'credit_not_processed'], ['返金されていない', 'credit_not_processed'], ['환불되지 않았습니다', 'credit_not_processed'],
  ];
  for (const [reason, want] of cases) {
    const c = classifyDispute({ reason });
    assert.equal(c.category, want, reason); assert.equal(c.source, 'reason_text');
  }
  assert.equal(classifyDispute({ reason: 'about the order' }).category, 'general', 'an unrelated text stays general');
  assert.equal(classifyDispute({ reason: 'Item not received' }).category, 'not_received', 'English as before');
});

test('network names in other scripts; JCB and UnionPay are recognised but classified from the text', () => {
  assert.equal(detectNetwork('', 'ビザ'), 'visa'); assert.equal(detectNetwork('', '마스터카드'), 'mastercard'); assert.equal(detectNetwork('', '美国运通'), 'amex');
  assert.equal(detectNetwork('', 'JCB'), 'jcb'); assert.equal(detectNetwork('', '银联'), 'unionpay'); assert.equal(detectNetwork('', 'China UnionPay'), 'unionpay');
  const j = classifyDispute({ network: 'JCB', reason_code: '541', reason: '商品未着' });
  assert.equal(j.network, 'jcb'); assert.equal(j.category, 'not_received'); assert.match(j.label, /Unknown code/);
  assert.equal(classifyDispute({ network: 'MasterCard', reason_code: '4853' }).category, 'not_as_described', 'known codes still win');
});
