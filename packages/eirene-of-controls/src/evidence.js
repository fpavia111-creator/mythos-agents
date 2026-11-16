import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, relative } from 'node:path';
import { verifyChain, toCsv, sha256, sha256File, htmlPage, escapeHtml } from 'mythos-agent-core';

/** Parse a JSONL log. Bad lines are kept as parse errors, never dropped silently. */
export function readJsonl(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { __parseError: true, __line: i + 1 }; }
  });
}

export function detectFormat(entries) {
  const e = entries.find((x) => !x.__parseError) || {};
  if (typeof e.sha256 === 'string' && ['agent-action', 'key-rotation'].includes(e.type)) return 'mythos';
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

/**
 * Verify a log. For mythos-agent-core logs, pass publicKeys (Map keyId -> KeyObject,
 * from loadPublicKeys) to check Ed25519 signatures too; a re-chained log then fails.
 * Signed key rotations inside the log extend the trusted keys.
 */
export function verifyLog(entries, { publicKeys = null } = {}) {
  const format = detectFormat(entries);
  if (format === 'mythos') {
    const bad = entries.filter((e) => e.__parseError).map((e) => ({ line: e.__line, problem: 'not valid JSON' }));
    const r = verifyChain(entries.filter((e) => !e.__parseError), { publicKeys });
    const rotations = entries.filter((e) => e.type === 'key-rotation').map((e) => ({ id: e.id, new_key_id: e.new_key_id, rotated_by: e.rotated_by || '', ts: e.ts }));
    const keyIds = [...new Set(entries.map((e) => e.key_id).filter(Boolean))];
    return { format, ...r, ok: r.ok && !bad.length, breaks: [...bad, ...r.breaks], key_ids: keyIds, key_rotations: rotations };
  }
  if (format === 'talos') return { format, ...verifyTalosChain(entries), signing: publicKeys ? 'not supported for Talos logs (chain only)' : 'chained, unsigned' };
  return { format, ok: null, entries: entries.length, breaks: [], signing: 'none', note: 'No hash chain in this log; integrity cannot be verified.' };
}

/** One-line description of a verification result for tables. */
export function integrityLabel(v) {
  if (v.ok === null) return 'no chain (unverifiable)';
  if (!v.ok) return `BROKEN (${v.breaks.length} problem(s))${v.signing === 'failed' ? ', signatures fail' : ''}`;
  return v.signing === 'signed and verified' ? 'verified, signatures verified' : `verified (${v.signing || 'chained, unsigned'})`;
}

export function normalize(e, file) {
  if (e.__parseError) return { file, ts: '', agent: '', tool: '', kind: '', decision: 'unknown', status: 'parse_error', reason: `line ${e.__line} is not valid JSON`, approved_by: '', detail: '' };
  const status = e.status || (e.decision === 'block' || e.decision === 'deny' ? 'blocked' : e.decision === 'ask' ? 'needs_approval' : e.decision ? 'executed' : e.type === 'key-rotation' ? 'recorded' : '');
  return {
    file, ts: e.ts || e.timestamp || e.date || '', agent: e.agent || '', tool: e.tool || e.event || (e.type === 'key-rotation' ? 'key_rotation' : ''),
    kind: e.kind || '', decision: e.decision === 'deny' ? 'block' : e.decision || '', status, reason: e.reason || '',
    approved_by: e.approved_by || e.approver || e.rotated_by || '', category: e.category || '', mode: e.mode || '',
    detail: e.command ? String(e.command).slice(0, 200) : e.filePath || e.summary || (e.output_sha256 ? `output_sha256 ${e.output_sha256}` : ''),
  };
}

function inPeriod(ts, start, end) {
  if (!ts) return true;
  if (start && ts < start) return false;
  if (end && ts > end + (end.length === 10 ? 'T23:59:59.999Z' : '')) return false;
  return true;
}

export function loadLogs(files, { period_start, period_end, publicKeys = null } = {}) {
  const logs = files.map((f) => {
    const entries = readJsonl(f);
    return { file: f, name: basename(f), entries, verification: verifyLog(entries, { publicKeys }) };
  });
  const events = logs.flatMap((l) => l.entries.map((e) => normalize(e, l.name))).filter((e) => inPeriod(e.ts, period_start, period_end));
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { logs, events };
}

export function summarize(events) {
  const by = (k) => events.reduce((m, e) => { const v = e[k] || '(none)'; m[v] = (m[v] || 0) + 1; return m; }, {});
  const approvals = events.filter((e) => e.approved_by && e.tool !== 'key_rotation');
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

// ---- Files -----------------------------------------------------------------------------

/** List files under dir (relative POSIX paths, sorted) with sha256 and size. Dotfiles are skipped. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(d, name); const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push({ path: relative(dir, p).split('\\').join('/'), sha256: sha256File(p), bytes: st.size });
    }
  };
  walk(dir);
  return out;
}

/** Glob to RegExp: ** any path, * within a segment, ? one character. A pattern without "/" matches the file name. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const fileMatches = (glob, path) => (glob.includes('/') ? globToRegExp(glob).test(path) : globToRegExp(glob).test(path.split('/').pop()));
const dateIn = (s) => { const m = /(\d{4}-\d{2}-\d{2})/.exec(s); return m ? m[1] : null; };

/** Compare two evidence folders (or two lists from listFiles) by relative path and sha256. */
export function diffFolders(prev, cur) {
  const P = new Map(prev.map((f) => [f.path, f])), C = new Map(cur.map((f) => [f.path, f]));
  const added = cur.filter((f) => !P.has(f.path)).map((f) => ({ path: f.path, sha256: f.sha256 }));
  const removed = prev.filter((f) => !C.has(f.path)).map((f) => ({ path: f.path, sha256: f.sha256 }));
  const changed = cur.filter((f) => P.has(f.path) && P.get(f.path).sha256 !== f.sha256).map((f) => ({ path: f.path, previous_sha256: P.get(f.path).sha256, sha256: f.sha256 }));
  const unchanged = cur.filter((f) => P.has(f.path) && P.get(f.path).sha256 === f.sha256).map((f) => ({ path: f.path, sha256: f.sha256 }));
  // Same content under a new name (e.g. a period folder renamed) is reported, not hidden.
  const byHash = new Map(prev.map((f) => [f.sha256, f.path]));
  const carried_over = added.filter((f) => byHash.has(f.sha256)).map((f) => ({ path: f.path, same_as_previous: byHash.get(f.sha256), sha256: f.sha256 }));
  return { added, removed, changed, unchanged, carried_over, counts: { previous: prev.length, current: cur.length, added: added.length, removed: removed.length, changed: changed.length, unchanged: unchanged.length } };
}

// ---- Controls ----------------------------------------------------------------------------

export const FREQUENCY_DAYS = { daily: 1, weekly: 7, monthly: 31, quarterly: 92, semiannual: 183, annual: 366 };

/** Accept the 0.1 array form or { name, controls: [...] }. */
export function normalizeControls(doc) {
  if (!doc) return { name: null, controls: [] };
  if (Array.isArray(doc)) return { name: null, controls: doc };
  return { name: doc.name || null, description: doc.description || null, controls: doc.controls || [] };
}

function valueMatches(want, got) {
  if (want === '*') return true;
  const s = String(got ?? '');
  if (typeof want === 'string' && /[*?]/.test(want)) return globToRegExp(want).test(s);
  return s === String(want);
}

const eventMatches = (match, e) => Object.entries(match || {}).every(([k, v]) => valueMatches(v, e[k]));
const controlMatchesEvent = (c, e) => [...(c.match ? [c.match] : []), ...(c.match_any || [])].some((m) => eventMatches(m, e));
const dayDiff = (a, b) => Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/**
 * Map log events and evidence files to the user's controls.
 * State: evidence_found, stale (latest dated evidence older than the control's frequency
 * allows, measured at asOf), or no_evidence_in_period (a gap).
 */
export function matchControls(controls, events, { files = [], asOf = null } = {}) {
  const list = normalizeControls(controls).controls;
  return list.map((c) => {
    const hits = (c.match || c.match_any) ? events.filter((e) => controlMatchesEvent(c, e)) : [];
    const fileHits = files.filter((f) => (c.evidence_files || []).some((g) => fileMatches(g, f.path)));
    const dates = [...hits.map((e) => String(e.ts).slice(0, 10)), ...fileHits.map((f) => dateIn(f.path)).filter(Boolean)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const latest = dates[dates.length - 1] || null;
    let state = hits.length || fileHits.length ? 'evidence_found' : 'no_evidence_in_period';
    let reason = state === 'evidence_found' ? `${hits.length} log event(s), ${fileHits.length} file(s)` : 'no matching log events or evidence files';
    const maxAge = c.frequency ? FREQUENCY_DAYS[c.frequency] : null;
    if (state === 'evidence_found' && maxAge && asOf) {
      if (!latest) reason += '; no dated evidence, so freshness was not checked';
      else if (dayDiff(latest, asOf) > maxAge) { state = 'stale'; reason = `latest evidence ${latest} is ${dayDiff(latest, asOf)} day(s) before ${asOf}; ${c.frequency} allows ${maxAge}`; }
    }
    return {
      id: c.id, title: c.title, owner: c.owner || '', frequency: c.frequency || '', events: hits.length, files: fileHits.map((f) => ({ path: f.path, sha256: f.sha256 })),
      first: hits[0]?.ts || null, last: hits[hits.length - 1]?.ts || null, latest_evidence_date: latest, state, reason,
    };
  });
}

/** Tag each event with the ids of the controls it is evidence for (space separated). */
export function tagEvents(controls, events) {
  const list = normalizeControls(controls).controls.filter((c) => c.match || c.match_any);
  return events.map((e) => ({ ...e, control_ids: list.filter((c) => controlMatchesEvent(c, e)).map((c) => c.id).join(' ') }));
}

/** One row per (control, evidence item); every row cites a control id. */
export function controlEvidenceRows(ctl, tagged) {
  const rows = [];
  for (const c of ctl) {
    for (const e of tagged.filter((x) => x.control_ids.split(' ').includes(c.id))) rows.push({ control_id: c.id, evidence_type: 'log_event', evidence: `${e.file} ${e.ts} ${e.tool}`.trim(), detail: `${e.decision}/${e.status}${e.approved_by ? ` by ${e.approved_by}` : ''}`, sha256: '' });
    for (const f of c.files) rows.push({ control_id: c.id, evidence_type: 'file', evidence: f.path, detail: '', sha256: f.sha256 });
  }
  return rows;
}

// ---- Evidence folder ----------------------------------------------------------------------

export function buildFolder({ logs, events, controls, decisions, files = [], title, period_start, period_end, generatedAt, asOf = null }) {
  const s = summarize(events);
  const ctlDoc = normalizeControls(controls);
  const ctl = matchControls(ctlDoc.controls, events, { files, asOf });
  const tagged = ctlDoc.controls.length ? tagEvents(ctlDoc.controls, events) : events;
  const gaps = ctl.filter((c) => c.state !== 'evidence_found');
  const unmappedEvents = ctlDoc.controls.length ? tagged.filter((e) => !e.control_ids).length : null;
  const out = {};
  out['events.csv'] = toCsv(tagged, ['ts', 'agent', 'tool', 'category', 'mode', 'decision', 'status', 'approved_by', 'reason', 'detail', 'file', ...(ctlDoc.controls.length ? ['control_ids'] : [])]);
  out['approvals.csv'] = toCsv(events.filter((e) => e.approved_by && e.tool !== 'key_rotation'), ['ts', 'agent', 'tool', 'approved_by', 'status', 'reason', 'file']);
  out['blocked.csv'] = toCsv(events.filter((e) => e.status === 'blocked'), ['ts', 'agent', 'tool', 'reason', 'detail', 'file']);
  out['chain-verification.json'] = JSON.stringify(logs.map((l) => ({ file: l.name, ...l.verification })), null, 2) + '\n';
  if (ctl.length) {
    out['control-map.csv'] = toCsv(ctl.map((c) => ({ ...c, files: c.files.length })), ['id', 'title', 'owner', 'frequency', 'state', 'events', 'files', 'first', 'last', 'latest_evidence_date', 'reason']);
    out['control-evidence.csv'] = toCsv(controlEvidenceRows(ctl, tagged), ['control_id', 'evidence_type', 'evidence', 'detail', 'sha256']);
    out['gaps.csv'] = toCsv(gaps, ['id', 'title', 'owner', 'frequency', 'state', 'reason']);
  }
  if (files.length) out['evidence-files.csv'] = toCsv(files, ['path', 'sha256', 'bytes']);
  if (decisions.length) out['alethea-decisions.csv'] = toCsv(decisions, ['id', 'type', 'title', 'status', 'date', 'file']);
  const L = [`# ${title || 'Agent controls evidence folder'}`, '', `Generated ${generatedAt} by eirene-of-controls from local log files.`, `Period: ${period_start || 'start of logs'} to ${period_end || 'end of logs'}.${asOf ? ` Freshness measured at ${asOf}.` : ''}`, ''];
  L.push('## What this is', '', 'A packaged, hash-listed export of what your agent guardrails logged: which actions were allowed, which waited for a person, who approved them, and which were blocked. It is evidence an auditor or reviewer can read.', '');
  L.push('## What this is not', '', '- Not an audit opinion, a certification or proof of compliance with any framework.', '- It only shows what the logs recorded. Actions taken outside the logged tools are not here.', '- A verified hash chain shows the log was not edited line by line since it was written. Without signatures it cannot prove the whole file was not rewritten; with verified signatures it shows the lines were written by the holder of the signing key. Neither proves the log is complete.', '');
  L.push('## Summary', '', `- Events: ${s.events} (${s.first || 'n/a'} → ${s.last || 'n/a'})`, `- Blocked: ${s.blocked} · Waiting for approval: ${s.waiting_for_approval} · Human approvals: ${s.approvals} · Auto-executed: ${s.auto_executed}`, `- Approvers: ${s.approvers.join(', ') || 'none recorded'}`, '');
  L.push('## Log integrity', '', '| Log | Format | Lines | Chain | Signing |', '|---|---|---:|---|---|');
  for (const l of logs) L.push(`| ${l.name} | ${l.verification.format} | ${l.verification.entries} | ${l.verification.ok === null ? 'no chain (unverifiable)' : l.verification.ok ? 'verified' : `**BROKEN** (${l.verification.breaks.length} problem(s))`} | ${l.verification.signing || 'n/a'} |`);
  if (ctl.length) {
    L.push('', '## Your control map', '', `${ctlDoc.name ? `Control list: ${ctlDoc.name}. ` : ''}Controls are the ids you supplied. Eirene matches log events and evidence files to them; whether a control is effective is for your reviewer to judge.`, '', '| Control | Title | Events | Files | State |', '|---|---|---:|---:|---|');
    for (const c of ctl) L.push(`| ${c.id} | ${c.title} | ${c.events} | ${c.files.length} | ${c.state === 'evidence_found' ? c.state : `**${c.state}**`} |`);
    L.push('', `Gaps (no evidence, or stale): ${gaps.length ? gaps.map((g) => g.id).join(', ') : 'none'} — see gaps.csv.`);
    if (unmappedEvents) L.push(`Events that map to no control: ${unmappedEvents} (control_ids is empty in events.csv).`);
  }
  if (files.length) L.push('', '## Evidence files', '', `${files.length} file(s) listed with SHA-256 in evidence-files.csv.`);
  if (decisions.length) L.push('', `## Alethea decisions`, '', `${decisions.length} decision record(s) listed in alethea-decisions.csv.`);
  const listed = [...Object.keys(out), 'index.html'];
  L.push('', '## Files', '', ...listed.map((f) => `- \`${f}\``), '- `MANIFEST.sha256`: SHA-256 of every file in this folder', '');
  out['README.md'] = L.join('\n');
  out['index.html'] = indexHtml({ title, s, logs, ctl, gaps, generatedAt, files: listed });
  out['MANIFEST.sha256'] = Object.keys(out).sort().map((f) => `${sha256(out[f])}  ${f}`).join('\n') + '\n';
  return { files: out, summary: s, controls: ctl, gaps, unmapped_events: unmappedEvents, manifest_sha256: sha256(out['MANIFEST.sha256']) };
}

function indexHtml({ title, s, logs, ctl, gaps, generatedAt, files }) {
  const e = escapeHtml;
  let b = `<p>Generated ${e(generatedAt)} by eirene-of-controls from local log files. Evidence, not certification: this is not an audit opinion or proof of compliance with any framework.</p>`;
  b += `<h2>Summary</h2><ul><li>Events: ${s.events}</li><li>Blocked: ${s.blocked}</li><li>Human approvals: ${s.approvals} (${e(s.approvers.join(', ') || 'none')})</li><li>Auto-executed: ${s.auto_executed}</li></ul>`;
  b += `<h2>Log integrity</h2><table><thead><tr><th>Log</th><th>Format</th><th>Lines</th><th>Result</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${e(l.name)}</td><td>${e(l.verification.format)}</td><td>${l.verification.entries}</td><td>${e(integrityLabel(l.verification))}</td></tr>`).join('')}</tbody></table>`;
  if (ctl.length) b += `<h2>Control map</h2><table><thead><tr><th>Control</th><th>Title</th><th>Events</th><th>Files</th><th>State</th></tr></thead><tbody>${ctl.map((c) => `<tr><td>${e(c.id)}</td><td>${e(c.title || '')}</td><td>${c.events}</td><td>${c.files.length}</td><td>${e(c.state)}</td></tr>`).join('')}</tbody></table><p>Gaps: ${e(gaps.map((g) => g.id).join(', ') || 'none')}</p>`;
  b += `<h2>Files</h2><ul>${files.map((f) => `<li>${e(f)}</li>`).join('')}<li>MANIFEST.sha256</li></ul>`;
  return htmlPage({ title: title || 'Agent controls evidence folder', bodyHtml: b, footer: 'eirene-of-controls · local files only' });
}
