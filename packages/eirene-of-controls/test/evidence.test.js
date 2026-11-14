import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest, verifyTalosChain, normalize, matchControls } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

test('talos chain detects a removed line', () => {
  const lines = readFileSync(join(fixtures, 'talos-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(verifyTalosChain(lines).ok, true);
  assert.equal(verifyTalosChain([lines[0], lines[2]]).ok, false);
});

test('talos deny is normalized to block', () => {
  assert.equal(normalize({ decision: 'deny', ts: 'x' }, 'f').decision, 'block');
  assert.equal(normalize({ decision: 'deny' }, 'f').status, 'blocked');
});

test('control matching supports prefix wildcards', () => {
  const c = matchControls([{ id: 'A', title: 't', match: { tool: 'augeas_*' } }, { id: 'B', title: 'u', match: { tool: 'none' } }], [{ tool: 'augeas_apply_merge', ts: '1' }]);
  assert.equal(c[0].state, 'evidence_found'); assert.equal(c[1].state, 'no_evidence_in_period');
});

test('evidence folder has a correct manifest and honest README', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eirene-'));
  cpSync(fixtures, root, { recursive: true });
  const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('eirene_build_evidence', { logs: ['talos-audit.jsonl', 'tampered-audit.jsonl'], controls: 'controls.json', alethea_dir: '.decisions' });
  assert.equal(r.status, 'executed');
  assert.equal(r.result.broken_chains, 1);
  const dir = r.result.out_dir;
  const lines = readFileSync(join(dir, 'MANIFEST.sha256'), 'utf8').trim().split('\n');
  for (const l of lines) {
    const [h, f] = l.split(/\s+/);
    assert.equal(createHash('sha256').update(readFileSync(join(dir, f), 'utf8')).digest('hex'), h, f);
  }
  assert.equal(lines.length, readdirSync(dir).length - 1);
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /Not an audit opinion, a certification or proof of compliance/);
  assert.match(readme, /BROKEN/);
  assert.match(readFileSync(join(dir, 'alethea-decisions.csv'), 'utf8'), /ADR-0001/);
});

test('period filter', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const r = await rt.call('eirene_summarize_logs', { logs: ['talos-audit.jsonl'], period_start: '2026-11-03', period_end: '2026-11-03' });
  assert.equal(r.result.events, 1);
});
