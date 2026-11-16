// SARIF 2.1.0 writer for Nemesis. Deterministic (no timestamps), with full rule metadata
// (help, CWE and OWASP MCP Top 10 tags, GitHub security-severity), content-based fingerprints,
// codeFlows for data-flow findings and external suppressions with justifications.
import { sha256 } from 'mythos-agent-core';
import { RULES, SECURITY_SEVERITY, OWASP_MCP } from './catalog.js';

const LEVEL = { high: 'error', medium: 'warning', low: 'note' };
export const INFO_URI = 'https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/nemesis-of-servers';
const pascal = (id) => id.replace(/^NEM-/, '').toLowerCase().split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

function ruleDescriptor(id) {
  const r = RULES[id];
  const owasp = r.owasp.map((o) => `${o} ${OWASP_MCP[o]}`).join('; ');
  return {
    id, name: pascal(id),
    shortDescription: { text: r.title },
    fullDescription: { text: r.why },
    help: { text: `${r.why} Fix: ${r.fix} (OWASP MCP Top 10: ${owasp}.)`, markdown: `**Why:** ${r.why}\n\n**Fix:** ${r.fix}\n\n**OWASP MCP Top 10:** ${owasp}\n\n**CWE:** ${r.cwe.map((c) => `CWE-${c}`).join(', ')}` },
    helpUri: `${INFO_URI}#rules`,
    defaultConfiguration: { level: LEVEL[r.severity] },
    properties: {
      tags: ['security', 'mcp', ...r.cwe.map((c) => `external/cwe/cwe-${c}`), ...r.owasp.map((o) => `external/owasp-mcp-top-10/${o.toLowerCase()}`)],
      'security-severity': SECURITY_SEVERITY[r.severity],
      precision: id.startsWith('NEM-FLOW') || id === 'NEM-TOKEN-PASSTHROUGH' || id.startsWith('NEM-TOOL') ? 'medium' : 'low',
      'problem.severity': r.severity === 'high' ? 'error' : r.severity === 'medium' ? 'warning' : 'recommendation',
    },
  };
}

const loc = (uri, line, snippet) => ({ physicalLocation: { artifactLocation: { uri, uriBaseId: 'SRCROOT' }, region: { startLine: Math.max(1, line || 1), ...(snippet ? { snippet: { text: snippet } } : {}) } } });

function uriOf(i, prefix, configUri) {
  const f = i.file || (i.server !== undefined ? configUri : null) || 'mcp-config.json';
  return `${prefix || ''}${String(f).replace(/\\/g, '/').replace(/\.sample$/i, '')}`;
}

/**
 * result: { items, suppressed? }. opts: { uriPrefix, configUri }.
 * Every catalog rule is listed (so ruleIndex stays stable across runs).
 */
export function sarif(result, toolVersion, opts = {}) {
  const ids = Object.keys(RULES);
  const index = new Map(ids.map((id, i) => [id, i]));
  const one = (i, suppressed) => {
    const uri = uriOf(i, opts.uriPrefix, opts.configUri);
    const where = i.server !== undefined && !i.file ? ` (server ${i.server})` : i.tool ? ` (tool ${i.server ? i.server + '/' : ''}${i.tool})` : '';
    const out = {
      ruleId: i.id, ruleIndex: index.get(i.id),
      level: LEVEL[i.severity] || 'warning',
      message: { text: `${i.title}${where}. ${i.why}${i.fix ? ` Fix: ${i.fix}` : ''}` },
      locations: [loc(uri, i.line, i.snippet)],
      partialFingerprints: { 'nemesis/v1': sha256(`${i.id}|${uri}|${i.server || ''}|${i.tool || ''}|${(i.snippet || i.title).replace(/\s+/g, ' ')}`).slice(0, 32) },
      properties: { severity: i.severity, owasp_mcp: i.owasp || RULES[i.id].owasp, cwe: (i.cwe || RULES[i.id].cwe).map((c) => `CWE-${c}`), ...(i.server !== undefined ? { server: i.server } : {}), ...(i.tool ? { tool: i.tool } : {}), ...(i.advisory ? { advisory: i.advisory } : {}) },
    };
    if (i.flow && i.flow.length) {
      out.codeFlows = [{ message: { text: i.flow.map((s) => s.label).join(' -> ') }, threadFlows: [{ locations: i.flow.map((s, k) => ({ location: { ...loc(uri, s.line, s.code), message: { text: s.label } }, nestingLevel: 0, executionOrder: k + 1 })) }] }];
      out.relatedLocations = i.flow.slice(0, -1).map((s, k) => ({ id: k + 1, ...loc(uri, s.line, s.code), message: { text: s.label } }));
    }
    if (suppressed) out.suppressions = [{ kind: 'external', status: 'accepted', justification: i.suppressed }];
    return out;
  };
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'nemesis-of-servers', semanticVersion: toolVersion, version: toolVersion, informationUri: INFO_URI, rules: ids.map(ruleDescriptor) } },
      originalUriBaseIds: { SRCROOT: { description: { text: 'The folder that was scanned (see uri_prefix to make paths repository-relative).' } } },
      columnKind: 'utf16CodeUnits',
      invocations: [{ executionSuccessful: true }],
      results: [...result.items.map((i) => one(i, false)), ...(result.suppressed || []).map((i) => one(i, true))],
      properties: { verdict: result.verdict, note: 'Static, pattern-based review; not a certification or a guarantee.' },
    }],
  };
}
