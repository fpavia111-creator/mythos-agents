import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineManifest } from '../src/index.js';

export const tmp = () => mkdtempSync(join(tmpdir(), 'mythos-core-'));

export function sampleManifest(extra = {}) {
  return defineManifest({
    name: 'sample-pack', version: '0.0.1', description: 'Test pack.',
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
    tools: [
      { name: 'read_thing', kind: 'read', description: 'reads', handler: async (a) => ({ summary: 'read one thing', x: a.x }) },
      { name: 'write_thing', kind: 'write', description: 'writes', handler: async () => ({ summary: 'wrote' }) },
      { name: 'go_live', kind: 'action', category: 'go_live', description: 'go live', handler: async () => ({ summary: 'live' }) },
      { name: 'revoke', kind: 'action', category: 'revoke_access', description: 'revoke', handler: async () => ({ summary: 'revoked' }) },
      { name: 'post_tweet', kind: 'action', category: 'binding_send', description: 'never' },
      { name: 'pricey', kind: 'read', description: 'costs', costUsd: 2, handler: async () => ({ summary: 'ok' }) },
    ],
    policy: { rules: [
      { tool: 'read_thing', decision: 'allow' }, { tool: 'pricey', decision: 'allow' },
      { tool: 'write_thing', decision: 'ask', reason: 'writes need a human' },
      { category: 'revoke_access', decision: 'ask' },
      { tool: 'go_live', decision: 'block', reason: 'never auto-approve go-live' },
      { tool: '*', decision: 'block' },
    ] },
    ...extra,
  });
}
