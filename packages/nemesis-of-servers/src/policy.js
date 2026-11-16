// Reviewer policy: suppressions with reasons, severity overrides, egress allowlist, ignored paths.
// Suppressed findings are never dropped silently: they are listed (and written to SARIF with a
// justification) so a reviewer can see what was accepted and why.

export const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    egress_allowlist: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9.*-]+$' }, description: 'Hosts reviewed and allowed for outbound calls (NEM-OPEN-EGRESS / NEM-PLAIN-HTTP lines that only name these hosts are suppressed)' },
    ignore_paths: { type: 'array', items: { type: 'string' }, description: 'Glob patterns (relative to the server folder) not to scan, e.g. "test/**"' },
    severity_overrides: { type: 'object', additionalProperties: { type: 'string', enum: ['high', 'medium', 'low'] }, description: 'Rule id -> severity' },
    suppress: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['rule', 'reason'],
        properties: {
          rule: { type: 'string', pattern: '^NEM-[A-Z0-9-]+$' },
          path: { type: 'string', description: 'Glob of files this applies to' },
          server: { type: 'string', description: 'Config server name or tool-dump server this applies to' },
          tool: { type: 'string', description: 'Tool name this applies to' },
          reason: { type: 'string', minLength: 3 },
          reviewer: { type: 'string' },
        },
      },
    },
    advisories: { type: 'string', description: 'Path (under --root) to an extra advisory list (nemesis-advisories schema)' },
    fail_on: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
  },
};

export function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const hostOk = (host, list) => list.some((h) => (h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h));

/** Split findings into kept and suppressed, applying severity overrides. */
export function applyPolicy(items, policy) {
  if (!policy) return { items, suppressed: [] };
  const kept = [], suppressed = [];
  const allow = policy.egress_allowlist || [];
  for (const f0 of items) {
    const f = policy.severity_overrides?.[f0.id] ? { ...f0, severity: policy.severity_overrides[f0.id], severity_overridden_from: f0.severity } : f0;
    let reason = null;
    for (const s of policy.suppress || []) {
      if (s.rule !== f.id) continue;
      if (s.path && !(f.file && (globToRe(s.path).test(f.file) || globToRe(s.path).test(f.file.replace(/\.sample$/i, ''))))) continue;
      if (s.server && s.server !== f.server) continue;
      if (s.tool && s.tool !== f.tool) continue;
      reason = `${s.reason}${s.reviewer ? ` (${s.reviewer})` : ''}`; break;
    }
    if (!reason && allow.length && ['NEM-OPEN-EGRESS', 'NEM-PLAIN-HTTP'].includes(f.id) && f.snippet) {
      const hosts = [...f.snippet.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1].toLowerCase());
      if (hosts.length && hosts.every((h) => hostOk(h, allow))) reason = `host on the policy egress_allowlist (${[...new Set(hosts)].join(', ')})`;
    }
    if (reason) suppressed.push({ ...f, suppressed: reason }); else kept.push(f);
  }
  return { items: kept, suppressed };
}

export function ignored(policy, rel) {
  return (policy?.ignore_paths || []).some((g) => globToRe(g).test(rel) || globToRe(g).test(rel.replace(/\.sample$/i, '')));
}
