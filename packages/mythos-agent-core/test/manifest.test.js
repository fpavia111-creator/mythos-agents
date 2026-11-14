import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineManifest, ManifestError } from '../src/index.js';
import { sampleManifest } from './helpers.js';

const base = { name: 'x', version: '1.0.0', description: 'd', model: { provider: 'p', id: 'm-2025' } };

test('valid manifest is frozen', () => {
  const m = sampleManifest();
  assert.ok(Object.isFrozen(m));
  assert.equal(m.policy.default, 'block');
});

test('rejects unpinned model', () => {
  assert.throws(() => defineManifest({ ...base, model: { provider: 'p', id: 'latest' }, tools: [{ name: 'a_b', kind: 'read', description: 'x' }], policy: { rules: [{ tool: '*', decision: 'allow' }] } }), /not a pin/);
});

test('rejects write tool marked allow', () => {
  assert.throws(() => defineManifest({ ...base, tools: [{ name: 'do_write', kind: 'write', description: 'w' }], policy: { rules: [{ tool: 'do_write', decision: 'allow' }] } }), ManifestError);
});

test('rejects tool with no rule', () => {
  assert.throws(() => defineManifest({ ...base, tools: [{ name: 'lonely', kind: 'read', description: 'r' }], policy: { rules: [{ tool: 'other', decision: 'allow' }] } }), /no policy rule/);
});

test('rejects one-click category marked allow', () => {
  assert.throws(() => defineManifest({ ...base, tools: [{ name: 'pay', kind: 'report', category: 'move_money', description: 'r' }], policy: { rules: [{ tool: 'pay', decision: 'allow' }] } }), /move_money/);
});

test('rejects non-block default', () => {
  assert.throws(() => defineManifest({ ...base, tools: [{ name: 'a_b', kind: 'read', description: 'r' }], policy: { default: 'allow', rules: [{ tool: '*', decision: 'allow' }] } }), /fail closed/);
});
