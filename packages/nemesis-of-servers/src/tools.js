// Tool-definition review (tool poisoning, shadowing, over-broad schemas) and pinning
// (rug-pull detection) for a saved tools/list result. Nemesis never connects to a server:
// you capture tools/list yourself (for example with the MCP Inspector CLI) and pass the file.
import { sha256, canonical, unifiedDiff } from 'mythos-agent-core';
import { RULES } from './catalog.js';

const INJECTION = /ignore (all |any )?(previous|prior|above|earlier|other) (instructions|rules|prompts?|directions)|disregard (all |any )?(previous|prior|other|the above)|(do not|don'?t|never) (tell|inform|mention|reveal|notify|alert|show)\b[^.]{0,30}\b(the )?user|without (asking|telling|informing|notifying|alerting) the user|(the )?user (must|should) not (know|see|be told)|<\s*\/?\s*(important|system|instructions?|secret|hidden|admin)\s*>|\[\s*(system|important|admin)\s*\]|new (system )?instructions\s*:|override (the |your )?(system|previous|safety)/i;
const COERCIVE = /\byou (must|have to|need to) (first |always )?(call|use|run|invoke|read|execute)\b|\bbefore (using|calling|running) (this|any other|any) tool\b|\b(this|it) is (very |extremely |critically )?important\b|\botherwise (the )?(tool|system|app) (will|would) (not work|fail|crash)\b|\balways (call|use|run) this tool\b/i;
const SENSITIVE = /~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.aws\b|\.npmrc|\.netrc|\.env\b|\.kube\/config|\.docker\/config|mcp\.json|claude_desktop_config|\.cursor\/|\/etc\/(passwd|shadow)|private key|api[_ ]?keys?\b|seed phrase|wallet\.dat/i;
const CONTEXT = /(full|entire|whole|complete) (conversation|chat|history|context|transcript|prompt)|system prompt|previous (messages|turns)|all (prior|previous|earlier) (messages|tool (calls|results))|(contents?|content) of (the )?(file|~|\/|\.|any)|chat history/i;
const SHADOW = /\bwhen (the user |you )?(use|call|invoke|run)s? (the |any )?[`'"]?[\w.-]+[`'"]? tool\b|\binstead of (using|calling) (the )?[`'"]?[\w.-]+|\b(all|every|any) (emails?|messages?|requests?|payments?|transfers?) (must|should) (also )?(be sent|go|be forwarded|be copied) to\b|\b(bcc|cc|copy|forward)\b[^.]{0,40}\bto\b[^.]{0,30}@|\bchange (the )?(recipient|destination|account|address) to\b/i;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const PADDING = /[ \t]{40,}|(\r?\n\s*){12,}/;
const ENCODED = /[A-Za-z0-9+/]{80,}={0,2}/;
const FREEFORM = /^(command|cmd|commands|shell|script|code|sql|query_sql|raw_sql|expression|eval|exec|program)$/i;
const DESTRUCTIVE = /(^|[_\-.])(delete|remove|drop|destroy|purge|wipe|truncate|send|transfer|pay|deploy|exec|execute|run|kill|revoke|write|overwrite|move|push)([_\-.]|$)|^(delete|remove|drop|destroy|purge|send|transfer|pay|deploy|exec|execute|run|kill|revoke|write|overwrite|move|push)[A-Z]/;
const STATE_CHANGING = /(^|[_\-.])(create|update|edit|set|post|upload|merge|insert|append|rename|archive)([_\-.]|$)|^(create|update|edit|set|post|upload|merge|insert|append|rename)[A-Z]/;

/** Normalise a saved tools/list result (or several) to [{ server, tools: [...] }]. */
export function normalizeToolDump(json, defaultServer = 'server') {
  if (Array.isArray(json)) return [{ server: defaultServer, tools: json }];
  if (json && json.result && Array.isArray(json.result.tools)) return [{ server: json.server || defaultServer, tools: json.result.tools }];
  if (json && Array.isArray(json.tools)) return [{ server: json.server || defaultServer, tools: json.tools }];
  if (json && json.servers && typeof json.servers === 'object') {
    return Object.entries(json.servers).sort(([a], [b]) => a.localeCompare(b)).map(([server, v]) => ({ server, tools: Array.isArray(v) ? v : v.tools || v.result?.tools || [] }));
  }
  throw new Error('not a tools/list result: expected {tools:[...]}, {result:{tools:[...]}}, {servers:{name:{tools:[...]}}} or an array of tools');
}

/** Every human-readable string in a tool definition, with a path for the report. */
function texts(tool) {
  const out = [['description', tool.description], ['title', tool.title], ['annotations.title', tool.annotations?.title]];
  const walk = (schema, path, depth = 0) => {
    if (!schema || typeof schema !== 'object' || depth > 6) return;
    if (schema.description) out.push([`${path}.description`, schema.description]);
    if (schema.title) out.push([`${path}.title`, schema.title]);
    if (schema.default !== undefined && typeof schema.default === 'string') out.push([`${path}.default`, schema.default]);
    for (const [k, v] of Object.entries(schema.properties || {})) walk(v, `${path}.${k}`, depth + 1);
    if (schema.items) walk(schema.items, `${path}[]`, depth + 1);
  };
  walk(tool.inputSchema, 'inputSchema');
  return out.filter(([, t]) => typeof t === 'string' && t);
}

const excerpt = (t, re) => {
  const m = re.exec(t); if (!m) return t.slice(0, 120);
  const s = Math.max(0, m.index - 40); return (s ? '…' : '') + t.slice(s, m.index + m[0].length + 60).replace(/\s+/g, ' ').replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu, '⟨?⟩') + '…';
};

/** Rule hits for one tool's text (used by scan and by the pin diff). */
export function textHits(tool, otherToolNames = []) {
  const hits = [];
  for (const [field, t] of texts(tool)) {
    const add = (id, re) => hits.push({ id, field, snippet: excerpt(t, re) });
    if (INJECTION.test(t)) add('NEM-TOOL-INJECTION', INJECTION);
    else if (COERCIVE.test(t)) add('NEM-TOOL-COERCIVE', COERCIVE);
    if (INVISIBLE.test(t)) add('NEM-TOOL-HIDDEN-UNICODE', INVISIBLE);
    if (PADDING.test(t)) add('NEM-TOOL-PADDING', PADDING);
    if (SENSITIVE.test(t)) add('NEM-TOOL-SENSITIVE-PATH', SENSITIVE);
    if (CONTEXT.test(t)) add('NEM-TOOL-CONTEXT-EXFIL', CONTEXT);
    if (SHADOW.test(t)) add('NEM-TOOL-SHADOWING', SHADOW);
    else {
      const other = otherToolNames.find((n) => n.length >= 4 && /[_\-.]|[a-z][A-Z]/.test(n) && new RegExp(`(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(t));
      if (other) hits.push({ id: 'NEM-TOOL-SHADOWING', field, snippet: excerpt(t, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), title: `Tool text names another server's tool (${other})` });
    }
    if (ENCODED.test(t)) add('NEM-TOOL-ENCODED', ENCODED);
    if (field === 'description' && t.length > 1500) hits.push({ id: 'NEM-TOOL-LONG-DESC', field, snippet: `${t.length} characters`, title: `Description is ${t.length} characters long` });
  }
  return hits;
}

const esc = (n) => JSON.stringify(n).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Line of "name" in the raw JSON, searching after the server's key when there is one. */
function lineOf(text, needle, server) {
  if (!text) return 1;
  const from = server ? Math.max(0, text.indexOf(JSON.stringify(server))) : 0;
  let i = text.indexOf(needle, from);
  if (i < 0) { const n = JSON.parse(needle); i = text.indexOf(esc(n), from); }
  if (i < 0) i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

/** Scan normalised dumps. opts: { file, text } for SARIF locations. */
export function scanTools(dumps, opts = {}) {
  const findings = [];
  const byName = new Map();
  for (const d of dumps) for (const t of d.tools) { const k = String(t.name || ''); byName.set(k, [...(byName.get(k) || []), d.server]); }
  for (const d of dumps) {
    const others = dumps.filter((x) => x.server !== d.server).flatMap((x) => x.tools.map((t) => String(t.name || '')));
    for (const t of d.tools) {
      const name = String(t.name || '');
      const line = lineOf(opts.text, JSON.stringify(name), dumps.length > 1 ? d.server : null);
      const add = (f) => findings.push({ ...f, server: d.server, tool: name, ...(opts.file ? { file: opts.file, line } : {}) });
      for (const h of textHits(t, others)) add({ id: h.id, title: `${h.title || RULES[h.id].title} (${h.field})`, snippet: h.snippet, field: h.field });
      if (/[^\x20-\x7E]/.test(name)) add({ id: 'NEM-TOOL-CONFUSABLE-NAME', title: `Tool name "${name}" contains non-ASCII characters`, snippet: [...name].map((c) => (c.charCodeAt(0) > 126 ? `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('') });
      if ((byName.get(name) || []).length > 1 && byName.get(name)[0] === d.server) add({ id: 'NEM-TOOL-NAME-COLLISION', title: `"${name}" is defined by ${byName.get(name).join(', ')}` });
      for (const [p, s] of Object.entries(t.inputSchema?.properties || {})) {
        if (FREEFORM.test(p) && (!s || s.type === 'string' || s.type === undefined) && !s?.enum && !s?.pattern && !s?.const) add({ id: 'NEM-TOOL-FREEFORM-EXEC', title: `Parameter "${p}" takes any string`, field: `inputSchema.${p}` });
      }
      const ann = t.annotations || null;
      const destructive = DESTRUCTIVE.test(name);
      if (ann && ann.readOnlyHint === true && destructive) add({ id: 'NEM-TOOL-ANNOTATION-MISMATCH', title: `"${name}" says readOnlyHint: true` });
      else if (!ann && (destructive || STATE_CHANGING.test(name))) add({ id: 'NEM-TOOL-NO-ANNOTATIONS', title: `"${name}" has no annotations` });
    }
  }
  return findings;
}

// ---- pins (rug-pull detection) ----

const pinBody = (t) => ({ name: t.name, title: t.title ?? null, description: t.description ?? '', inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null });

/** Build a deterministic pin file: one sha256 per tool plus the reviewed text, for diffs later. */
export function pinTools(dumps) {
  const servers = {};
  for (const d of dumps) {
    servers[d.server] = {};
    for (const t of [...d.tools].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const b = pinBody(t);
      servers[d.server][t.name] = { sha256: sha256(canonical(b)), ...b };
    }
  }
  return { format: 'nemesis-tool-pins/1', note: 'Pins the tool definitions a person reviewed. Compare later with nemesis_check_pins.', servers };
}

export const PINS_SCHEMA = {
  type: 'object', required: ['format', 'servers'],
  properties: {
    format: { const: 'nemesis-tool-pins/1' },
    note: { type: 'string' },
    servers: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'object', required: ['sha256', 'name'], properties: { sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, name: { type: 'string' } } } } },
  },
};

const pretty = (v) => JSON.stringify(v ?? null, null, 2) + '\n';

/** Compare current dumps with a pin file. Returns findings and a change list with unified diffs. */
export function diffPins(pins, dumps, opts = {}) {
  const changes = []; const findings = [];
  const cur = new Map(dumps.map((d) => [d.server, new Map(d.tools.map((t) => [String(t.name), t]))]));
  const servers = [...new Set([...Object.keys(pins.servers), ...cur.keys()])].sort();
  for (const s of servers) {
    const old = pins.servers[s] || {}; const now = cur.get(s);
    if (!now) continue; // server not in this dump: nothing to compare
    const names = [...new Set([...Object.keys(old), ...now.keys()])].sort();
    for (const n of names) {
      const o = old[n]; const t = now.get(n);
      const line = lineOf(opts.text, JSON.stringify(n), dumps.length > 1 ? s : null);
      const loc = opts.file ? { file: opts.file, line } : {};
      if (o && !t) { changes.push({ change: 'removed', server: s, tool: n }); findings.push({ id: 'NEM-TOOL-REMOVED', server: s, tool: n, title: `${s}/${n} was removed`, ...(opts.file ? { file: opts.pinsFile || opts.file, line: 1 } : {}) }); continue; }
      const b = pinBody(t); const h = sha256(canonical(b));
      if (!o) { changes.push({ change: 'added', server: s, tool: n, sha256: h }); findings.push({ id: 'NEM-TOOL-ADDED', server: s, tool: n, title: `${s}/${n} is new`, ...loc }); continue; }
      if (o.sha256 === h) continue;
      const fields = ['title', 'description', 'inputSchema', 'annotations'].filter((k) => canonical(o[k] ?? null) !== canonical(b[k] ?? null));
      if (o.description === undefined && !fields.length) fields.push('definition');
      let diff = '';
      if (fields.includes('description')) diff += unifiedDiff(String(o.description ?? '') + '\n', String(b.description ?? '') + '\n', { oldPath: `pinned/${s}/${n}/description`, newPath: `current/${s}/${n}/description` });
      if (fields.includes('inputSchema')) diff += unifiedDiff(pretty(o.inputSchema), pretty(b.inputSchema), { oldPath: `pinned/${s}/${n}/inputSchema`, newPath: `current/${s}/${n}/inputSchema` });
      if (fields.includes('annotations')) diff += unifiedDiff(pretty(o.annotations), pretty(b.annotations), { oldPath: `pinned/${s}/${n}/annotations`, newPath: `current/${s}/${n}/annotations` });
      const oldIds = new Set(textHits({ ...o, inputSchema: o.inputSchema }).map((x) => x.id));
      const newHits = textHits(t).filter((x) => !oldIds.has(x.id) && RULES[x.id].severity === 'high');
      const poisoned = newHits.length > 0;
      changes.push({ change: 'changed', server: s, tool: n, fields, old_sha256: o.sha256, sha256: h, new_risky_text: newHits.map((x) => x.id), diff });
      findings.push({ id: 'NEM-TOOL-CHANGED', severity: poisoned ? 'high' : 'medium', server: s, tool: n, title: `${s}/${n} changed (${fields.join(', ')})${poisoned ? `; new text matches ${[...new Set(newHits.map((x) => x.id))].join(', ')}` : ''}`, snippet: newHits[0]?.snippet, ...loc });
    }
  }
  const verdict = findings.some((f) => f.id === 'NEM-TOOL-CHANGED' && f.severity === 'high') ? 'rug_pull_suspected' : changes.length ? 'changed_since_pin' : 'matches_pin';
  return { verdict, changes, findings };
}
