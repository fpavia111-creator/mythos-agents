import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentRuntime } from './runtime.js';
import { serveStdio } from './mcp.js';
import { runEvalFile } from './evals.js';
import { ApprovalStore } from './approvals.js';

export function parseFlags(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

export function runtimeFromFlags(manifest, flags) {
  const env = process.env;
  const mode = flags.mode || env.MYTHOS_MODE || 'assist';
  const auto = String(flags.auto || env.MYTHOS_AUTO_ACTIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const caps = {};
  if (flags['max-steps'] || env.MYTHOS_MAX_STEPS) caps.maxSteps = Number(flags['max-steps'] || env.MYTHOS_MAX_STEPS);
  if (flags['max-spend'] || env.MYTHOS_MAX_SPEND_USD) caps.maxSpendUsd = Number(flags['max-spend'] || env.MYTHOS_MAX_SPEND_USD);
  return new AgentRuntime(manifest, {
    mode, autoActions: auto, caps,
    root: flags.root || env.MYTHOS_ROOT || process.cwd(),
    stateDir: flags['state-dir'] || env.MYTHOS_STATE_DIR || undefined,
  });
}

function usage(manifest, bin) {
  return `${manifest.name} ${manifest.version} — ${manifest.description}

Usage:
  ${bin} mcp                      Start the stdio MCP server
  ${bin} tools                    List tools and their allow/ask/block decision
  ${bin} call <tool> '<json>'     Run one tool through the policy gate
  ${bin} demo                     Run the built-in demo on the bundled fixtures
  ${bin} eval [cases.json]        Run the private evals (default: bundled cases)
  ${bin} approve <id> --as "Name" Approve one "ask" action (a human, once)
  ${bin} kill | unkill            Engage or clear the kill switch (.mythos/KILL)

Options:
  --mode review|assist|auto       Default assist. Auto is opt-in per action:
  --auto tool_a,tool_b            Actions allowed to run without asking in Auto
  --max-steps N --max-spend USD   Caps (always enforced)
  --root DIR                      Folder the tools may read/write (default: cwd)
  --state-dir DIR                 Audit log, approvals, kill file (default: <root>/.mythos)
`;
}

/** Shared CLI for every pack. opts: { bin, demo: async (manifest) => void, evalFile } */
export async function runCli(manifest, argv, opts = {}) {
  const bin = opts.bin || manifest.name;
  const { flags, pos } = parseFlags(argv);
  const cmd = pos[0];
  const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n');
  if (!cmd || cmd === 'help' || flags.help) { out(usage(manifest, bin)); return 0; }
  if (cmd === 'version' || flags.version) { out(manifest.version); return 0; }
  if (cmd === 'mcp') { serveStdio(runtimeFromFlags(manifest, flags)); return null; }
  if (cmd === 'tools') {
    const rt = runtimeFromFlags(manifest, flags);
    out(`mode: ${rt.mode}   model pin (declared): ${manifest.model.provider}/${manifest.model.id}`);
    for (const t of rt.listTools()) out(`  ${t.decision.padEnd(5)}  ${t.name.padEnd(34)} ${t.kind}${t.category ? ' · ' + t.category : ''}`);
    return 0;
  }
  if (cmd === 'call') {
    const rt = runtimeFromFlags(manifest, flags);
    let args = {};
    if (pos[2]) { try { args = JSON.parse(pos[2]); } catch { out('arguments must be JSON'); return 2; } }
    const r = await rt.call(pos[1], args);
    out(r);
    return r.status === 'executed' || r.status === 'needs_approval' ? 0 : 1;
  }
  if (cmd === 'approve') {
    const dir = resolve(flags.dir || flags['state-dir'] || join(flags.root || process.cwd(), '.mythos'));
    const rec = new ApprovalStore(dir).approve(pos[1], flags.as, flags.note || '');
    out(`Approved ${rec.id} as ${rec.approved_by}. It can be used once.`);
    return 0;
  }
  if (cmd === 'kill' || cmd === 'unkill') {
    const dir = resolve(flags['state-dir'] || join(flags.root || process.cwd(), '.mythos'));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'KILL');
    if (cmd === 'kill') { writeFileSync(f, `engaged ${new Date().toISOString()}\n`); out(`Kill switch engaged: ${f}`); }
    else { if (existsSync(f)) rmSync(f); out('Kill switch cleared.'); }
    return 0;
  }
  if (cmd === 'eval') {
    const file = pos[1] ? resolve(pos[1]) : opts.evalFile;
    if (!file) { out('no cases file'); return 2; }
    const r = await runEvalFile(manifest, file);
    for (const c of r.results) out(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}${c.fails.length ? '  — ' + c.fails.join('; ') : ''}`);
    out(`${r.passed}/${r.total} passed`);
    return r.passed === r.total ? 0 : 1;
  }
  if (cmd === 'demo') {
    if (!opts.demo) { out('no demo for this pack'); return 2; }
    await opts.demo(manifest, flags);
    return 0;
  }
  out(`unknown command "${cmd}"\n\n` + usage(manifest, bin));
  return 2;
}

export function main(manifest, opts) {
  runCli(manifest, process.argv.slice(2), opts).then((code) => { if (code !== null) process.exitCode = code; })
    .catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
}
