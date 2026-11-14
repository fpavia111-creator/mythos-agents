import { createInterface } from 'node:readline';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) for one AgentRuntime.
 * Implements initialize, ping, tools/list and tools/call. No dependencies.
 * Logs go to stderr only; stdout carries protocol messages.
 */
export function createMcpHandler(runtime) {
  const m = runtime.manifest;
  const infoTool = {
    name: 'mythos_info',
    description: 'Show this pack: pinned model, mode, caps, Auto opt-ins, and the allow/ask/block decision for every tool.',
    inputSchema: { type: 'object', properties: {} },
  };

  function toolList() {
    return [infoTool, ...runtime.listTools().map((t) => ({
      name: t.name,
      description: `[${t.decision.toUpperCase()}${t.category ? ' · ' + t.category : ''}] ${t.description}`,
      inputSchema: t.inputSchema,
    }))];
  }

  function text(obj, isError = false) {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError };
  }

  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } } : null;
    }
    const { id, method, params = {} } = msg;
    const isNote = id === undefined || id === null;
    const ok = (result) => (isNote ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (isNote ? null : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const req = params.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED.includes(req) ? req : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: m.name, version: m.version },
          instructions: `${m.name}: ${m.description} Mode: ${runtime.mode}. Pinned model (declared): ${m.model.provider}/${m.model.id}. ` +
            'Tools marked ASK return an approval_id; a named human must approve before the same call runs. Tools marked BLOCK never run.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolList() });
      case 'tools/call': {
        const name = params.name;
        if (name === 'mythos_info') {
          return ok(text({
            name: m.name, version: m.version, description: m.description, model: m.model, mode: runtime.mode,
            caps: runtime.caps, auto_actions: [...runtime.autoActions], kill_switch: runtime.isKilled(),
            tools: runtime.listTools().map(({ name: n, kind, category, decision, reason }) => ({ name: n, kind, category, decision, reason })),
          }));
        }
        if (typeof name !== 'string') return fail(-32602, 'params.name is required');
        const r = await runtime.call(name, params.arguments || {});
        return ok(text(r, r.status === 'blocked' || r.status === 'error'));
      }
      default:
        return isNote ? null : fail(-32601, `Method not found: ${method}`);
    }
  };
}

export function serveStdio(runtime, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler(runtime);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        return;
      }
      try {
        const res = await handle(msg);
        if (res) output.write(JSON.stringify(res) + '\n');
      } catch (err) {
        if (msg && msg.id !== undefined) output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err && err.message || err) } }) + '\n');
      }
    });
  });
  process.stderr.write(`${runtime.manifest.name} MCP server ready on stdio (mode: ${runtime.mode})\n`);
  return rl;
}
