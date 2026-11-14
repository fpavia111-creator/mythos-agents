import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { verifyChain, toCsv, sha256 } from 'mythos-agent-core';

/** Parse a JSONL log. Bad lines are kept as parse errors, never dropped silently. */
export function readJsonl(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { __parseError: true, __line: i + 1 }; }
  });
}

export function detectFormat(entries) {
  const e = entries.find((x) => !x.__parseError) || {};
  if (typeof e.sha256 === 'string' && e.type === 'agent-action') return 'mythos';
  if (typeof e.hash === 'string' && 'prev' in e) return 'talos';
  return 'generic';
}

/** Talos (agent-guard) chain: sha256(JSON.stringify(body without hash)), prev links. */
export function verifyTalosChain(entries) {
  let prev = null; const breaks = [];
  entries.forEach((e, i) => {
    if (e.__parseError) { breaks.push({ line: i + 1, problem: 'not valid JSON' }); return; }
    if ((e.prev || null) !== prev) breaks.push({ line: i + 1, problem: 'prev does not match the previous line' });
    const { hash, ...body } = e;
    if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== hash) breaks.push({ line: i + 1, problem: 'line content does not match its hash (edited)' });
    prev = hash;
  });
  return { ok: breaks.length === 0, entries: entries.length, breaks };
}

export function verifyLog(entries) {
  const format = detectFormat(entries);
  if (format === 'mythos') {
    const bad = entries.filter((e) => e.__parseError).map((e) => ({ line: e.__line, problem: 'not valid JSON' }));
    const r = verifyChain(entries.filter((e) => !e.__parseError));
    return { format, ...r, ok: r.ok && !bad.length, breaks: [...bad, ...r.breaks] };
  }
  if (format === 'talos') return { format, ...verifyTalosChain(entries) };
  return { format, ok: null, entries: entries.length, breaks: [], note: 'No hash chain in this log; integrity cannot be verified.' };
}

export function normalize(e, file) {
  if (e.__parseError) return { file, ts: '', agent: '', tool: '', decision: 'unknown', status: 'parse_error', reason: `line ${e.__line} is not valid JSON`, approved_by: '', detail: '' };
  const status = e.status || (e.decision === 'block' || e.decision === 'deny' ? 'blocked' : e.decision === 'ask' ? 'needs_approval' : e.decision ? 'executed' : '');
  return {
    file, ts: e.ts || e.timestamp || e.date || '', agent: e.agent || '', tool: e.tool || e.event || '',
    decision: e.decision === 'deny' ? 'block' : e.decision || '', status, reason: e.reason || '',
    approved_by: e.approved_by || e.approver || '', category: e.category || '', mode: e.mode || '',
    detail: e.command ? String(e.command).slice(0, 200) : e.filePath || e.summary || '',
  };
}

function inPeriod(ts, start, end) {
  if (!ts) return true;
  if (start && ts < start) return false;
  if (end && ts > end + (end.length === 10 ? 'T23:59:59.999Z' : '')) return false;
  return true;
}

export function loadLogs(files, { period_start, period_end } = {}) {
  const logs = files.map((f) => {
    const entries = readJsonl(f);
    return { file: f, name: basename(f), entries, verification: verifyLog(entries) };
  });
  const events = logs.flatMap((l) => l.entries.map((e) => normalize(e, l.name))).filter((e) => inPeriod(e.ts, period_start, period_end));
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { logs, events };
}

export function summarize(events) {
  const by = (k) => events.reduce((m, e) => { const v = e[k] || '(none)'; m[v] = (m[v] || 0) + 1; return m; }, {});
  const approvals = events.filter((e) => e.approved_by);
  return {
    events: events.length,
    first: events[0]?.ts || null, last: events[events.length - 1]?.ts || null,
    by_decision: by('decision'), by_status: by('status'), by_agent: by('agent'), by_tool: by('tool'),
    approvals: approvals.length, approvers: [...new Set(approvals.map((e) => e.approved_by))],
    blocked: events.filter((e) => e.status === 'blocked').length,
    waiting_for_approval: events.filter((e) => e.status === 'needs_approval').length,
    auto_executed: events.filter((e) => e.mode === 'auto' && e.status === 'executed').length,
  };
}

/** Read Alethea .decisions/*.md frontmatter (id, title, status, date) without a YAML parser. */
export function readAletheaDecisions(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const get = (k) => { const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')); if (!m) return ''; let v = m[1].trim(); try { v = JSON.parse(v); } catch {} return String(v); };
    return { file: f, id: get('id'), type: get('type'), title: get('title'), status: get('status'), date: get('date') };
  });
}

export function matchControls(controls, events) {
  return (controls || []).map((c) => {
    const m = c.match || {};
    const hits = events.filter((e) => Object.entries(m).every(([k, v]) => {
      if (v === '*') return true;
      if (typeof v === 'string' && v.endsWith('*')) return String(e[k] || '').startsWith(v.slice(0, -1));
      return String(e[k] || '') === String(v);
    }));
    return { id: c.id, title: c.title, events: hits.length, first: hits[0]?.ts || null, last: hits[hits.length - 1]?.ts || null, state: hits.length ? 'evidence_found' : 'no_evidence_in_period' };
  });
}

export function buildFolder({ logs, events, controls, decisions, title, period_start, period_end, generatedAt }) {
  const s = summarize(events);
  const ctl = matchControls(controls, events);
  const files = {};
  files['events.csv'] = toCsv(events, ['ts', 'agent', 'tool', 'category', 'mode', 'decision', 'status', 'approved_by', 'reason', 'detail', 'file']);
  files['approvals.csv'] = toCsv(events.filter((e) => e.approved_by), ['ts', 'agent', 'tool', 'approved_by', 'status', 'reason', 'file']);
  files['blocked.csv'] = toCsv(events.filter((e) => e.status === 'blocked'), ['ts', 'agent', 'tool', 'reason', 'detail', 'file']);
  files['chain-verification.json'] = JSON.stringify(logs.map((l) => ({ file: l.name, ...l.verification })), null, 2) + '\n';
  if (ctl.length) files['control-map.csv'] = toCsv(ctl, ['id', 'title', 'state', 'events', 'first', 'last']);
  if (decisions.length) files['alethea-decisions.csv'] = toCsv(decisions, ['id', 'type', 'title', 'status', 'date', 'file']);
  const L = [`# ${title || 'Agent controls evidence folder'}`, '', `Generated ${generatedAt} by eirene-of-controls from local log files.`, `Period: ${period_start || 'start of logs'} to ${period_end || 'end of logs'}.`, ''];
  L.push('## What this is', '', 'A packaged, hash-listed export of what your agent guardrails logged: which actions were allowed, which waited for a person, who approved them, and which were blocked. It is evidence an auditor or reviewer can read.', '');
  L.push('## What this is not', '', '- Not an audit opinion, a certification or proof of compliance with any framework.', '- It only shows what the logs recorded. Actions taken outside the logged tools are not here.', '- A verified hash chain shows the log was not edited line by line since it was written. It cannot prove the log was complete, or that the whole file was not rewritten.', '');
  L.push('## Summary', '', `- Events: ${s.events} (${s.first || 'n/a'} → ${s.last || 'n/a'})`, `- Blocked: ${s.blocked} · Waiting for approval: ${s.waiting_for_approval} · Human approvals: ${s.approvals} · Auto-executed: ${s.auto_executed}`, `- Approvers: ${s.approvers.join(', ') || 'none recorded'}`, '');
  L.push('## Log integrity', '', '| Log | Format | Lines | Chain |', '|---|---|---:|---|');
  for (const l of logs) L.push(`| ${l.name} | ${l.verification.format} | ${l.verification.entries} | ${l.verification.ok === null ? 'no chain (unverifiable)' : l.verification.ok ? 'verified' : `**BROKEN** (${l.verification.breaks.length} problem(s))`} |`);
  if (ctl.length) {
    L.push('', '## Your control map', '', 'Controls are the ids you supplied. Eirene matches log events to them; whether a control is effective is for your reviewer to judge.', '', '| Control | Title | Events | State |', '|---|---|---:|---|');
    for (const c of ctl) L.push(`| ${c.id} | ${c.title} | ${c.events} | ${c.state} |`);
  }
  if (decisions.length) L.push('', `## Alethea decisions`, '', `${decisions.length} decision record(s) listed in alethea-decisions.csv.`);
  L.push('', '## Files', '', ...Object.keys(files).map((f) => `- \`${f}\``), '- `MANIFEST.sha256`: SHA-256 of every file in this folder', '');
  files['README.md'] = L.join('\n');
  files['MANIFEST.sha256'] = Object.keys(files).sort().map((f) => `${sha256(files[f])}  ${f}`).join('\n') + '\n';
  return { files, summary: s, controls: ctl };
}
