import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveStdio, AgentRuntime } from '../src/index.js';
import { sampleManifest } from './helpers.js';

test('serveStdio speaks newline-delimited JSON-RPC and survives bad input', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rl = serveStdio(new AgentRuntime(sampleManifest(), { audit: false }), { input, output });
  const got = [];
  output.on('data', (d) => got.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  input.write('not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mythos_info', arguments: {} } }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  rl.close();
  assert.equal(got[0].error.code, -32700);
  assert.ok(got[1].result.tools.length >= 7);
  assert.equal(got[2].result.structuredContent.mode, 'assist');
});
