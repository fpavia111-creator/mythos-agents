// Opt-in MX existence check. Off by default: it runs only from nausicaa_check_mx, which
// needs a human yes (or an Auto opt-in), is blocked in review mode, and sends nothing
// unless allow_network is true. Only domain names go to the resolver, never addresses.
// The DNS-over-HTTPS client follows aeolus-of-mail's resolver (same JSON API, same allowlist).

export const RESOLVERS = Object.freeze({ cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/resolve' });
const TYPE_NUM = { A: 1, MX: 15, AAAA: 28 };
const norm = (n) => String(n || '').trim().toLowerCase().replace(/\.$/, '');
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let transport = null;
/** Tests inject a fake fetch here; pass null to restore globalThis.fetch. */
export function setTransport(fn) { transport = fn; }

/** Resolver over an allowlisted public DoH JSON API. Returns { status, answers }. */
export function dohResolver(provider = 'cloudflare', { timeoutMs = 6000 } = {}) {
  const base = RESOLVERS[provider];
  if (!base) throw new Error(`unknown resolver "${provider}"; use ${Object.keys(RESOLVERS).join(' or ')}`);
  return async (name, type) => {
    if (!DOMAIN.test(name)) return { status: 'INVALID', answers: [] };
    const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
    const f = transport || globalThis.fetch;
    let res;
    try { res = await f(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { return { status: 'SERVFAIL', answers: [], error: String(e && e.message || e).slice(0, 120) }; }
    if (!res.ok) return { status: 'SERVFAIL', answers: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    const status = { 0: 'NOERROR', 2: 'SERVFAIL', 3: 'NXDOMAIN' }[j.Status] || `RCODE${j.Status}`;
    return { status, answers: (j.Answer || []).filter((a) => a.type === TYPE_NUM[type]).map((a) => String(a.data)) };
  };
}

/** Offline resolver over a saved records file: { "example.com": { "MX": ["10 mx.example.com."], "A": [...] } }. */
export function recordsResolver(map) {
  const m = {}; for (const [k, v] of Object.entries(map || {})) if (!k.startsWith('_')) m[norm(k)] = v;
  return async (name, type) => { const e = m[norm(name)]; if (!e) return { status: 'NXDOMAIN', answers: [] }; return { status: 'NOERROR', answers: [].concat(e[type] ?? []).map(String) }; };
}

/**
 * For each domain: has_mx · no_mx_implicit_a (no MX but an A/AAAA record, which RFC 5321
 * lets senders use) · no_mail_host · domain_not_found · lookup_failed · invalid_domain.
 */
export async function checkDomains(domains, resolver, { maxDomains = 50 } = {}) {
  const list = [...new Set(domains.map(norm).filter(Boolean))].sort();
  const checked = list.slice(0, maxDomains); const results = [];
  for (const d of checked) {
    if (!DOMAIN.test(d)) { results.push({ domain: d, status: 'invalid_domain', mx: [] }); continue; }
    const mx = await resolver(d, 'MX');
    if (mx.status === 'NXDOMAIN') { results.push({ domain: d, status: 'domain_not_found', mx: [] }); continue; }
    if (mx.status !== 'NOERROR') { results.push({ domain: d, status: 'lookup_failed', mx: [], error: mx.error || mx.status }); continue; }
    const hosts = mx.answers.map((a) => a.split(/\s+/).pop().replace(/\.$/, '')).filter((h) => h && h !== '');
    if (mx.answers.length === 1 && /^0\s+\.?$/.test(mx.answers[0].trim())) { results.push({ domain: d, status: 'no_mail_host', mx: [], note: 'null MX (RFC 7505): the domain accepts no mail' }); continue; }
    if (hosts.length) { results.push({ domain: d, status: 'has_mx', mx: hosts }); continue; }
    const a = await resolver(d, 'A'); const aaaa = a.answers.length ? a : await resolver(d, 'AAAA');
    results.push({ domain: d, status: aaaa.answers.length ? 'no_mx_implicit_a' : 'no_mail_host', mx: [] });
  }
  return { domains: list.length, checked: checked.length, skipped: list.slice(maxDomains), results };
}
