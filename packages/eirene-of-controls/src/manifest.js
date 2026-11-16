import { defineManifest, loadPublicKeys, assertValid, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { loadLogs, summarize, verifyLog, readJsonl, readAletheaDecisions, buildFolder, matchControls, tagEvents, normalizeControls, listFiles, diffFolders, integrityLabel } from './evidence.js';
import { controlsSchema } from './schemas.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TEMPLATE_DIR = new URL('../templates/', import.meta.url);
const TEMPLATES = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const str = { type: 'string' };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' };
const logsSchema = { type: 'array', items: str, minItems: 1 };
const publicKeysArg = { type: 'array', items: str, minItems: 1, description: 'Public key PEM files (under --root) to verify signed mythos-agent-core logs. The private key never needs to be here.' };
const controlsArg = { ...str, description: 'Your control list JSON (schema "controls"): [{id, title, match | match_any, evidence_files?, frequency?, owner?}] or {name, controls: [...]}' };
const templateArg = { enum: TEMPLATES, description: 'Use a bundled starter control list instead of a file (rename the ids to match your own list)' };

const logsArg = (a) => { const l = a.logs || (a.log ? [a.log] : []); if (!Array.isArray(l) || !l.length) throw new Error('pass "logs": ["path/to/audit.jsonl", ...]'); return l; };
const keysOf = (a, ctx) => (a.public_keys ? loadPublicKeys(a.public_keys.map((p) => ctx.readText(p))) : null);

function readTemplate(name) {
  const doc = JSON.parse(readFileSync(new URL(`${name}.json`, TEMPLATE_DIR), 'utf8'));
  return assertValid(controlsSchema, doc, `template ${name} is not a valid controls file`);
}

function controlsOf(a, ctx) {
  if (a.controls && a.template) throw new Error('pass "controls" or "template", not both');
  if (a.controls) return ctx.readJson(a.controls, 'controls');
  if (a.template) return readTemplate(a.template);
  return null;
}

const dirFiles = (ctx, d) => { const p = ctx.path(d); if (!statSync(p).isDirectory()) throw new Error(`${d} is not a folder`); return listFiles(p); };
const asOfOf = (a) => a.as_of || (a.period_end ? String(a.period_end).slice(0, 10) : null);

export const manifest = defineManifest({
  name: 'eirene-of-controls',
  version: pkg.version,
  description: 'Turns Talos and mythos-agent-core JSONL audit logs (plus optional Alethea decisions and evidence files) into a hash-listed evidence folder mapped to your own control ids. Verifies hash chains and Ed25519 signatures. Evidence, not certification.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  configSchemas: { controls: controlsSchema },
  tools: [
    {
      name: 'eirene_summarize_logs', kind: 'read', title: 'Summarize audit logs',
      description: 'Summarize one or more JSONL audit logs: events by decision, status, agent and tool; approvals and approvers; blocks; chain and signing status per log.',
      inputSchema: { type: 'object', properties: { logs: logsSchema, log: str, period_start: date, period_end: date, public_keys: publicKeysArg } },
      handler: async (a, ctx) => {
        const { logs, events } = loadLogs(logsArg(a).map(ctx.path), { ...a, publicKeys: keysOf(a, ctx) });
        const s = summarize(events);
        return { summary: `${s.events} event(s): ${s.blocked} blocked, ${s.approvals} human approval(s), ${s.waiting_for_approval} waiting.`, ...s, chains: logs.map((l) => ({ file: l.name, format: l.verification.format, ok: l.verification.ok, signing: l.verification.signing })) };
      },
    },
    {
      name: 'eirene_verify_chain', kind: 'read', title: 'Verify a log\'s chain and signatures',
      description: 'Verify the hash chain of a Talos or mythos-agent-core JSONL log and list any edited, removed or reordered lines. With public_keys, also verify Ed25519 signatures (signed key rotations are followed), so a re-chained log fails.',
      inputSchema: { type: 'object', required: ['log'], properties: { log: str, public_keys: publicKeysArg } },
      handler: async (a, ctx) => {
        const r = verifyLog(readJsonl(ctx.path(a.log)), { publicKeys: keysOf(a, ctx) });
        return { summary: `${a.log}: ${r.format} log, ${r.entries} line(s), ${integrityLabel(r)}.`, ...r };
      },
    },
    {
      name: 'eirene_list_templates', kind: 'read', title: 'List starter control templates',
      description: 'List the bundled starter control lists (ids are placeholders to rename to your own list; not official framework mappings). With "template", return that template\'s controls to copy and edit.',
      inputSchema: { type: 'object', properties: { template: templateArg } },
      handler: async (a) => {
        if (a.template) { const t = readTemplate(a.template); return { summary: `${a.template}: ${t.controls.length} control(s).`, template: a.template, ...t }; }
        const list = TEMPLATES.map((n) => { const t = readTemplate(n); return { template: n, name: t.name, description: t.description, controls: t.controls.length }; });
        return { summary: `${list.length} template(s): ${TEMPLATES.join(', ')}.`, templates: list };
      },
    },
    {
      name: 'eirene_map_controls', kind: 'read', title: 'Map evidence to controls',
      description: 'Map log events and evidence files to your own control ids. Lists every evidence item with the control it supports, controls with no evidence (gaps), controls whose latest evidence is older than their frequency allows (stale, measured at as_of or period_end), and events that map to no control.',
      inputSchema: { type: 'object', properties: { logs: logsSchema, log: str, controls: controlsArg, template: templateArg, evidence_dir: { ...str, description: 'Folder of evidence files (e.g. access reviews, change logs) under --root' }, period_start: date, period_end: date, as_of: date } },
      handler: async (a, ctx) => {
        const doc = controlsOf(a, ctx);
        if (!doc) throw new Error('pass "controls" (your control list) or "template"');
        const { events } = a.logs || a.log ? loadLogs(logsArg(a).map(ctx.path), a) : { events: [] };
        const files = a.evidence_dir ? dirFiles(ctx, a.evidence_dir) : [];
        const ctl = matchControls(doc, events, { files, asOf: asOfOf(a) });
        const tagged = tagEvents(doc, events);
        const gaps = ctl.filter((c) => c.state !== 'evidence_found');
        const unmapped = tagged.filter((e) => !e.control_ids);
        return {
          summary: `${ctl.length} control(s): ${ctl.length - gaps.length} with current evidence, ${gaps.filter((g) => g.state === 'no_evidence_in_period').length} gap(s), ${gaps.filter((g) => g.state === 'stale').length} stale; ${unmapped.length} event(s) map to no control.`,
          control_list: normalizeControls(doc).name, as_of: asOfOf(a), controls: ctl, gaps: gaps.map(({ id, title, state, reason }) => ({ id, title, state, reason })),
          unmapped_events: unmapped.slice(0, 100).map(({ ts, agent, tool, decision, status, file }) => ({ ts, agent, tool, decision, status, file })), unmapped_event_count: unmapped.length,
          note: 'Matching evidence to a control does not show the control works. That is for your reviewer to judge.',
        };
      },
    },
    {
      name: 'eirene_diff_evidence', kind: 'read', title: 'Diff evidence folders between periods',
      description: 'Compare two evidence folders (e.g. last quarter and this quarter, or two built evidence folders) by relative path and SHA-256: added, removed, changed and unchanged files, and files carried over unchanged under a new name.',
      inputSchema: { type: 'object', required: ['previous', 'current'], properties: { previous: str, current: str } },
      handler: async (a, ctx) => {
        const r = diffFolders(dirFiles(ctx, a.previous), dirFiles(ctx, a.current));
        return { summary: `${r.counts.added} added, ${r.counts.removed} removed, ${r.counts.changed} changed, ${r.counts.unchanged} unchanged.`, ...r };
      },
    },
    {
      name: 'eirene_build_evidence', kind: 'report', title: 'Build the evidence folder',
      description: 'Write an evidence folder (README, index.html, events/approvals/blocked CSVs, chain and signature verification, optional control map with control-evidence.csv and gaps.csv, evidence file hashes, a diff against the previous period, Alethea decisions, MANIFEST.sha256) into out_dir (default mythos-out/eirene). The manifest hash is recorded in the audit log.',
      inputSchema: { type: 'object', properties: { logs: logsSchema, log: str, out_dir: str, period_start: date, period_end: date, as_of: date, controls: controlsArg, template: templateArg, evidence_dir: str, previous_evidence_dir: { ...str, description: 'Last period\'s evidence folder, to add evidence-diff.csv' }, alethea_dir: str, public_keys: publicKeysArg, title: str } },
      handler: async (a, ctx) => {
        const { logs, events } = loadLogs(logsArg(a).map(ctx.path), { ...a, publicKeys: keysOf(a, ctx) });
        const controls = controlsOf(a, ctx) || [];
        const decisions = a.alethea_dir ? readAletheaDecisions(ctx.path(a.alethea_dir)) : [];
        const files = a.evidence_dir ? dirFiles(ctx, a.evidence_dir) : [];
        const out = ctx.outDir(a.out_dir || 'mythos-out/eirene');
        const r = buildFolder({ logs, events, controls, decisions, files, title: a.title, period_start: a.period_start, period_end: a.period_end, generatedAt: new Date().toISOString(), asOf: asOfOf(a) });
        if (a.previous_evidence_dir) {
          if (!a.evidence_dir) throw new Error('previous_evidence_dir needs evidence_dir');
          const d = diffFolders(dirFiles(ctx, a.previous_evidence_dir), files);
          const rows = [...d.added.map((f) => ({ change: 'added', path: f.path, previous_sha256: '', sha256: f.sha256 })), ...d.removed.map((f) => ({ change: 'removed', path: f.path, previous_sha256: f.sha256, sha256: '' })), ...d.changed.map((f) => ({ change: 'changed', ...f })), ...d.unchanged.map((f) => ({ change: 'unchanged', path: f.path, previous_sha256: f.sha256, sha256: f.sha256 }))];
          r.files['evidence-diff.csv'] = toCsv(rows, ['change', 'path', 'previous_sha256', 'sha256']);
          // Rebuild the manifest so it covers the diff file too.
          delete r.files['MANIFEST.sha256'];
          r.files['README.md'] = r.files['README.md'].replace('- `MANIFEST.sha256`', `- \`evidence-diff.csv\`: ${d.counts.added} added, ${d.counts.removed} removed, ${d.counts.changed} changed since ${a.previous_evidence_dir}\n- \`MANIFEST.sha256\``);
          r.files['MANIFEST.sha256'] = Object.keys(r.files).sort().map((f) => `${sha256(r.files[f])}  ${f}`).join('\n') + '\n';
          r.manifest_sha256 = sha256(r.files['MANIFEST.sha256']);
        }
        const written = Object.entries(r.files).map(([n, t]) => ctx.writeFile(out, n, t));
        const broken = logs.filter((l) => l.verification.ok === false).length;
        return {
          summary: `Evidence folder written: ${written.length} files, ${r.summary.events} events${broken ? `, ${broken} log(s) with a BROKEN chain or signature` : ''}${r.gaps.length ? `, ${r.gaps.length} control gap(s)` : ''}. Manifest ${r.manifest_sha256.slice(0, 12)}.`,
          out_dir: out, files: written, controls: r.controls, gaps: r.gaps.map(({ id, state }) => ({ id, state })), unmapped_events: r.unmapped_events, broken_chains: broken,
          signing: logs.map((l) => ({ file: l.name, signing: l.verification.signing })), output_sha256: r.manifest_sha256,
        };
      },
    },
    {
      name: 'eirene_send_to_auditor', kind: 'action', category: 'binding_send', title: 'Send evidence (refused)',
      description: 'Listed so agents can see it is refused. Eirene does not send evidence or sign attestations; a named person reviews the folder and shares it.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  prompts: [
    {
      name: 'eirene_evidence_review', title: 'Prepare a controls evidence folder',
      description: 'Walk through building an evidence folder for a period: verify logs (and signatures), map evidence to your controls, find gaps and stale evidence, diff against last period, and build the folder. Sharing stays with a person.',
      arguments: [
        { name: 'logs', description: 'Comma-separated audit log paths under --root (e.g. .mythos/audit.jsonl,.agent-guard/audit.jsonl)', required: true },
        { name: 'controls', description: 'Your control list JSON, or leave empty and pick a template', required: false },
        { name: 'period_start', description: 'YYYY-MM-DD', required: false },
        { name: 'period_end', description: 'YYYY-MM-DD', required: false },
        { name: 'evidence_dir', description: 'This period\'s evidence folder', required: false },
        { name: 'previous_evidence_dir', description: 'Last period\'s evidence folder', required: false },
        { name: 'public_keys', description: 'Public key PEM file(s) for signed logs', required: false },
      ],
      text: [
        'You are helping a reviewer package evidence of how AI agents were controlled during a period. Use the eirene-of-controls tools only. The output is evidence, not certification: never say a control is "effective", "compliant" or "certified".',
        '',
        '1. For each log in {{logs}}, call eirene_verify_chain (with public_keys={{public_keys}} when given). Report any BROKEN chain or failed signature with line numbers first; a broken log must be explained by a person before the folder is shared. If a log is mythos-format and unsigned, say that a verified chain cannot rule out a full rewrite.',
        '2. Call eirene_summarize_logs for the period {{period_start}} to {{period_end}}.',
        '3. If no control list is given ({{controls}}), call eirene_list_templates and suggest one as a starting point the user must rename to their own ids.',
        '4. Call eirene_map_controls with the logs, controls (or template), evidence_dir={{evidence_dir}} and period_end. List gaps and stale controls with the reason, and how many events map to no control.',
        '5. If a previous evidence folder is given ({{previous_evidence_dir}}), call eirene_diff_evidence and list added, removed and changed files with hashes.',
        '6. Call eirene_build_evidence with the same arguments (and previous_evidence_dir). Give the folder path and the manifest hash (output_sha256), which is recorded in the audit log.',
        '',
        'Human step: a named person reviews the folder and decides whether and how to share it. eirene_send_to_auditor is blocked in every mode; do not call it.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'eirene_summarize_logs', decision: 'allow' },
    { tool: 'eirene_verify_chain', decision: 'allow' },
    { tool: 'eirene_list_templates', decision: 'allow' },
    { tool: 'eirene_map_controls', decision: 'allow' },
    { tool: 'eirene_diff_evidence', decision: 'allow' },
    { tool: 'eirene_build_evidence', decision: 'allow' },
    { tool: 'eirene_send_to_auditor', decision: 'block', reason: 'Eirene never sends evidence or signs attestations. A named person reviews and shares the folder.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eirene allowlist.' },
  ] },
});
