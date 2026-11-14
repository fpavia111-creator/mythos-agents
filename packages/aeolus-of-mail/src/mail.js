// Aeolus of Mail: read-only audit of a sending domain's mail-authentication DNS.
// Lookups go to a public DNS-over-HTTPS resolver (JSON API) or to a saved records file.
// Nothing here writes DNS.
import { createPublicKey } from 'node:crypto';

export const RESOLVERS = Object.freeze({ cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/resolve' });
const TYPE_NUM = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
export const DEFAULT_SELECTORS = Object.freeze(['default', 'google', 'selector1', 'selector2', 'k1', 'k2', 's1', 's2', 'dkim', 'mail', 'resend', 'mandrill', 'smtp']);
export const LIMITS = 'Aeolus reads public DNS only. It cannot see how a message was actually signed or which servers really send for you, so SPF and DKIM alignment, and whether DMARC passes, need a real message header or DMARC reports. DKIM selectors cannot be listed from DNS; only the selectors checked are reported. A DNS check, not a deliverability guarantee.';
const SEV_RANK = { error: 0, warning: 1, advisory: 2 };
const norm = (n) => String(n || '').trim().toLowerCase().replace(/\.$/, '');

export function txtJoin(d) {
  const s = String(d ?? '');
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(\d{3})/g, (_, n) => String.fromCharCode(Number(n))).replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : s;
}

/** Resolver over Google/Cloudflare's DNS JSON API. Returns { status, answers }. */
export function dohResolver(provider = 'cloudflare', { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const base = RESOLVERS[provider];
  if (!base) throw new Error(`unknown resolver "${provider}"; use ${Object.keys(RESOLVERS).join(' or ')}`);
  return async (name, type) => {
    const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
    let res;
    try { res = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { return { status: 'SERVFAIL', answers: [], error: e.message }; }
    if (!res.ok) return { status: 'SERVFAIL', answers: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    const status = { 0: 'NOERROR', 2: 'SERVFAIL', 3: 'NXDOMAIN' }[j.Status] || `RCODE${j.Status}`;
    const answers = (j.Answer || []).filter((a) => a.type === TYPE_NUM[type]).map((a) => (type === 'TXT' ? txtJoin(a.data) : String(a.data)));
    return { status, answers };
  };
}

/** Resolver over a saved records file: { "name": { "TXT": [..], "MX": [..], "CNAME": "target" } }. */
export function recordsResolver(map) {
  const m = {};
  for (const [k, v] of Object.entries(map || {})) if (!k.startsWith('_comment')) m[norm(k)] = v;
  const look = (name, type, depth) => {
    const e = m[norm(name)];
    if (!e) return { status: 'NXDOMAIN', answers: [] };
    if (type !== 'CNAME' && e.CNAME && depth < 8) return look([].concat(e.CNAME)[0], type, depth + 1);
    const v = e[type];
    return { status: 'NOERROR', answers: v === undefined ? [] : [].concat(v).map(String) };
  };
  return async (name, type) => look(name, type, 0);
}

function cached(resolver, max = 80) {
  const cache = new Map(); let count = 0;
  const fn = async (name, type) => {
    const key = `${norm(name)}|${type}`;
    if (cache.has(key)) return cache.get(key);
    if (++count > max) return { status: 'SERVFAIL', answers: [], error: `query cap of ${max} reached` };
    const r = await resolver(norm(name), type); cache.set(key, r); return r;
  };
  fn.count = () => count;
  return fn;
}

const MECHS = ['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists'];
const LOOKUP_MECHS = new Set(['include', 'a', 'mx', 'ptr', 'exists']);
export function parseSpf(record) {
  const terms = []; const mods = {}; const errors = [];
  const parts = String(record).trim().split(/\s+/);
  if (!/^v=spf1$/i.test(parts[0] || '')) errors.push('record does not start with v=spf1');
  for (const p of parts.slice(1)) {
    const mod = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(p);
    if (mod) { const k = mod[1].toLowerCase(); if (k in mods) errors.push(`modifier ${k} appears twice`); mods[k] = mod[2]; continue; }
    const m = /^([+\-~?]?)([a-z0-9]+)(?::([^/\s]+))?(\/\S+)?$/i.exec(p);
    if (!m || !MECHS.includes(m[2].toLowerCase())) { errors.push(`unknown term "${p}"`); continue; }
    const mech = m[2].toLowerCase();
    if ((mech === 'include' || mech === 'exists' || mech === 'ip4' || mech === 'ip6') && !m[3]) errors.push(`${mech} needs a value`);
    terms.push({ q: m[1] || '+', mech, value: m[3] || null, cidr: m[4] || null, raw: p });
  }
  return { terms, mods, errors };
}

const finding = (check, severity, record, detail, extra = {}) => ({ check, severity, record, detail, ...extra });
const spfOf = (answers) => answers.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));

async function walkSpf(q, domain, state, depth = 0, path = new Set()) {
  if (depth > 10) { state.loop = true; return; }
  const r = await q(domain, 'TXT');
  if (r.status === 'SERVFAIL') { state.failed.push(domain); return; }
  const recs = spfOf(r.answers);
  if (!recs.length) { if (depth > 0) state.missing.push(domain); return; }
  if (path.has(domain)) { state.loop = true; return; }
  const here = new Set(path).add(domain);
  const p = parseSpf(recs[0]);
  if (depth > 0 && p.errors.length) state.childErrors.push(`${domain}: ${p.errors.join('; ')}`);
  const targets = [];
  for (const t of p.terms) {
    if (!LOOKUP_MECHS.has(t.mech)) continue;
    state.lookups++;
    if (t.mech === 'ptr') state.ptr.push(domain);
    if (t.mech === 'include') targets.push(t.value);
    if (t.mech === 'a' || t.mech === 'mx') {
      const v = await q(t.value || domain, t.mech === 'a' ? 'A' : 'MX'); if (v.status === 'NXDOMAIN' || !v.answers.length) state.voids++;
    }
  }
  if (p.mods.redirect && !p.terms.some((t) => t.mech === 'all')) { state.lookups++; targets.push(p.mods.redirect); }
  for (const tgt of targets) {
    const v = await q(tgt, 'TXT');
    if (v.status === 'NXDOMAIN' || (v.status === 'NOERROR' && !spfOf(v.answers).length)) { state.voids += v.status === 'NXDOMAIN' || !v.answers.length ? 1 : 0; state.missing.push(tgt); continue; }
    await walkSpf(q, tgt, state, depth + 1, here);
  }
}

async function checkSpf(q, domain, out) {
  const r = await q(domain, 'TXT');
  const rec = `${domain} TXT`;
  if (r.status === 'SERVFAIL') { out.findings.push(finding('lookup_failed', 'warning', rec, `TXT lookup failed (${r.error || 'SERVFAIL'}); SPF could not be checked.`)); return; }
  const recs = spfOf(r.answers);
  out.records.spf = recs;
  if (!recs.length) { out.findings.push(finding('spf_missing', 'error', rec, 'No SPF record. Receivers cannot tell which servers may send for this domain. SPF is checked on the bounce (Return-Path) domain: if your mail provider uses its own bounce subdomain, audit that with return_path.', { ref: 'RFC 7208' })); return; }
  if (recs.length > 1) out.findings.push(finding('spf_multiple', 'error', rec, `${recs.length} SPF records. More than one is a permanent error, so SPF fails for every message; merge them into one.`, { ref: 'RFC 7208 §4.5' }));
  const p = parseSpf(recs[0]);
  if (p.errors.length) out.findings.push(finding('spf_syntax', 'error', rec, `SPF syntax: ${p.errors.join('; ')}.`, { ref: 'RFC 7208 §4.6' }));
  const all = p.terms.find((t) => t.mech === 'all');
  if (!all && !p.mods.redirect) out.findings.push(finding('spf_no_all', 'warning', rec, 'No "all" term, so mail from servers not listed gets a neutral result. End the record with ~all or -all.'));
  if (all && all.q === '+') out.findings.push(finding('spf_pass_all', 'error', rec, '"+all" lets every server on the internet pass SPF for this domain.'));
  if (all && all.q === '?') out.findings.push(finding('spf_neutral_all', 'warning', rec, '"?all" gives unlisted servers a neutral result; it protects nothing. Use ~all or -all.'));
  if (all && all.q === '~') out.findings.push(finding('spf_softfail_all', 'advisory', rec, '"~all" (soft fail) is common while DMARC is being rolled out. "-all" is stricter once every sender is listed.'));
  const st = { lookups: 0, voids: 0, missing: [], failed: [], ptr: [], childErrors: [], loop: false };
  await walkSpf(q, domain, st);
  out.spf_lookups = st.lookups;
  if (st.ptr.length) out.findings.push(finding('spf_ptr', 'warning', rec, `"ptr" is used (${st.ptr.join(', ')}). It is slow, unreliable and should not be used.`, { ref: 'RFC 7208 §5.5' }));
  if (st.lookups > 10) out.findings.push(finding('spf_lookup_limit', 'error', rec, `SPF needs ${st.lookups} DNS lookups (include, a, mx, ptr, exists, redirect, counted through every include). The limit is 10; past it SPF is a permanent error.`, { ref: 'RFC 7208 §4.6.4' }));
  for (const m of [...new Set(st.missing)]) out.findings.push(finding('spf_include_missing', 'error', rec, `include/redirect target ${m} has no SPF record, which is a permanent error.`, { ref: 'RFC 7208 §5.2' }));
  if (st.voids > 2) out.findings.push(finding('spf_void_lookups', 'warning', rec, `${st.voids} lookups return nothing; receivers may fail SPF after 2.`, { ref: 'RFC 7208 §4.6.4' }));
  if (st.loop) out.findings.push(finding('spf_loop', 'error', rec, 'SPF includes loop back on themselves or nest too deep.'));
  for (const e of st.childErrors) out.findings.push(finding('spf_include_syntax', 'warning', rec, `Included record has syntax problems: ${e}.`));
  for (const f of st.failed) out.findings.push(finding('lookup_failed', 'warning', `${f} TXT`, 'Lookup failed; the SPF lookup count may be incomplete.'));
}

export function parseTags(txt) {
  const tags = {}; const order = [];
  for (const part of String(txt).split(';')) { const i = part.indexOf('='); if (i < 0) { if (part.trim()) order.push(part.trim()); continue; } const k = part.slice(0, i).trim().toLowerCase(); tags[k] = part.slice(i + 1).trim(); order.push(k); }
  return { tags, order };
}
const orgDomain = (d) => d.split('.').slice(-2).join('.');

async function checkDmarc(q, domain, out) {
  const name = `_dmarc.${domain}`; const rec = `${name} TXT`;
  const r = await q(name, 'TXT');
  if (r.status === 'SERVFAIL') { out.findings.push(finding('lookup_failed', 'warning', rec, 'DMARC lookup failed.')); return; }
  let recs = r.answers.filter((t) => /^v\s*=\s*DMARC1/i.test(t.trim()));
  let inherited = null;
  if (!recs.length && domain.split('.').length > 2) {
    const org = orgDomain(domain); const o = await q(`_dmarc.${org}`, 'TXT');
    const orecs = o.answers.filter((t) => /^v\s*=\s*DMARC1/i.test(t.trim()));
    if (orecs.length) { inherited = org; recs = orecs; }
  }
  out.records.dmarc = recs;
  if (!recs.length) { out.findings.push(finding('dmarc_missing', 'error', rec, 'No DMARC record. Receivers get no policy for mail that fails SPF and DKIM, and you get no reports. Large mailbox providers expect DMARC from bulk senders.', { ref: 'RFC 7489' })); return; }
  if (recs.length > 1) out.findings.push(finding('dmarc_multiple', 'error', rec, `${recs.length} DMARC records; receivers ignore DMARC when there is more than one.`, { ref: 'RFC 7489 §6.6.3' }));
  const { tags, order } = parseTags(recs[0]);
  const where = inherited ? `_dmarc.${inherited} TXT` : rec;
  if (inherited) out.findings.push(finding('dmarc_inherited', 'advisory', rec, `No DMARC record of its own; the organisational domain's record at _dmarc.${inherited} applies${tags.sp ? ` (sp=${tags.sp})` : ''}. The organisational domain here is the last two labels; check it if you use a multi-part suffix such as .co.uk.`));
  const policy = inherited ? (tags.sp || tags.p) : tags.p;
  if (order[0] !== 'v' || !/^DMARC1$/i.test(tags.v || '')) out.findings.push(finding('dmarc_syntax', 'error', where, 'v=DMARC1 must be the first tag.'));
  if (!['none', 'quarantine', 'reject'].includes(String(tags.p || '').toLowerCase())) out.findings.push(finding('dmarc_syntax', 'error', where, `p= must be none, quarantine or reject (found "${tags.p ?? ''}").`, { ref: 'RFC 7489 §6.3' }));
  else if (String(policy).toLowerCase() === 'none') out.findings.push(finding('dmarc_monitor_only', 'warning', where, 'Policy is p=none: reports only, so spoofed mail is still delivered. Move to quarantine or reject after the reports show every real sender passes.'));
  if (tags.pct && Number(tags.pct) < 100) out.findings.push(finding('dmarc_partial_pct', 'advisory', where, `pct=${tags.pct}: the policy applies to only part of failing mail.`));
  if (tags.p && tags.sp && String(tags.sp).toLowerCase() === 'none' && String(tags.p).toLowerCase() !== 'none') out.findings.push(finding('dmarc_sp_none', 'advisory', where, 'Subdomains are set to sp=none while the domain enforces; spoofing a subdomain is not blocked.'));
  out.dmarc = { policy: policy || null, pct: tags.pct ? Number(tags.pct) : 100, rua: tags.rua || null, inherited_from: inherited };
  if (!tags.rua) out.findings.push(finding('dmarc_no_rua', 'warning', where, 'No rua= address, so no aggregate reports arrive and you cannot see who sends as you.'));
  else {
    for (const u of tags.rua.split(',')) {
      const m = /^mailto:[^@]+@([^!\s]+)/i.exec(u.trim()); if (!m) { out.findings.push(finding('dmarc_syntax', 'warning', where, `rua entry "${u.trim()}" is not a mailto: URI.`)); continue; }
      const host = norm(m[1]); const base = inherited || domain;
      if (host === base || host.endsWith(`.${base}`) || orgDomain(host) === orgDomain(base)) continue;
      const auth = await q(`${base}._report._dmarc.${host}`, 'TXT');
      if (!auth.answers.some((t) => /^v\s*=\s*DMARC1/i.test(t.trim()))) out.findings.push(finding('dmarc_external_rua_unauthorized', 'warning', where, `Reports go to ${host}, which does not publish ${base}._report._dmarc.${host}; many receivers will not send reports there.`, { ref: 'RFC 7489 §7.1' }));
    }
  }
}

export function dkimKeyBits(p) {
  try { return createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyDetails?.modulusLength ?? null; } catch { return undefined; }
}

async function checkDkim(q, domain, selectors, out) {
  out.dkim = [];
  for (const sel of selectors) {
    const name = `${sel}._domainkey.${domain}`; const r = await q(name, 'TXT');
    const recs = r.answers.filter((t) => /(^|;)\s*p\s*=/i.test(t));
    if (!recs.length) continue;
    const { tags } = parseTags(recs[0]); const rec = `${name} TXT`; const k = String(tags.k || 'rsa').toLowerCase();
    const entry = { selector: sel, key_type: k, bits: null, testing: /(^|:)y(:|$)/i.test(tags.t || ''), revoked: !tags.p };
    out.dkim.push(entry);
    if (!tags.p) { out.findings.push(finding('dkim_revoked', 'advisory', rec, `Selector "${sel}" has an empty p= (revoked). Fine if it is retired; mail still signed with it fails DKIM.`)); continue; }
    if (k === 'rsa') {
      const bits = dkimKeyBits(tags.p.replace(/\s+/g, '')); entry.bits = bits ?? null;
      if (bits === undefined) out.findings.push(finding('dkim_bad_key', 'error', rec, `Selector "${sel}": the p= value is not a readable RSA public key.`));
      else if (bits < 1024) out.findings.push(finding('dkim_weak_key', 'error', rec, `Selector "${sel}" uses a ${bits}-bit key; many receivers treat keys under 1024 bits as failing.`, { ref: 'RFC 8301' }));
      else if (bits < 2048) out.findings.push(finding('dkim_1024_key', 'advisory', rec, `Selector "${sel}" uses a ${bits}-bit key. 2048-bit is the common recommendation now.`));
    } else if (k !== 'ed25519') out.findings.push(finding('dkim_bad_key', 'error', rec, `Selector "${sel}": unknown key type k=${k}.`));
    if (entry.testing) out.findings.push(finding('dkim_testing', 'advisory', rec, `Selector "${sel}" has t=y (testing); receivers may ignore its result.`));
  }
  if (!out.dkim.some((d) => !d.revoked)) out.findings.push(finding('dkim_not_found', 'warning', `*._domainkey.${domain} TXT`, `No active DKIM key under the ${selectors.length} selector(s) checked (${selectors.join(', ')}). DKIM selectors cannot be listed from DNS: pass the selector your mail provider gave you (it is the s= tag in a sent message's DKIM-Signature header).`));
}

async function checkMx(q, domain, out) {
  const r = await q(domain, 'MX'); const rec = `${domain} MX`;
  if (r.status === 'SERVFAIL') { out.findings.push(finding('lookup_failed', 'warning', rec, 'MX lookup failed.')); return; }
  const mx = r.answers.map((a) => { const [pref, host] = a.trim().split(/\s+/); return { pref: Number(pref), host: norm(host) }; }).sort((a, b) => a.pref - b.pref);
  out.records.mx = mx.map((m) => `${m.pref} ${m.host || '.'}`);
  if (!mx.length) { out.findings.push(finding('mx_missing', 'warning', rec, 'No MX record. Replies and bounces to this domain have nowhere to go, and some receivers distrust senders with no MX. A send-only domain can publish a null MX ("0 .").', { ref: 'RFC 5321 §5.1' })); return; }
  if (mx.length === 1 && mx[0].host === '') { out.findings.push(finding('null_mx', 'advisory', rec, 'Null MX ("0 ."): the domain says it receives no mail. Right for a send-only domain; replies to it will bounce.', { ref: 'RFC 7505' })); return; }
  for (const m of mx.slice(0, 6)) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(m.host)) { out.findings.push(finding('mx_is_ip', 'error', rec, `MX ${m.host} is an IP address; MX must name a host.`)); continue; }
    const a = await q(m.host, 'A'); const aaaa = a.answers.length ? a : await q(m.host, 'AAAA');
    if (!a.answers.length && !aaaa.answers.length) out.findings.push(finding('mx_unresolved', 'error', rec, `MX host ${m.host} has no A or AAAA record; mail for that server cannot be delivered.`));
  }
}

async function checkTransport(q, domain, out) {
  const sts = await q(`_mta-sts.${domain}`, 'TXT');
  if (!sts.answers.some((t) => /^v=STSv1/i.test(t))) out.findings.push(finding('mta_sts_missing', 'advisory', `_mta-sts.${domain} TXT`, 'No MTA-STS record. Optional: it tells senders to require TLS when delivering to you (it also needs a policy file on https://mta-sts.<domain>, which Aeolus does not fetch).', { ref: 'RFC 8461' }));
  const rpt = await q(`_smtp._tls.${domain}`, 'TXT');
  if (!rpt.answers.some((t) => /^v=TLSRPTv1/i.test(t))) out.findings.push(finding('tlsrpt_missing', 'advisory', `_smtp._tls.${domain} TXT`, 'No TLS-RPT record. Optional: it asks receivers to report TLS delivery problems to you.', { ref: 'RFC 8460' }));
}

export const CHECKS = ['spf_missing', 'spf_multiple', 'spf_syntax', 'spf_no_all', 'spf_pass_all', 'spf_neutral_all', 'spf_softfail_all', 'spf_ptr', 'spf_lookup_limit', 'spf_include_missing', 'spf_include_syntax', 'spf_void_lookups', 'spf_loop', 'dmarc_missing', 'dmarc_multiple', 'dmarc_syntax', 'dmarc_inherited', 'dmarc_monitor_only', 'dmarc_partial_pct', 'dmarc_sp_none', 'dmarc_no_rua', 'dmarc_external_rua_unauthorized', 'dkim_not_found', 'dkim_revoked', 'dkim_bad_key', 'dkim_weak_key', 'dkim_1024_key', 'dkim_testing', 'mx_missing', 'null_mx', 'mx_is_ip', 'mx_unresolved', 'mta_sts_missing', 'tlsrpt_missing', 'lookup_failed'];

export function validDomain(d) {
  const n = norm(d);
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(n)) throw new Error(`not a domain name: "${d}"`);
  return n;
}

export async function audit(domainIn, resolver, { selectors, ignore = [], maxQueries = 80, return_path: rp } = {}) {
  const domain = validDomain(domainIn);
  const spfDomain = rp ? validDomain(rp) : domain;
  const sels = (selectors && selectors.length ? selectors : DEFAULT_SELECTORS).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9._-]+$/.test(s));
  const q = cached(resolver, maxQueries);
  const out = { domain, records: {}, findings: [] };
  await checkSpf(q, spfDomain, out);
  await checkDmarc(q, domain, out);
  await checkDkim(q, domain, sels, out);
  await checkMx(q, domain, out);
  const mx = out.records.mx || [];
  if (mx.length && !(mx.length === 1 && mx[0] === '0 .')) await checkTransport(q, domain, out);
  const skip = new Set(ignore);
  const findings = out.findings.filter((f) => !skip.has(f.check)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const by_severity = {}; for (const f of findings) by_severity[f.severity] = (by_severity[f.severity] || 0) + 1;
  return { domain, spf_domain: spfDomain, selectors_checked: sels, queries: q.count(), spf_lookups: out.spf_lookups ?? null, records: out.records, dmarc: out.dmarc || null, dkim: out.dkim, issues: findings.length, by_severity, findings, limits: LIMITS };
}

const MARK = /\[(TO CONFIRM|CHECK MERGE)[^\]]*\]/;
/** Pre-stage record changes. Never invents DKIM keys or an enforcing DMARC policy. */
export function draftChanges(r, { senders = [], rua = '' } = {}) {
  const changes = []; const person = [];
  const has = (c) => r.findings.some((f) => f.check === c);
  const mailbox = rua ? (rua.startsWith('mailto:') ? rua : `mailto:${rua}`) : '[TO CONFIRM report mailbox, e.g. mailto:dmarc@your-domain]';
  const spf = r.records.spf || []; const spfName = r.spf_domain || r.domain;
  if (has('spf_missing')) changes.push({ name: spfName, type: 'TXT', action: 'add', current: [], proposed: `v=spf1 ${senders.length ? senders.join(' ') : '[TO CONFIRM include: for each service that sends as you]'} ~all`, why: 'spf_missing' });
  else if (has('spf_multiple')) {
    const terms = []; let all = null;
    for (const s of spf) for (const t of parseSpf(s).terms) { if (t.mech === 'all') { all = all || t.raw; continue; } if (!terms.includes(t.raw)) terms.push(t.raw); }
    changes.push({ name: spfName, type: 'TXT', action: 'replace', current: spf, proposed: `v=spf1 ${terms.join(' ')} ${all || '~all'}`, why: 'spf_multiple', note: '[CHECK MERGE] Merged mechanically from the existing records; confirm every sender is still needed and recount lookups.' });
  } else if (has('spf_pass_all') || has('spf_neutral_all') || has('spf_no_all')) {
    const base = spf[0].replace(/\s+[+?~-]?all\b/i, '').trim();
    changes.push({ name: spfName, type: 'TXT', action: 'replace', current: spf, proposed: `${base} ~all`, why: ['spf_pass_all', 'spf_neutral_all', 'spf_no_all'].filter(has).join(', ') });
  }
  if (has('spf_lookup_limit')) person.push('SPF is over 10 lookups: remove includes for services you no longer use, or ask a provider for a narrower include. Aeolus does not flatten SPF (flattened IPs go stale).');
  if (has('spf_include_missing')) person.push('An SPF include points at a name with no SPF record: remove it or correct the hostname from the provider\'s docs.');
  if (has('spf_ptr')) person.push('Replace "ptr" with ip4/ip6 or include: terms for the real sending servers.');
  if (has('dmarc_missing')) changes.push({ name: `_dmarc.${r.domain}`, type: 'TXT', action: 'add', current: [], proposed: `v=DMARC1; p=none; rua=${mailbox}`, why: 'dmarc_missing', note: 'Starts in monitoring (p=none). Move to quarantine/reject only after reports show every real sender passes.' });
  else if (has('dmarc_no_rua') && !r.dmarc?.inherited_from) {
    const cur = r.records.dmarc[0]; changes.push({ name: `_dmarc.${r.domain}`, type: 'TXT', action: 'replace', current: [cur], proposed: `${cur.replace(/;\s*$/, '')}; rua=${mailbox}`, why: 'dmarc_no_rua' });
  }
  if (has('dmarc_monitor_only')) person.push('DMARC is p=none. Read a few weeks of aggregate reports, fix any real sender that fails, then move to p=quarantine. Aeolus never proposes enforcement on its own.');
  if (has('dmarc_external_rua_unauthorized')) person.push('Ask the report receiver to publish the _report._dmarc authorisation record (it goes in their DNS, not yours), or send reports to a mailbox on your own domain.');
  if (has('dkim_not_found') || has('dkim_weak_key') || has('dkim_bad_key')) person.push('DKIM keys come from your mail provider. Generate or rotate the key in the provider console and publish the record it gives you; Aeolus never creates keys.');
  if (has('mx_unresolved') || has('mx_is_ip')) person.push('Fix or remove the MX host that does not resolve (check with whoever runs your inbound mail).');
  if (has('tlsrpt_missing')) changes.push({ name: `_smtp._tls.${r.domain}`, type: 'TXT', action: 'add', current: [], proposed: `v=TLSRPTv1; rua=${mailbox}`, why: 'tlsrpt_missing', note: 'Optional.' });
  if (has('mta_sts_missing')) person.push('MTA-STS (optional) needs a policy file hosted at https://mta-sts.<domain>/.well-known/mta-sts.txt before the TXT record is added.');
  const open = changes.filter((c) => MARK.test(c.proposed) || MARK.test(c.note || '')).length;
  return { changes, needs_person: person, open_markers: open };
}
export const hasMarkers = (s) => MARK.test(s);

export function reportMarkdown(r) {
  const L = [`# Mail DNS audit: ${r.domain}`, '', `${r.issues} issue(s): ${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory. ${r.queries} DNS queries. SPF lookups: ${r.spf_lookups ?? 'n/a'} of 10${r.spf_domain && r.spf_domain !== r.domain ? ` (SPF checked on ${r.spf_domain})` : ''}.`, '', '## Records seen', ''];
  L.push(`- SPF: ${(r.records.spf || []).map((s) => '`' + s + '`').join(' · ') || 'none'}`);
  L.push(`- DMARC: ${(r.records.dmarc || []).map((s) => '`' + s + '`').join(' · ') || 'none'}${r.dmarc?.inherited_from ? ` (inherited from ${r.dmarc.inherited_from})` : ''}`);
  L.push(`- DKIM selectors with keys: ${r.dkim.map((d) => `${d.selector}${d.revoked ? ' (revoked)' : d.bits ? ` (${d.bits}-bit)` : ` (${d.key_type})`}`).join(', ') || 'none'} (checked: ${r.selectors_checked.join(', ')})`);
  L.push(`- MX: ${(r.records.mx || []).join(', ') || 'none'}`, '', '## Findings', '', '| Severity | Check | Record | What it means |', '|---|---|---|---|');
  for (const f of r.findings) L.push(`| ${f.severity} | ${f.check} | \`${f.record}\` | ${f.detail.replace(/\|/g, '\\|')}${f.ref ? ` (${f.ref})` : ''} |`);
  if (!r.findings.length) L.push('| | none | | |');
  L.push('', '## Limits', '', r.limits, '');
  return L.join('\n');
}
