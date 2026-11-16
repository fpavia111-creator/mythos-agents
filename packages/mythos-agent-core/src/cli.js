import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { AgentRuntime } from './runtime.js';
import { serveStdio } from './mcp.js';
import { runEvalFile } from './evals.js';
import { ApprovalStore } from './approvals.js';
import { writeEvalReport } from './eval-report.js';
import { serveApprovals } from './approvals-server.js';
import { generateSigningKey, loadSigner, loadPublicKeys } from './signing.js';
import { AuditLog, readAudit, verifyChain } from './audit.js';
import { validate } from './schema.js';
import { readFileSync } from 'node:fs';
import { describeSources, SOURCES_FILE } from './sources.js';
import { EXPORTS_BASIS_NOTE } from './exports.js';
import { checkLicense, licenseView, LICENSE_FILE } from './license.js';

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
  if (flags['max-steps-per-day'] || env.MYTHOS_MAX_STEPS_PER_DAY) caps.maxStepsPerDay = Number(flags['max-steps-per-day'] || env.MYTHOS_MAX_STEPS_PER_DAY);
  if (flags['max-spend-per-day'] || env.MYTHOS_MAX_SPEND_USD_PER_DAY) caps.maxSpendUsdPerDay = Number(flags['max-spend-per-day'] || env.MYTHOS_MAX_SPEND_USD_PER_DAY);
  for (const [k, v] of Object.entries(caps)) if (!Number.isFinite(v) || v < 0) throw new Error(`cap ${k} must be a non-negative number`);
  return new AgentRuntime(manifest, {
    mode, autoActions: auto, caps,
    root: flags.root || env.MYTHOS_ROOT || process.cwd(),
    stateDir: flags['state-dir'] || env.MYTHOS_STATE_DIR || undefined,
    session: flags.session || env.MYTHOS_SESSION || undefined,
    signingKey: flags['signing-key'] || env.MYTHOS_SIGNING_KEY || undefined,
    auditMirror: flags['audit-mirror'] || env.MYTHOS_AUDIT_MIRROR || undefined,
    approvalTtlHours: flags['approval-ttl'] || env.MYTHOS_APPROVAL_TTL_HOURS || undefined,
    approvalWebhook: flags['approval-webhook'] || env.MYTHOS_APPROVAL_WEBHOOK || undefined,
    memory: !(flags['no-memory'] || /^(1|true|yes)$/i.test(env.MYTHOS_NO_MEMORY || '')),
    lang: flags.lang || env.MYTHOS_LANG || undefined,
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
  ${bin} eval --report DIR [--baseline old/report.json]   Also write report.html + report.json
  ${bin} approve <id> --as "Name" Approve one "ask" action (a human, once)
  ${bin} reject <id> --as "Name"  Reject a pending action
  ${bin} approvals [list]         List pending approvals
  ${bin} approvals serve [--port N]   Local approvals page on 127.0.0.1
  ${bin} usage                    Steps and spend for this session and today
  ${bin} keygen --out DIR         Make an Ed25519 audit signing key (keep DIR outside --root)
  ${bin} rotate-key --signing-key OLD --new-key NEW --as "Name"   Signed key rotation
  ${bin} verify-log [file] [--pubkey public.pem]   Verify the audit chain (and signatures)
  ${bin} validate-config <schema> <file>   Check a config file (schemas: see "tools --configs")
  ${bin} sources                  List the export files this pack reads directly, by system
  ${bin} inspect <file> [--as KIND]   Show how a file would be read: export recognised, columns mapped
  ${bin} kill | unkill            Engage or clear the kill switch (.mythos/KILL)${manifest.memory ? `
  ${bin} memory [list] [--status S] [--kind K]   What this agent has learned (accepted and waiting)
  ${bin} memory accept|reject <id> --as "Name" [--reason TEXT]   A person decides on a waiting fact
  ${bin} memory retire <id> --as "Name" --reason TEXT   A person stops an accepted fact
  ${bin} memory verify [--pubkey public.pem]   Check the memory file's chain against the audit log` : ''}
  ${bin} license status           Licence for the paid tier: plan, expiry, which tools it unlocks
  ${bin} license install <file>   Check a licence key and copy it to .mythos/license.key
  ${bin} license remove           Delete .mythos/license.key

Options:
  --mode review|assist|auto       Default assist. Auto is opt-in per action:
  --auto tool_a,tool_b            Actions allowed to run without asking in Auto
  --max-steps N --max-spend USD   Caps (always enforced)
  --root DIR                      Folder the tools may read/write (default: cwd)
  --state-dir DIR                 Audit log, approvals, kill file (default: <root>/.mythos)
  --session ID                    Session id for persisted caps (default: random per process)
  --max-steps-per-day N --max-spend-per-day USD   Daily caps (persisted in usage.json)
  --signing-key FILE              Ed25519 private key (outside --root): sign every audit line
  --audit-mirror FILE             Also append every audit line to this file
  --approval-ttl HOURS            Approvals expire this long after approval (default 24)
  --approval-webhook URL          POST pending approvals, HMAC-signed with MYTHOS_WEBHOOK_SECRET
  --lang en|de|fr|es|pt|it|ja|zh|ko   Language of reports and the approvals page (MYTHOS_LANG); tool results stay in English${manifest.memory ? `
  --no-memory                     Run without the facts this agent has learned (recall and learn still work)` : ''}
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
    if (manifest.prompts && manifest.prompts.length) out(`prompts: ${manifest.prompts.map((p) => p.name).join(', ')}`);
    if (manifest.configSchemas) out(`config schemas: ${Object.keys(manifest.configSchemas).join(', ')}`);
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
  const stateDir = () => resolve(flags.dir || flags['state-dir'] || process.env.MYTHOS_STATE_DIR || join(flags.root || process.env.MYTHOS_ROOT || process.cwd(), '.mythos'));
  if (cmd === 'approve' || cmd === 'reject') {
    const store = new ApprovalStore(stateDir(), { ttlHours: flags['approval-ttl'] });
    const rec = cmd === 'approve' ? store.approve(pos[1], flags.as, flags.note || '') : store.reject(pos[1], flags.as, flags.note || '');
    out(cmd === 'approve' ? `Approved ${rec.id} as ${rec.approved_by}. It can be used once, until ${rec.expires_at}.` : `Rejected ${rec.id} as ${rec.rejected_by}.`);
    return 0;
  }
  if (cmd === 'approvals') {
    const dir = stateDir();
    if (pos[1] === 'serve') {
      const port = flags.port !== undefined ? Number(flags.port) : 7457;
      const host = flags.host || '127.0.0.1';
      if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !flags['i-understand-remote']) { out('Refusing to bind beyond localhost. Pass --i-understand-remote to override.'); return 2; }
      const s2 = await serveApprovals({ stateDir: dir, host, port, ttlHours: flags['approval-ttl'], agent: manifest.name, lang: flags.lang || process.env.MYTHOS_LANG });
      process.stderr.write(`Approvals page: ${s2.url}  (Ctrl+C to stop)\n`);
      return null;
    }
    const pend = new ApprovalStore(dir).pending();
    if (!pend.length) { out('No pending approvals.'); return 0; }
    for (const p of pend) out(`${p.id}  ${p.tool.padEnd(32)} ${p.one_click ? 'one-click  ' : ''}${p.ts}  ${p.reason || ''}${p.details ? `\n    approving: ${JSON.stringify(p.details).slice(0, 300)}` : ''}`);
    return 0;
  }
  if (cmd === 'usage') { out(runtimeFromFlags(manifest, flags).usageReport()); return 0; }
  if (cmd === 'keygen') {
    if (!flags.out) { out('keygen needs --out DIR (outside the agent root)'); return 2; }
    const k = generateSigningKey(flags.out, { root: flags.root || process.env.MYTHOS_ROOT || process.cwd() });
    out(`Signing key ${k.keyId} written. Private: ${k.privateKeyFile} (keep it secret). Public: ${k.publicKeyFile}.`);
    return 0;
  }
  if (cmd === 'rotate-key') {
    if (!flags['signing-key'] || !flags['new-key'] || !flags.as) { out('rotate-key needs --signing-key OLD --new-key NEW --as "Name"'); return 2; }
    const root = flags.root || process.env.MYTHOS_ROOT || process.cwd();
    const log = new AuditLog(join(stateDir(), 'audit.jsonl'), { signer: loadSigner(flags['signing-key'], { root }) });
    const line = log.rotate(loadSigner(flags['new-key'], { root }), { by: String(flags.as), note: flags.note || '' });
    out(`Rotation recorded at ${line.id}: new key ${line.new_key_id}. Start the agent with --signing-key ${flags['new-key']} from now on.`);
    return 0;
  }
  if (cmd === 'verify-log') {
    const file = resolve(pos[1] || join(stateDir(), 'audit.jsonl'));
    const r = verifyChain(readAudit(file), { publicKeys: flags.pubkey ? loadPublicKeys(String(flags.pubkey).split(',')) : null });
    out(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'validate-config') {
    const schemas = manifest.configSchemas || {};
    if (!pos[1] || !schemas[pos[1]]) { out(`Known config schemas: ${Object.keys(schemas).join(', ') || '(none)'}\nUsage: ${bin} validate-config <schema> <file>`); return 2; }
    const v = validate(schemas[pos[1]], JSON.parse(readFileSync(resolve(pos[2]), 'utf8')));
    out(v.ok ? `${pos[2]} is a valid ${pos[1]}.` : `${pos[2]} is not a valid ${pos[1]}:\n` + v.errors.map((e) => `  ${e.path} ${e.message}`).join('\n'));
    return v.ok ? 0 : 1;
  }
  if (cmd === 'sources') {
    const list = describeSources(manifest);
    if (flags.json) { out(list); return 0; }
    if (!list.length) { out(`${manifest.name} has no table inputs with column mapping. Any tool that takes a table reads CSV, TSV, Excel .xlsx, JSON and JSONL.`); return 0; }
    out(`${manifest.name} reads CSV, TSV, Excel .xlsx, JSON and JSONL. A file in its own column layout is read as it is.\nExports from these systems are recognised by their column names and mapped for you:\n`);
    for (const k of list) {
      out(`${k.kind}  (${k.label}; argument${k.args.length > 1 ? 's' : ''}: ${k.args.join(', ')})`);
      out(`  own columns: ${k.columns.map((c) => c.name + (c.required ? '*' : '')).join(', ')}`);
      for (const e of k.exports) out(`  - ${e.system}: ${e.label || e.id}  [${e.id}]${e.layout_checked === 'no' ? '' : `  (layout checked ${e.layout_checked})`}`);
      if (!k.exports.length) out('  - no named exports; other column names are matched by the "also called" list');
      out('');
    }
    out(`Column names differ? Run "${bin} inspect <file>", then name your columns in ${SOURCES_FILE} in the root.\n${EXPORTS_BASIS_NOTE}`);
    return 0;
  }
  if (cmd === 'license') {
    const sub = pos[1] || 'status';
    const rt = runtimeFromFlags(manifest, flags);
    const f = join(rt.stateDir || stateDir(), LICENSE_FILE);
    if (sub === 'status') {
      const r = rt.licenseReport();
      if (flags.json) { out(r); return 0; }
      out(r.status === 'valid' ? `Licence valid: plan ${r.plan} for ${r.licensee}, ${r.expires === 'no end date' ? 'no end date' : `until ${r.expires} (${r.days_left} day(s) left)`}.` : `No valid licence: ${r.reason}`);
      if (r.read_from) out(`Read from: ${r.read_from}`);
      if (!r.paid_tools.length) out(`${manifest.name} has no paid tools in this version; everything runs without a licence.`);
      else for (const t of r.paid_tools) out(`  ${t.unlocked ? 'unlocked' : 'locked  '}  ${t.name}${t.feature ? ` (feature ${t.feature})` : ''}`);
      return 0;
    }
    if (sub === 'install') {
      if (!pos[2]) { out(`Usage: ${bin} license install <file holding the key>`); return 2; }
      let token; try { token = readFileSync(resolve(pos[2]), 'utf8').trim(); } catch { out(`Not installed: cannot read ${pos[2]}.`); return 1; }
      const st = checkLicense(token, { agent: manifest.name });
      if (!st.valid) { out(`Not installed: ${st.reason}`); return 1; }
      mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, token + '\n', { mode: 0o600 });
      const v = licenseView(st);
      out(`Licence installed in ${f}: plan ${v.plan} for ${v.licensee}, ${v.expires === 'no end date' ? 'no end date' : `until ${v.expires}`}.`);
      return 0;
    }
    if (sub === 'remove') { if (existsSync(f)) rmSync(f); out(`Removed ${f}.`); return 0; }
    out(`Usage: ${bin} license status | install <file> | remove`); return 2;
  }
  if (cmd === 'memory') {
    if (!manifest.memory) { out(`${manifest.name} has no domain memory.`); return 2; }
    const sub = pos[1] || 'list';
    const rt = runtimeFromFlags(manifest, flags);
    const p = manifest.memory.prefix;
    if (sub === 'list') {
      const r = rt.memory.search({ status: flags.status ? String(flags.status) : 'current', kind: flags.kind ? String(flags.kind) : null, query: flags.query ? String(flags.query) : '', limit: 500 });
      if (flags.json) { out(r); return r.chain.ok ? 0 : 1; }
      out(`${manifest.name} memory: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty'}. File ${r.chain.ok ? 'verifies' : 'DOES NOT VERIFY (no accepted fact is used)'}.`);
      for (const f of r.entries) out(`  ${f.id}  ${f.status.padEnd(10)} ${f.kind.padEnd(18)} ${JSON.stringify(f.value).slice(0, 100)}${f.accepted_by ? `  (accepted by ${f.accepted_by})` : ''}`);
      for (const pr of r.problems) out(`  problem: ${pr}`);
      return r.chain.ok ? 0 : 1;
    }
    if (sub === 'accept' || sub === 'reject' || sub === 'retire') {
      if (!pos[2] || !flags.as || flags.as === true) { out(`Usage: ${bin} memory ${sub} <MEM-id> --as "Your Name"${sub === 'retire' ? ' --reason TEXT' : ' [--reason TEXT]'}`); return 2; }
      if (sub === 'retire' && (!flags.reason || flags.reason === true)) { out('retire needs --reason'); return 2; }
      const tool = sub === 'retire' ? `${p}_retire_memory` : `${p}_accept_learning`;
      const args = sub === 'retire' ? { id: pos[2], reason: String(flags.reason) } : { id: pos[2], decision: sub, ...(flags.reason && flags.reason !== true ? { reason: String(flags.reason) } : {}) };
      // The same path an agent takes: ask, a person approves (here, by name), the call runs.
      const first = await rt.call(tool, args);
      if (first.status !== 'needs_approval') { out(first); return 1; }
      rt.approvals.approve(first.approval_id, String(flags.as), `memory ${sub} from the command line`, 'cli');
      const r = await rt.call(tool, args);
      if (r.status !== 'executed') { out(r); return 1; }
      out(r.result.summary);
      return 0;
    }
    if (sub === 'verify') {
      const lines = existsSync(rt.memory.file || '') ? readAudit(rt.memory.file) : [];
      const chain = verifyChain(lines, { publicKeys: flags.pubkey ? loadPublicKeys(String(flags.pubkey).split(',')) : null });
      const { facts, problems } = rt.memory.load();
      // Every accept or retire the audit log says ran must be in the memory file:
      // lines cut from the end of the memory file show up here.
      const auditFile = join(rt.stateDir, 'audit.jsonl');
      const ran = existsSync(auditFile) ? readAudit(auditFile).filter((e) => e && e.status === 'executed' && (e.tool === `${p}_accept_learning` || e.tool === `${p}_retire_memory`) && e.approval_id) : [];
      const inMem = new Set(lines.map((l) => l && l.approval_id).filter(Boolean));
      const missing = ran.filter((e) => !inMem.has(e.approval_id)).map((e) => `${e.id} ${e.tool} approved by ${e.approved_by} (approval ${e.approval_id}) is in the audit log but not in the memory file`);
      const ok = chain.ok && !missing.length && !problems.some((x) => /no matching approval/.test(x));
      out({ ok, file: rt.memory.file, chain, facts: facts.length, problems, missing_from_memory: missing });
      return ok ? 0 : 1;
    }
    out(`Usage: ${bin} memory list | accept <id> --as "Name" | reject <id> --as "Name" | retire <id> --as "Name" --reason TEXT | verify`); return 2;
  }
  if (cmd === 'inspect') {
    if (!pos[1]) { out(`Usage: ${bin} inspect <file> [--as KIND] [--sheet NAME] [--root DIR]`); return 2; }
    const rt = runtimeFromFlags(manifest, flags);
    const r = rt.inspect({ path: pos[1], ...(flags.as ? { as: String(flags.as) } : {}), ...(flags.sheet !== undefined ? { sheet: /^\d+$/.test(String(flags.sheet)) ? Number(flags.sheet) : String(flags.sheet) } : {}) });
    if (flags.json || r.status !== 'executed') { out(r); return r.status === 'executed' ? 0 : 1; }
    const x = r.result;
    out(x.summary);
    out(`format: ${x.format}${x.sheet ? `, sheet "${x.sheet}" of ${x.sheets.join(', ')}` : ''}; ${x.rows} row(s)${x.header_row ? `; header on line ${x.header_row}` : ''}`);
    out('columns:'); for (const c of x.columns) out(`  ${c.name.padEnd(34)} ${c.looks_like}`);
    for (const k of x.readings) {
      if (k.error) { out(`as ${k.kind}: ${k.error}`); continue; }
      out(`as ${k.kind}: ${k.profile ? `${k.system}: ${k.export || k.profile}` : k.adapted ? 'matched by column name' : 'read as it is'}`);
      for (const [f, h] of Object.entries(k.mapped)) out(`  ${f.padEnd(24)} <- ${h}`);
      if (k.missing.length) out(`  missing: ${k.missing.join(', ')}`);
      if (k.unmapped.length) out(`  not used: ${k.unmapped.join(', ')}`);
      if (k.note) out(`  note: ${k.note}`);
      for (const w of k.warnings) out(`  warning: ${w}`);
    }
    out(x.how_to_override);
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
    if (flags.report) {
      const w = writeEvalReport(r, String(flags.report), { baseline: flags.baseline ? resolve(String(flags.baseline)) : undefined });
      out(`Report: ${w.html}${w.comparison ? `  (regressions: ${w.comparison.regressions.length})` : ''}`);
      if (w.comparison && w.comparison.regressions.length) return 1;
    }
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
