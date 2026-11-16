import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsv, validate, validateSarif } from 'mythos-agent-core';
import { manifest, normalise, audit, scanSecrets, findSecrets, highEntropy, redact, dependencyMap, findingsSarif, compareBaseline, SECRET_RULES } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const J = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'are-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const ALL = ['n8n-orders.json', 'n8n-cleanup.json', 'zapier-export.json', 'make-blueprint.json', 'power-automate-flow.json', 'workato-recipes.json'];
const flows = (list = ALL) => list.flatMap((f) => normalise(J(f), f));
const codes = (r, name) => r.items.find((i) => i.name === name).findings.map((f) => f.code);

test('Power Automate and Workato exports parse into steps and edges', () => {
  const [pa] = normalise(J('power-automate-flow.json'), 'pa.json');
  assert.equal(pa.platform, 'power_automate'); assert.equal(pa.name, 'Leads to ERP'); assert.equal(pa.active, true);
  assert.equal(pa.steps.length, 6); assert.equal(pa.steps[0].kind, 'trigger');
  assert.deepEqual(pa.edges.slice(0, 2), [['When a lead is posted', 'Forward to order sync'], ['Forward to order sync', 'Delete old lead items']]);
  assert.equal(pa.steps.find((s) => s.name === 'Send confirmation').app, 'office365');
  const w = normalise(J('workato-recipes.json'), 'w.json');
  assert.deepEqual(w.map((x) => `${x.platform}:${x.name}:${x.active}`), ['workato:Refund on cancelled order:true', 'workato:Nightly contact purge:false']);
  assert.equal(w[1].steps.length, 7, 'nested if and catch blocks are flattened');
  assert.equal(w[1].error_handler, true); assert.equal(w[0].error_handler, false);
  assert.ok(w[1].steps.find((s) => s.op === 'search_customers').disabled, 'skip: true is a disabled step');
  // Stopped Power Automate flow and a bare Logic Apps definition.
  const stopped = normalise({ properties: { displayName: 'Off', state: 'Stopped', definition: { triggers: { t: { type: 'Recurrence' } }, actions: {} } } }, 'x')[0];
  assert.equal(stopped.active, false);
  assert.equal(normalise({ definition: { triggers: { t: { type: 'Recurrence' } }, actions: { a: { type: 'Compose', runAfter: {} } } } }, 'y')[0].steps.length, 2);
});

test('the same risk checks fire on Power Automate and Workato', () => {
  const r = audit(flows(['power-automate-flow.json', 'workato-recipes.json']), [], {});
  for (const c of ['open_webhook', 'hardcoded_secret', 'possible_secret', 'destructive_without_filter', 'sends_messages', 'disconnected_step', 'no_error_handler']) assert.ok(codes(r, 'Leads to ERP').includes(c), `PA ${c}`);
  for (const c of ['money_moving', 'hardcoded_secret', 'open_webhook', 'no_error_handler']) assert.ok(codes(r, 'Refund on cancelled order').includes(c), `Workato ${c}`);
  for (const c of ['destructive_step', 'disabled_step', 'sends_messages']) assert.ok(codes(r, 'Nightly contact purge').includes(c), `Workato ${c}`);
  assert.ok(!codes(r, 'Nightly contact purge').includes('destructive_without_filter'), 'the if block is a filter');
  assert.ok(!codes(r, 'Nightly contact purge').includes('no_error_handler'), 'catch block is an error route');
  // Power Automate trigger restricted to the tenant: not an open webhook.
  const tenant = J('power-automate-flow.json'); tenant.properties.definition.triggers['When a lead is posted'].inputs.triggerAuthenticationType = 'Tenant';
  assert.ok(!codes(audit(normalise(tenant, 't'), [], {}), 'Leads to ERP').includes('open_webhook'));
  assert.ok(!JSON.stringify(r).includes('FAKE'), 'no secret value in the audit');
});

test('secret detection: known prefixes, secret-named fields, entropy; values never returned', () => {
  // Built at runtime so the source file holds no complete token-shaped literal.
  const seeds = {
    stripe: ['sk', 'live', 'FAKE0000demo0000'].join('_'),
    slack: ['xoxb', '0000', 'FAKEdemo0000'].join('-'),
    aws: 'AKIA' + 'FAKEDEMO00000000',
    github: 'ghp_' + 'FAKEdemo'.repeat(3),
    google: 'AIza' + 'FAKEdemo0000FAKEdemo0000FAKEdemo000',
    sendgrid: 'SG.' + 'FAKEdemo00000000' + '.' + 'FAKEdemo00000000',
    jwt: 'eyJ' + 'FAKEdemo00' + '.eyJ' + 'FAKEdemo00' + '.' + 'FAKEsig000',
    urlpass: 'https://ops:' + 'FAKEpass' + '@db.example.com/x',
    sig: 'https://logs.example.com/i?sig=' + 'FAKE'.repeat(5),
    entropy: 'FAKE' + 'q7v9Zp2LxK8mR4tW1bN6cY3hJ5dF0gS',
  };
  // Webhook-URL rules need the provider's host, so they are built here and kept out of the fixtures.
  const hook = ['https://hooks', 'slack', 'com/services/TFAKE0000/BFAKE0000/FAKEdemo0000'].join('.');
  assert.deepEqual(scanSecrets({ url: hook }).map((h) => h.rule), ['slack_webhook']);
  assert.ok(!JSON.stringify(redact({ url: hook })).includes('TFAKE'));
  const hits = scanSecrets({ note: seeds.stripe, a: seeds.slack, b: seeds.aws, c: seeds.github, d: seeds.google, e: seeds.sendgrid, f: seeds.jwt, g: seeds.urlpass, h: seeds.sig, i: seeds.entropy, client_secret: 'FAKEplain-secret' });
  assert.deepEqual(hits.map((h) => h.rule), ['stripe_live_key', 'slack_token', 'aws_access_key', 'github_token', 'google_api_key', 'sendgrid_key', 'jwt', 'url_credentials', 'url_signature', 'high_entropy', 'secret_named_field']);
  assert.equal(hits.find((h) => h.rule === 'high_entropy').confidence, 'medium');
  for (const h of hits) assert.ok(!('value' in h), 'no value field');
  assert.ok(!JSON.stringify(hits).includes('FAKE'), 'values never returned');
  // Not secrets: UUIDs, prose, URLs without credentials, short ids, expressions, plain hex hashes below length.
  assert.deepEqual(scanSecrets({ id: '0b6f4c1e-8a3d-4c55-9f1d-2e7a9c3b5d10', text: 'Order received from the website today 2026', url: 'https://api.example.com/v2/orders?page=2', n: 'INV-000123', expr: '@triggerBody()?[\'x\']', w: "#{_('data.x')}", h: 'abc123' }), []);
  assert.equal(highEntropy('aaaaaaaaaaaaaaaaaaaaaaaa1'), false, 'low entropy');
  assert.equal(findSecrets({ i: seeds.entropy }, '', { entropy: false }).length, 0, 'entropy can be turned off');
  assert.ok(SECRET_RULES.length >= 15);
  // Redaction: known formats are replaced in place, so the URL host stays readable.
  const red = JSON.stringify(redact({ url: seeds.sig, headers: [{ name: 'X-Trace', value: seeds.entropy }], k: seeds.stripe }));
  assert.ok(!red.includes('FAKE')); assert.ok(red.includes('logs.example.com/i?sig=<<REDACTED'));
});

test('dependency map lists shared credentials, secrets and webhook calls without values', () => {
  const m = dependencyMap(flows());
  const shared = m.resources.filter((r) => r.shared).map((r) => `${r.type}:${r.key}:${r.flows.join('+')}`);
  assert.ok(shared.includes('credential:workato stripe: Stripe production:Refund on cancelled order+Nightly contact purge'));
  assert.ok(shared.some((s) => /^secret:secret#\d+:Refund approvals\+Leads to ERP$/.test(s)), 'same FAKE api key in Make and Power Automate');
  assert.ok(shared.includes('webhook:n8n webhook /orders-in:Order sync+Leads to ERP'));
  assert.deepEqual(m.calls, [{ from: 'Leads to ERP', to: 'Order sync', via: 'n8n webhook /orders-in', step: 'Forward to order sync' }]);
  assert.equal(m.rotation_plan[0].priority, 'P1'); assert.match(m.rotation_plan[0].reasons[0], /used in 2 flows/);
  assert.ok(!JSON.stringify(m).includes('FAKE'));
  assert.equal(dependencyMap(flows(['zapier-export.json'])).shared, 0);
});

test('policy file: suppressions with reasons, allowed http hosts, and schema errors', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, audit: false, stateDir: join(root, '.mythos') });
  const base = { exports: ['n8n-orders.json', 'power-automate-flow.json'], as_of: '2026-11-14T12:00:00Z' };
  const plain = await rt.call('arethusa_audit', base);
  const pol = await rt.call('arethusa_audit', { ...base, policy: 'arethusa-policy.json' });
  assert.equal(pol.status, 'executed');
  assert.equal(pol.result.suppressed.length, 1); assert.match(pol.result.suppressed[0].reason, /correlation id/);
  assert.ok(codes(plain.result, 'Order sync').includes('plain_http')); assert.ok(!codes(pol.result, 'Order sync').includes('plain_http'));
  assert.ok(pol.result.items.find((i) => i.name === 'Leads to ERP').risk_score < plain.result.items.find((i) => i.name === 'Leads to ERP').risk_score, 'suppressed findings do not score');
  const expired = await rt.call('arethusa_audit', { ...base, policy: 'arethusa-policy.json', as_of: '2027-06-01T00:00:00Z' });
  assert.equal(expired.result.suppressed.length, 0); assert.match(JSON.stringify(expired.result), /suppression expired 2027-03-31/);
  const good = J('arethusa-policy.json');
  const mutated = {
    'unknown-key.json': [{ ...good, ignore_all: true }, /\/ignore_all is not an allowed property/],
    'wrong-type.json': [{ ...good, fail_rate: 'high' }, /\/fail_rate expected number/],
    'missing-required.json': [{ ...good, ignore: [{ code: 'open_webhook' }] }, /\/ignore\/0\/reason is required/],
  };
  for (const [name, [doc, re]] of Object.entries(mutated)) {
    writeFileSync(join(root, name), JSON.stringify(doc));
    const r = await rt.call('arethusa_audit', { ...base, policy: name });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid policy/); assert.match(r.reason, re);
    assert.equal(validate(manifest.configSchemas.policy, doc).ok, false);
  }
  assert.equal(validate(manifest.configSchemas.policy, good).ok, true);
});

test('report writes valid SARIF; baseline marks new and resolved findings', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, audit: false, stateDir: join(root, '.mythos') });
  const f = { exports: ALL, history: 'run-history.csv', as_of: '2026-11-14T12:00:00Z', out_dir: 'out1' };
  const w = await rt.call('arethusa_write_report', f);
  assert.equal(w.status, 'executed'); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
  const sarif = JSON.parse(readFileSync(join(root, 'out1/findings.sarif'), 'utf8'));
  assert.deepEqual(validateSarif(sarif).errors, []);
  assert.ok(sarif.runs[0].results.some((x) => x.ruleId === 'hardcoded_secret' && x.locations[0].physicalLocation.artifactLocation.uri === 'power-automate-flow.json'));
  assert.ok(!JSON.stringify(sarif).includes('FAKE'));
  // Fix one secret and drop the cleanup flow from the baseline file to make one "new" set.
  const orders = join(root, 'n8n-orders.json');
  writeFileSync(orders, readFileSync(orders, 'utf8').replace(/"Bearer FAKE[^"]*"/, '"={{$credentials.erp}}"'));
  const rows = parseCsv(readFileSync(join(root, 'out1/findings.csv'), 'utf8'));
  writeFileSync(join(root, 'baseline.csv'), readFileSync(join(root, 'out1/findings.csv'), 'utf8').split('\n').filter((l) => !l.startsWith('CRM cleanup')).join('\n'));
  const a = await rt.call('arethusa_audit', { ...f, baseline: 'baseline.csv' });
  assert.equal(a.result.baseline.resolved, 1); assert.equal(a.result.baseline.resolved_findings[0].code, 'hardcoded_secret');
  assert.equal(a.result.baseline.new, rows.filter((x) => x.flow === 'CRM cleanup').length);
  assert.ok(a.result.items.find((i) => i.name === 'CRM cleanup').findings.every((x) => x.baseline === 'new'));
  const w2 = await rt.call('arethusa_write_report', { ...f, out_dir: 'out2', baseline: 'baseline.csv' });
  const md = readFileSync(w2.result.files[0], 'utf8');
  assert.match(md, /1 resolved/); assert.match(md, /Resolved since the baseline/); assert.match(md, /_\(new\)_/);
  assert.equal(parseCsv(readFileSync(w2.result.files[1], 'utf8'))[0].baseline !== undefined, true);
  assert.equal(compareBaseline({ items: [] }, []).new, 0);
  assert.ok(findingsSarif({ items: [] }, '0.2.0').runs[0].results.length === 0);
});

test('dependency map tool writes Markdown with Mermaid and CSV; MCP prompt keeps the one-click step', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, audit: false, stateDir: join(root, '.mythos') });
  const r = await rt.call('arethusa_dependency_map', { exports: ALL });
  assert.equal(r.status, 'executed'); assert.equal(r.decision, 'allow');
  const md = readFileSync(r.result.files[0], 'utf8');
  assert.match(md, /```mermaid/); assert.match(md, /Leads to ERP › Forward to order sync calls Order sync/);
  assert.ok(!md.includes('FAKE') && !readFileSync(r.result.files[1], 'utf8').includes('FAKE'));
  const bad = await rt.call('arethusa_dependency_map', { exports: [] });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments/);
  const p = manifest.prompts.find((x) => x.name === 'arethusa_flow_review');
  for (const t of ['arethusa_audit', 'arethusa_dependency_map', 'arethusa_write_report', 'arethusa_draft_changes', 'arethusa_request_flow_change']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /one named human click/); assert.match(p.text, /\{\{exports\}\}/);
  assert.equal(manifest.policy.rules.find((x) => x.tool === 'arethusa_request_flow_change').decision, 'ask');
});
