import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, AgentRuntime, runEvals } from '../src/index.js';
import { sampleManifest } from './helpers.js';

test('mcp handler: initialize, list, call, errors', async () => {
  const h = createMcpHandler(new AgentRuntime(sampleManifest(), { audit: false }));
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'sample-pack');
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('mythos_info') && names.includes('read_thing'));
  assert.match(list.result.tools.find((t) => t.name === 'go_live').description, /^\[BLOCK/);
  const call = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_thing', arguments: { x: 7 } } });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.result.x, 7);
  const blocked = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'go_live', arguments: {} } });
  assert.equal(blocked.result.isError, true);
  const nf = await h({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(nf.error.code, -32601);
});

test('evals runner', async () => {
  const r = await runEvals(sampleManifest(), [
    { id: 'reads', tool: 'read_thing', args: { x: 'hello' }, expect: { status: 'executed', contains: ['hello'], equals: { 'result.x': 'hello' } } },
    { id: 'go-live-blocked', tool: 'go_live', expect: { decision: 'block' } },
    { id: 'wrong-on-purpose', tool: 'go_live', expect: { status: 'executed' } },
  ]);
  assert.equal(r.passed, 2);
  assert.equal(r.results[2].pass, false);
});
