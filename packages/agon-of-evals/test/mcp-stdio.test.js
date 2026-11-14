import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/agon-of-evals.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

function session(args) {
  const child = spawn(process.execPath, [bin, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const my = ++id; const t = setTimeout(() => reject(new Error('timeout ' + method)), 10000);
    waiting.set(my, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, request, notify };
}

test('stdio MCP smoke test: initialize, list tools, call one', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agon-of-evals-mcp-'));
  const s = session(['--root', fixtures, '--state-dir', state]);
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'agon-of-evals');
    s.notify('notifications/initialized');
    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('mythos_info'));
    assert.ok(names.includes('agon_grade'));
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
    const call = await s.request('tools/call', { name: 'agon_grade', arguments: { suite: "suite.json", responses: "candidate.jsonl" } });
    assert.equal(call.result.isError, false, call.result.content[0].text);
    assert.equal(call.result.structuredContent.status, 'executed');
    assert.match(call.result.content[0].text, /update_vendor_bank/);
    const blocked = await s.request('tools/call', { name: 'shell_exec', arguments: { cmd: 'whoami' } });
    assert.equal(blocked.result.isError, true);
    assert.ok(existsSync(join(state, 'audit.jsonl')), 'audit log written to state dir');
  } finally { s.child.kill(); }
});
