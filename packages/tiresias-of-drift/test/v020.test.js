import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, applyUnifiedDiff, sha256, validate, validateSarif } from 'mythos-agent-core';
import { manifest, loadSnapshot, diff, revertPatch, parseYamlAll, fingerprint, APPROVED_DRIFT_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const rt = (root = fixtures, o = {}) => new AgentRuntime(manifest, { root, audit: false, ...o });
const TF = { before: 'terraform/2026-10-01.tfstate', after: 'terraform/2026-11-01.tfstate' };
const K8 = { before: 'k8s/2026-10-01.yaml', after: 'k8s/2026-11-01.yaml' };
const CFG = { before: 'snapshots/2026-10-01.json', after: 'snapshots/2026-11-01.json', ignore: ['meta.generated_at'] };
const FAKE_SECRETS = ['fake-db-pass-1111', 'fake-db-pass-2222', 'fake-k8s-pass-1111', 'fake-k8s-pass-2222', 'ZmFrZS1zaWduaW5nLWtleS0x', 'ZmFrZS1zaWduaW5nLWtleS0y', 'fake-key-aaaa1111', 'fake-key-bbbb2222'];
const noSecrets = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const x of FAKE_SECRETS) assert.ok(!s.includes(x), `leaked ${x}`); };

test('Terraform state: drift by resource with risk levels; secrets redacted', async () => {
  const r = await rt().call('tiresias_diff', TF);
  assert.equal(r.status, 'executed', r.reason); const d = r.result;
  assert.equal(d.kind, 'terraform');
  const by = Object.fromEntries(d.items.map((i) => [i.key, i]));
  assert.equal(by['aws_security_group.web.ingress[0].cidr_blocks'].risk, 'high'); assert.match(by['aws_security_group.web.ingress[0].cidr_blocks'].why, /Opened to everyone/);
  assert.equal(by['aws_db_instance.billing.publicly_accessible'].risk, 'high');
  assert.match(by['aws_db_instance.billing.deletion_protection'].why, /Deletion protection/);
  assert.equal(by['aws_db_instance.billing.password'].secret, true); assert.match(by['aws_db_instance.billing.password'].after, /value not shown/);
  assert.equal(by['aws_db_instance.billing.engine_version'].risk, 'medium'); assert.equal(by['aws_db_instance.billing.instance_class'].risk, 'low');
  assert.equal(by['aws_s3_bucket.exports'].change, 'removed'); assert.equal(by['aws_s3_bucket.exports'].risk, 'high');
  assert.equal(by['aws_iam_user.ci'].change, 'added'); assert.equal(by['aws_iam_user.ci'].risk, 'high');
  assert.ok(!by['aws_iam_user.ci.name'], 'added resource is one item, not one per attribute');
  assert.deepEqual(d.resources, { added: ['aws_iam_user.ci'], removed: ['aws_s3_bucket.exports'], changed: ['aws_db_instance.billing', 'aws_security_group.web'] });
  assert.deepEqual(d.by_risk, { high: 6, medium: 2, low: 1 });
  noSecrets(r);
});

test('Terraform sensitive_attributes mask values even when the key name looks harmless', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tir-tf-'));
  const st = (v) => JSON.stringify({ version: 4, terraform_version: '1.9.8', resources: [{ mode: 'managed', type: 'x_thing', name: 'a', instances: [{ index_key: 'eu', attributes: { blob: v, nested: { pin: v } }, sensitive_attributes: [[{ type: 'get_attr', value: 'blob' }], [{ type: 'get_attr', value: 'nested' }]] }] }] });
  writeFileSync(join(dir, 'a.tfstate'), st('hunter-one')); writeFileSync(join(dir, 'b.tfstate'), st('hunter-two'));
  const d = diff(loadSnapshot(join(dir, 'a.tfstate')), loadSnapshot(join(dir, 'b.tfstate')));
  assert.deepEqual(d.items.map((i) => i.key), ['x_thing.a["eu"].blob', 'x_thing.a["eu"].nested.pin']);
  assert.ok(d.items.every((i) => i.secret && i.risk === 'high')); assert.ok(!JSON.stringify(d).includes('hunter'));
  writeFileSync(join(dir, 'c.tfstate'), '{"hello":1}'); assert.throws(() => loadSnapshot(join(dir, 'c.tfstate')), /not Terraform state/);
});

test('Kubernetes manifests: risk levels, name-keyed lists, server noise dropped, secrets redacted', async () => {
  const r = await rt().call('tiresias_diff', K8);
  assert.equal(r.status, 'executed', r.reason); const d = r.result; assert.equal(d.kind, 'kubernetes');
  const P = 'Deployment/payments/billing-api.spec.template.spec.containers.api.';
  const by = Object.fromEntries(d.items.map((i) => [i.key, i]));
  assert.match(by[P + 'securityContext.privileged'].why, /privileged/); assert.equal(by[P + 'securityContext.privileged'].risk, 'high');
  assert.match(by[P + 'image'].why, /mutable tag/);
  assert.equal(by[P + 'env.DB_PASSWORD.value'].secret, true, 'env order changed but the key is stable');
  assert.equal(by[P + 'env.LOG_LEVEL.value'].risk, 'medium');
  assert.match(by['Service/payments/billing-api.spec.type'].why, /exposed outside the cluster/);
  assert.equal(by['Secret/payments/billing-keys.data.signing-key'].secret, true);
  assert.equal(by['Deployment/payments/billing-api.spec.replicas'].risk, 'medium');
  assert.ok(!d.items.some((i) => /resourceVersion|uid/.test(i.key)));
  assert.deepEqual(d.by_risk, { high: 5, medium: 2, low: 0 });
  noSecrets(r);
  assert.equal((await rt().call('tiresias_diff', { before: TF.before, after: K8.after })).status, 'error');
});

test('YAML reader: the subset it supports, and clear refusals', () => {
  const [d] = parseYamlAll('a: 1\nb: "x: y" # c\nc:\n- 1\n- {k: v}\n- - n\nd: |\n  l1\n  l2\ne: [true, null, "s"]\nf: 0.5\ng: 1.2.3\n');
  assert.deepEqual(d, { a: 1, b: 'x: y', c: [1, { k: 'v' }, ['n']], d: 'l1\nl2\n', e: [true, null, 's'], f: 0.5, g: '1.2.3' });
  assert.equal(parseYamlAll('a: 1\n---\nb: 2\n').length, 2);
  assert.throws(() => parseYamlAll('a: &x 1\nb: *x\n'), /not supported/);
  assert.throws(() => parseYamlAll('a:\n\tb: 1\n'), /tabs/);
  const dir = mkdtempSync(join(tmpdir(), 'tir-y-'));
  writeFileSync(join(dir, 'a.yaml'), 'server:\n  debug: false\n'); writeFileSync(join(dir, 'b.yaml'), 'server:\n  debug: true\n');
  assert.equal(diff(loadSnapshot(join(dir, 'a.yaml')), loadSnapshot(join(dir, 'b.yaml'))).items[0].risk, 'high');
  // kubectl "List" JSON output
  const list = (img) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: img }] } }] });
  writeFileSync(join(dir, 'a.json'), list('registry.example.com/x:1')); writeFileSync(join(dir, 'b.json'), list('registry.example.com/x'));
  assert.equal(diff(loadSnapshot(join(dir, 'a.json')), loadSnapshot(join(dir, 'b.json'))).items[0].key, 'Pod/default/p.spec.containers.c.image');
});

test('baseline approval: approved drift does not re-alert until it changes', async () => {
  const root = tmpRoot('tir-base-');
  const args = { ...CFG, keys: ['features.new_invoice_pdf', 'db.pool_max', 'security.api_key'], reason: 'Feature launch CHG-1042 (fictional)' };
  const ask = await new AgentRuntime(manifest, { root }).call('tiresias_approve_baseline', args);
  assert.equal(ask.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(ask.approval_id, 'Robin');
  const ok = await new AgentRuntime(manifest, { root }).call('tiresias_approve_baseline', args);
  assert.equal(ok.status, 'executed', ok.reason); assert.equal(ok.approved_by, 'Robin');
  const file = 'mythos-out/tiresias/approved-drift.json'; const stored = readFileSync(join(root, file), 'utf8');
  noSecrets(stored); assert.ok(validate(APPROVED_DRIFT_SCHEMA, JSON.parse(stored)).ok);
  const plain = await rt(root).call('tiresias_diff', CFG); assert.equal(plain.result.changes, 7);
  const base = await rt(root).call('tiresias_diff', { ...CFG, approved: file });
  assert.equal(base.result.changes, 4); assert.equal(base.result.approved, 3);
  assert.ok(!base.result.items.some((i) => args.keys.includes(i.key)));
  assert.equal(base.result.approved_items.find((i) => i.key === 'db.pool_max').approval_reason, args.reason);
  // The value changes again: it alerts again and says so. An unchanged approved key stays quiet.
  const next = JSON.parse(readFileSync(join(root, 'snapshots/2026-11-01.json'), 'utf8')); next.db.pool_max = 200; next.security.api_key = 'fake-key-cccc3333';
  writeFileSync(join(root, 'snapshots/2026-11-15.json'), JSON.stringify(next));
  const again = await rt(root).call('tiresias_diff', { ...CFG, after: 'snapshots/2026-11-15.json', approved: file });
  const by = Object.fromEntries(again.result.items.map((i) => [i.key, i]));
  assert.equal(by['db.pool_max'].approved_before, true); assert.match(by['db.pool_max'].why, /Changed again since it was approved/);
  assert.equal(by['security.api_key'].approved_before, true); assert.ok(!by['features.new_invoice_pdf']); assert.equal(again.result.approved, 1);
  assert.ok(!JSON.stringify(again).includes('cccc3333'));
  // Approving a key with no drift is refused.
  const bad = await new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['tiresias_approve_baseline'] }).call('tiresias_approve_baseline', { ...CFG, keys: ['server.port'], reason: 'x' });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /no drift on: server.port/);
});

test('fingerprints: secrets use a slow key-salted hash; values are not recoverable from the key alone', () => {
  assert.match(fingerprint('k', 'v'), /^[0-9a-f]{16}$/); assert.match(fingerprint('api_key', 'v', true), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprint('api_key', 'v', true), fingerprint('api_key', 'v'));
  assert.notEqual(fingerprint('a', 'v', true), fingerprint('b', 'v', true));
  assert.notEqual(fingerprint('k', undefined), fingerprint('k', null));
});

test('approved-drift schema: three mutated configs fail with JSON-pointer errors', async () => {
  const good = { version: 1, approvals: [{ key: 'db.pool_max', after_fp: '0123456789abcdef', approved_at: '2026-11-02T10:00:00Z' }] };
  assert.ok(validate(APPROVED_DRIFT_SCHEMA, good).ok);
  const root = tmpRoot('tir-cfg-');
  const cases = [
    ['unknown-key', { ...good, approvals: [{ ...good.approvals[0], aproved_by: 'x' }] }, /\/approvals\/0\/aproved_by/],
    ['wrong-type', { ...good, approvals: 'db.pool_max' }, /\/approvals/],
    ['missing-required', { version: 1, approvals: [{ key: 'db.pool_max', approved_at: 'x' }] }, /\/approvals\/0\/after_fp/],
  ];
  for (const [name, cfg, re] of cases) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(cfg));
    const r = await rt(root).call('tiresias_diff', { ...CFG, approved: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason + JSON.stringify(r.errors || []), re, name);
  }
});

test('revert patch applies cleanly to the newer snapshot and restores the old values', async () => {
  const root = tmpRoot('tir-patch-');
  const r = await rt(root).call('tiresias_write_revert_patch', { ...CFG, out_dir: 'out' });
  assert.equal(r.status, 'executed', r.reason);
  const patch = readFileSync(join(root, 'out', 'revert.patch'), 'utf8'); noSecrets(patch);
  assert.equal(r.result.output_sha256, sha256(patch)); assert.equal(r.result.form, 'normalized');
  const after = JSON.parse(readFileSync(join(root, CFG.after), 'utf8')), before = JSON.parse(readFileSync(join(root, CFG.before), 'utf8'));
  const base = JSON.stringify(after, null, 2) + '\n'; assert.equal(sha256(base), r.result.base_sha256);
  const out = JSON.parse(applyUnifiedDiff(base, patch));
  // Everything is back to the old snapshot except the ignored key and the secret (a manual step).
  assert.deepEqual(out, { ...before, meta: after.meta, security: { ...before.security, api_key: after.security.api_key } });
  assert.deepEqual(r.result.manual_steps.map((s) => s.key), ['security.api_key']);
  assert.throws(() => applyUnifiedDiff(JSON.stringify(before, null, 2) + '\n', patch), /does not apply/);
  // Only chosen keys
  const one = revertPatch(loadSnapshot(join(root, CFG.before)), loadSnapshot(join(root, CFG.after)), { ignore: CFG.ignore, keys: ['server.debug', 'nope'] });
  const t = JSON.parse(one.target_text); assert.equal(t.server.debug, false); assert.equal(t.server.log_level, 'debug'); assert.equal(t.security.tls.verify, false);
  assert.deepEqual(one.not_reverted.find((x) => x.key === 'nope').reason, 'no drift on this key (or ignored/approved)');
});

test('revert patch on a pretty-printed JSON file and on .env applies to the original bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tir-p2-'));
  const a = { keep: 1, gone: 'x', nested: { port: 80 } }, b = { keep: 1, nested: { port: 8080, extra: [1, 2] }, added: true };
  writeFileSync(join(dir, 'a.json'), JSON.stringify(a, null, 2) + '\n'); writeFileSync(join(dir, 'b.json'), JSON.stringify(b, null, 2) + '\n');
  const r = revertPatch(loadSnapshot(join(dir, 'a.json')), loadSnapshot(join(dir, 'b.json')));
  assert.equal(r.applies_to, 'original');
  assert.deepEqual(JSON.parse(applyUnifiedDiff(readFileSync(join(dir, 'b.json'), 'utf8'), r.patch)), a);
  writeFileSync(join(dir, 'a.env'), '# app\nPORT=80\nDB_PASSWORD=p1\nMODE="safe"\nOLD=1\n'); writeFileSync(join(dir, 'b.env'), '# app\nexport PORT=8080\nDB_PASSWORD=p2\nMODE="fast"\nNEW=1\n');
  const e = revertPatch(loadSnapshot(join(dir, 'a.env')), loadSnapshot(join(dir, 'b.env')));
  assert.equal(applyUnifiedDiff(readFileSync(join(dir, 'b.env'), 'utf8'), e.patch), '# app\nexport PORT=80\nDB_PASSWORD=p2\nMODE="safe"\nOLD=1\n');
  assert.deepEqual(e.manual_steps.map((s) => s.key), ['DB_PASSWORD']); assert.ok(!e.patch.includes('p1'));
  // A secret next to a reverted line never appears, even as context.
  writeFileSync(join(dir, 'c.env'), 'A=1\nAPI_TOKEN=tok-old\nB=1\n'); writeFileSync(join(dir, 'd.env'), 'A=2\nAPI_TOKEN=tok-new\nB=2\n');
  const s = revertPatch(loadSnapshot(join(dir, 'c.env')), loadSnapshot(join(dir, 'd.env')));
  assert.ok(!/tok-/.test(s.patch)); assert.equal(applyUnifiedDiff('A=2\nAPI_TOKEN=tok-new\nB=2\n', s.patch), 'A=1\nAPI_TOKEN=tok-new\nB=1\n');
});

test('revert patch is refused for Terraform and Kubernetes with a plain reason', async () => {
  for (const a of [TF, K8]) { const r = await rt().call('tiresias_write_revert_patch', a); assert.equal(r.status, 'error'); assert.match(r.reason, /JSON config and \.env/); }
});

test('report adds valid SARIF without secret values; the hash reaches the audit log', async () => {
  const root = tmpRoot('tir-rep-');
  const r = await new AgentRuntime(manifest, { root }).call('tiresias_write_report', { ...K8, out_dir: 'out' });
  assert.equal(r.status, 'executed', r.reason);
  const sarif = JSON.parse(readFileSync(join(root, 'out', 'drift.sarif'), 'utf8'));
  assert.deepEqual(validateSarif(sarif), { ok: true, errors: [] });
  assert.equal(sarif.runs[0].results.length, 7); assert.equal(sarif.runs[0].results.filter((x) => x.level === 'error').length, 5);
  const priv = sarif.runs[0].results.find((x) => /privileged/.test(x.message.text));
  assert.equal(priv.locations[0].physicalLocation.artifactLocation.uri, K8.after); assert.equal(priv.locations[0].physicalLocation.region.startLine, 22);
  for (const f of ['drift.sarif', 'drift.json', 'drift-report.md', 'revert-plan.json']) noSecrets(readFileSync(join(root, 'out', f), 'utf8'));
  assert.equal(r.result.output_sha256, sha256(readFileSync(join(root, 'out', 'drift-report.md'), 'utf8')));
  const audit = readFileSync(join(root, '.mythos', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.at(-1).output_sha256, r.result.output_sha256);
});

test('policy: baseline approval asks, apply stays one-click with new args, bad args refused first', async () => {
  const p = (t) => manifest.policy.rules.find((r) => r.tool === t).decision;
  assert.equal(p('tiresias_approve_baseline'), 'ask'); assert.equal(p('tiresias_apply_fix'), 'ask'); assert.equal(p('production_push_config'), 'block');
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['tiresias_apply_fix'] }), /one-click/);
  assert.equal((await rt(fixtures, { mode: 'review' }).call('tiresias_approve_baseline', { ...CFG, keys: ['db.pool_max'], reason: 'x' })).status, 'blocked');
  const bad = await rt(fixtures, { mode: 'auto' }).call('tiresias_apply_fix', { environment: 'production', keys: 'server.debug', reason: 'revert' });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments/);
  const root = tmpRoot('tir-oc-'); const r2 = new AgentRuntime(manifest, { root, mode: 'auto' });
  const args = { environment: 'staging', keys: ['security.tls.verify'], reason: 'turn verification back on', ...CFG };
  const a = await r2.call('tiresias_apply_fix', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin');
  const b = await r2.call('tiresias_apply_fix', args); assert.equal(b.approved_by, 'Robin'); assert.match(b.result.summary, /Nothing was changed/);
  assert.ok(manifest.prompts.find((x) => x.name === 'drift_review'));
});
