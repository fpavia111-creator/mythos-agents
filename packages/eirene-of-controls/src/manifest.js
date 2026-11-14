import { defineManifest } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { loadLogs, summarize, verifyLog, readJsonl, readAletheaDecisions, buildFolder } from './evidence.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const logsArg = (a) => { const l = a.logs || (a.log ? [a.log] : []); if (!Array.isArray(l) || !l.length) throw new Error('pass "logs": ["path/to/audit.jsonl", ...]'); return l; };

export const manifest = defineManifest({
  name: 'eirene-of-controls',
  version: pkg.version,
  description: 'Turns Talos and mythos-agent-core JSONL audit logs (plus optional Alethea decisions) into a hash-listed evidence folder a reviewer can read. Evidence, not certification.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  tools: [
    {
      name: 'eirene_summarize_logs', kind: 'read',
      description: 'Summarize one or more JSONL audit logs: events by decision, status, agent and tool; approvals and approvers; blocks.',
      inputSchema: { type: 'object', properties: { logs: { type: 'array', items: str }, log: str, period_start: str, period_end: str } },
      handler: async (a, ctx) => {
        const { logs, events } = loadLogs(logsArg(a).map(ctx.path), a);
        const s = summarize(events);
        return { summary: `${s.events} event(s): ${s.blocked} blocked, ${s.approvals} human approval(s), ${s.waiting_for_approval} waiting.`, ...s, chains: logs.map((l) => ({ file: l.name, format: l.verification.format, ok: l.verification.ok })) };
      },
    },
    {
      name: 'eirene_verify_chain', kind: 'read',
      description: 'Verify the hash chain of a Talos or mythos-agent-core JSONL log and list any edited, removed or reordered lines.',
      inputSchema: { type: 'object', required: ['log'], properties: { log: str } },
      handler: async (a, ctx) => {
        const r = verifyLog(readJsonl(ctx.path(a.log)));
        return { summary: `${a.log}: ${r.format} log, ${r.entries} line(s), chain ${r.ok === null ? 'not present' : r.ok ? 'verified' : 'BROKEN'}.`, ...r };
      },
    },
    {
      name: 'eirene_build_evidence', kind: 'report',
      description: 'Write an evidence folder (README, events/approvals/blocked CSVs, chain verification, optional control map and Alethea decisions, MANIFEST.sha256) into out_dir (default mythos-out/eirene).',
      inputSchema: { type: 'object', properties: { logs: { type: 'array', items: str }, log: str, out_dir: str, period_start: str, period_end: str, controls: { ...str, description: 'JSON file: [{id, title, match:{decision|status|tool|category: value}}]' }, alethea_dir: str, title: str } },
      handler: async (a, ctx) => {
        const { logs, events } = loadLogs(logsArg(a).map(ctx.path), a);
        const controls = a.controls ? JSON.parse(readFileSync(ctx.path(a.controls), 'utf8')) : [];
        const decisions = a.alethea_dir ? readAletheaDecisions(ctx.path(a.alethea_dir)) : [];
        const out = ctx.outDir(a.out_dir || 'mythos-out/eirene');
        const r = buildFolder({ logs, events, controls, decisions, title: a.title, period_start: a.period_start, period_end: a.period_end, generatedAt: new Date().toISOString() });
        const written = Object.entries(r.files).map(([n, t]) => ctx.writeFile(out, n, t));
        const broken = logs.filter((l) => l.verification.ok === false).length;
        return { summary: `Evidence folder written: ${written.length} files, ${r.summary.events} events${broken ? `, ${broken} log(s) with a BROKEN chain` : ''}.`, out_dir: out, files: written, controls: r.controls, broken_chains: broken };
      },
    },
    {
      name: 'eirene_send_to_auditor', kind: 'action', category: 'binding_send',
      description: 'Listed so agents can see it is refused. Eirene does not send evidence or sign attestations; a named person reviews the folder and shares it.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'eirene_summarize_logs', decision: 'allow' },
    { tool: 'eirene_verify_chain', decision: 'allow' },
    { tool: 'eirene_build_evidence', decision: 'allow' },
    { tool: 'eirene_send_to_auditor', decision: 'block', reason: 'Eirene never sends evidence or signs attestations. A named person reviews and shares the folder.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eirene allowlist.' },
  ] },
});
