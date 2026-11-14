import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parseCsv } from 'mythos-agent-core';

const SECRET = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth[_-]?key|client[_-]?secret|dsn|connection[_-]?string)/i;
const HIGH = [/\b(tls|ssl|https?_only|cors|allow[_-]?origins?|auth|mfa|2fa|sso|public|acl|firewall|ingress|cidr|0\.0\.0\.0|encrypt|kms|iam|role|permission|admin|debug|verify)/i];
const MED = [/(port|host|url|endpoint|region|replica|timeout|retention|backup|log[_-]?level|rate[_-]?limit|max|min|version|image|tag)/i];

/** Load a snapshot: JSON object, .env / .properties (KEY=value), or a schema CSV (table, column, type, nullable). */
export function loadSnapshot(file) {
  const text = readFileSync(file, 'utf8'); const ext = extname(file).toLowerCase();
  if (ext === '.json') return { kind: 'config', data: flatten(JSON.parse(text)) };
  if (ext === '.csv') {
    const rows = parseCsv(text); const k = (r, n) => r[Object.keys(r).find((x) => x.toLowerCase() === n) ?? ''] ?? '';
    if (rows.length && Object.keys(rows[0]).some((x) => x.toLowerCase() === 'column')) {
      const data = {};
      for (const r of rows) data[`${k(r, 'table')}.${k(r, 'column')}`] = { type: String(k(r, 'type')).toLowerCase(), nullable: String(k(r, 'nullable')).toLowerCase(), default: k(r, 'default') };
      return { kind: 'schema', data };
    }
  }
  const data = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_.\-]+)\s*[=:]\s*(.*?)\s*$/); if (m && !line.trim().startsWith('#')) data[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return { kind: 'config', data };
}
export function flatten(o, pre = '', out = {}) {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flatten(v, pre ? `${pre}.${k}` : k, out); if (!Object.keys(o).length && pre) out[pre] = {}; }
  else if (Array.isArray(o) && o.every((x) => x === null || typeof x !== 'object')) out[pre] = JSON.stringify(o);
  else if (Array.isArray(o)) o.forEach((v, i) => flatten(v, `${pre}[${i}]`, out));
  else out[pre] = o;
  return out;
}
const mask = (key, v) => (SECRET.test(key) && v !== undefined && v !== '' ? '••• (secret, value not shown)' : v);
const show = (v) => (v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v));
const ignored = (key, ignore) => ignore.some((p) => key === p || key.startsWith(p + '.') || (p.endsWith('*') && key.startsWith(p.slice(0, -1))));

function riskOf(key, before, after, kind) {
  if (kind === 'schema') {
    if (after === undefined) return ['high', 'Column dropped: queries, reports and integrations that use it will break; data may be lost.'];
    if (before === undefined) return ['low', 'Column added.'];
    if (before.type !== after.type) return ['high', `Type changed ${before.type} → ${after.type}: values may be truncated or casts may fail.`];
    if (before.nullable !== after.nullable) return [after.nullable === 'no' || after.nullable === 'false' ? 'high' : 'medium', `Nullability changed ${before.nullable} → ${after.nullable}.`];
    return ['low', 'Default changed.'];
  }
  if (SECRET.test(key)) return ['high', before === undefined ? 'A secret was added to the snapshot.' : after === undefined ? 'A secret was removed.' : 'A secret value changed (rotation or leak?). Confirm it was intentional.'];
  if (/debug|verbose/i.test(key) && /^(true|1|on|yes)$/i.test(String(after))) return ['high', 'Debug turned on: can expose internals and slow the service.'];
  if (/0\.0\.0\.0\/0|"\*"|^\*$/.test(String(after))) return ['high', 'Opened to everyone (0.0.0.0/0 or *).'];
  if (/(tls|ssl|verify|encrypt|mfa|https)/i.test(key) && /^(false|0|off|no|disabled)$/i.test(String(after))) return ['high', 'A security control was switched off.'];
  if (HIGH.some((r) => r.test(key))) return ['high', 'Security-relevant setting changed.'];
  if (after === undefined) return ['medium', 'Setting removed: the default will apply.'];
  if (MED.some((r) => r.test(key))) return ['medium', 'Operational setting changed.'];
  return ['low', before === undefined ? 'Setting added.' : 'Setting changed.'];
}

/** Compare two snapshots and explain every change, highest risk first. Secret values are never shown. */
export function diff(a, b, opts = {}) {
  const ignore = opts.ignore || [];
  if (a.kind !== b.kind) throw new Error(`cannot compare a ${a.kind} snapshot with a ${b.kind} snapshot`);
  const keys = [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])].filter((k) => !ignored(k, ignore)).sort();
  const changes = [];
  for (const k of keys) {
    const x = a.data[k], y = b.data[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const [risk, why] = riskOf(k, x, y, a.kind);
    changes.push({ key: k, change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: a.kind === 'schema' ? x : mask(k, x), after: a.kind === 'schema' ? y : mask(k, y), risk, why });
  }
  const order = { high: 0, medium: 1, low: 2 };
  changes.sort((p, q) => order[p.risk] - order[q.risk] || p.key.localeCompare(q.key));
  const by = { high: 0, medium: 0, low: 0 }; for (const c of changes) by[c.risk]++;
  return { kind: a.kind, compared_keys: keys.length, changes: changes.length, by_risk: by, items: changes, ignored: ignore };
}

/** Snapshots in a folder, sorted by file name (name them by date, e.g. 2026-11-01.json). */
export function timeline(dir, opts = {}) {
  const files = readdirSync(dir).filter((f) => ['.json', '.env', '.properties', '.csv', '.conf', '.ini'].includes(extname(f).toLowerCase()) || f.endsWith('.env')).filter((f) => statSync(join(dir, f)).isFile()).sort();
  if (files.length < 2) throw new Error('need at least two snapshots in the folder');
  const steps = []; const first = new Map();
  for (let i = 1; i < files.length; i++) {
    const d = diff(loadSnapshot(join(dir, files[i - 1])), loadSnapshot(join(dir, files[i])), opts);
    steps.push({ from: files[i - 1], to: files[i], changes: d.changes, by_risk: d.by_risk, items: d.items });
    for (const c of d.items) if (!first.has(c.key)) first.set(c.key, { key: c.key, first_changed_in: files[i], risk: c.risk });
  }
  const baseline = loadSnapshot(join(dir, files[0])); const latest = loadSnapshot(join(dir, files[files.length - 1]));
  const net = diff(baseline, latest, opts);
  return { snapshots: files, baseline: files[0], latest: files[files.length - 1], steps, net_drift: net, first_seen: [...first.values()] };
}

/** A revert plan back to the baseline, as a proposal. Secrets are left as placeholders. */
export function revertPlan(d, label = basename('baseline')) {
  return d.items.map((c) => ({ key: c.key, action: c.change === 'added' ? 'remove' : 'set', to: c.change === 'added' ? null : (typeof c.before === 'string' && c.before.startsWith('•••') ? '<restore from your secret store>' : c.before), risk: c.risk, why: c.why, source: label }));
}
export function reportMarkdown(d, title, at) {
  const L = [`# ${title}`, '', `Generated ${at} by tiresias-of-drift.`, '', `- ${d.changes} change(s): high ${d.by_risk.high}, medium ${d.by_risk.medium}, low ${d.by_risk.low}${d.ignored?.length ? ` · ignored: ${d.ignored.join(', ')}` : ''}`, '', '| Risk | Key | Change | Before | After | Why it matters |', '|---|---|---|---|---|---|'];
  const cell = (v) => show(v).replace(/\|/g, '\\|').slice(0, 80);
  for (const c of d.items) L.push(`| ${c.risk} | \`${c.key}\` | ${c.change} | ${cell(c.before)} | ${cell(c.after)} | ${c.why} |`);
  L.push('', 'Risk levels come from key names and values, not from knowledge of your system. Secret values are never shown. Applying any fix is a separate, approved step.', '');
  return L.join('\n');
}
