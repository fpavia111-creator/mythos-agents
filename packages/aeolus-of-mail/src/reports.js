// DMARC aggregate (rua) report parser. Reads saved XML reports (.xml, .xml.gz, .gz, .zip)
// offline and totals pass/fail by sending source. No network, no external XML library:
// the aggregate format (RFC 7489 appendix C) is small and regular, so a tag reader is enough.
import { gunzipSync } from 'node:zlib';
import { readZip } from 'mythos-agent-core';
import { orgDomain } from './mail.js';

const MAX_XML = 20 * 1024 * 1024;
const unesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').trim();
const blocks = (xml, tag) => [...String(xml).matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g'))].map((m) => m[1]);
const val = (xml, tag) => { const b = blocks(xml, tag)[0]; return b === undefined ? null : unesc(b); };

/** Turn a saved report file's bytes into XML strings (a .zip may hold several). */
export function reportXmls(name, buf) {
  const n = name.toLowerCase();
  let parts;
  if (n.endsWith('.zip')) parts = [...readZip(buf, { maxBytes: MAX_XML, only: (x) => /\.xml$/i.test(x) }).values()];
  else if (n.endsWith('.gz')) parts = [gunzipSync(buf, { maxOutputLength: MAX_XML })];
  else if (n.endsWith('.xml')) parts = [buf];
  else throw new Error(`${name}: DMARC reports must be .xml, .xml.gz, .gz or .zip`);
  return parts.map((p) => {
    const x = p.toString('utf8');
    if (x.length > MAX_XML) throw new Error(`${name}: report is larger than 20 MB`);
    if (/<!DOCTYPE|<!ENTITY/i.test(x)) throw new Error(`${name}: DOCTYPE/ENTITY declarations are refused`);
    return x;
  });
}

/** Parse one aggregate report XML string. */
export function parseAggregate(xml, label = 'report') {
  if (!/<feedback[\s>]/.test(xml)) throw new Error(`${label}: not a DMARC aggregate report (no <feedback> element)`);
  const meta = blocks(xml, 'report_metadata')[0] || '';
  const pp = blocks(xml, 'policy_published')[0] || '';
  const range = blocks(meta, 'date_range')[0] || '';
  const records = blocks(xml, 'record').map((rec) => {
    const row = blocks(rec, 'row')[0] || ''; const pe = blocks(row, 'policy_evaluated')[0] || '';
    const ids = blocks(rec, 'identifiers')[0] || ''; const auth = blocks(rec, 'auth_results')[0] || '';
    return {
      source_ip: val(row, 'source_ip'), count: Number(val(row, 'count') || 0),
      disposition: (val(pe, 'disposition') || '').toLowerCase(), dkim: (val(pe, 'dkim') || '').toLowerCase(), spf: (val(pe, 'spf') || '').toLowerCase(),
      header_from: (val(ids, 'header_from') || '').toLowerCase(), envelope_from: (val(ids, 'envelope_from') || '').toLowerCase() || null,
      dkim_auth: blocks(auth, 'dkim').map((d) => ({ domain: (val(d, 'domain') || '').toLowerCase(), selector: val(d, 'selector'), result: (val(d, 'result') || '').toLowerCase() })),
      spf_auth: blocks(auth, 'spf').map((d) => ({ domain: (val(d, 'domain') || '').toLowerCase(), result: (val(d, 'result') || '').toLowerCase() })),
    };
  });
  return {
    org: val(meta, 'org_name') || '(unknown reporter)', report_id: val(meta, 'report_id') || null,
    begin: Number(val(range, 'begin') || 0), end: Number(val(range, 'end') || 0),
    policy: { domain: (val(pp, 'domain') || '').toLowerCase(), p: val(pp, 'p'), sp: val(pp, 'sp'), pct: val(pp, 'pct') ? Number(val(pp, 'pct')) : 100, adkim: val(pp, 'adkim') || 'r', aspf: val(pp, 'aspf') || 'r' },
    records,
  };
}

const aligned = (a, b, mode) => (mode === 's' ? a === b : !!a && !!b && orgDomain(a) === orgDomain(b));
const day = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Total parsed reports by source IP. Duplicate reports (same reporter and report id) are counted once.
 * Each source gets a status and, where it fails, a reason with a fix hint.
 */
export function summarise(reports, { domain = null, threshold = 98 } = {}) {
  const seen = new Set(); const used = []; const dupes = [];
  for (const r of reports) { const k = `${r.org}|${r.report_id}`; if (r.report_id && seen.has(k)) { dupes.push(k); continue; } seen.add(k); used.push(r); }
  const want = domain ? domain.toLowerCase() : null;
  const src = new Map(); const reporters = new Map(); let total = 0; let pass = 0; let dk = 0; let sp = 0; let begin = Infinity; let end = 0;
  const policies = new Set();
  for (const r of used) {
    if (r.begin) begin = Math.min(begin, r.begin); if (r.end) end = Math.max(end, r.end);
    if (r.policy.p) policies.add(`p=${r.policy.p}${r.policy.pct < 100 ? ` pct=${r.policy.pct}` : ''}`);
    for (const x of r.records) {
      if (want && x.header_from !== want && !x.header_from.endsWith(`.${want}`)) continue;
      const ok = x.dkim === 'pass' || x.spf === 'pass';
      total += x.count; if (ok) pass += x.count; if (x.dkim === 'pass') dk += x.count; if (x.spf === 'pass') sp += x.count;
      const rep = reporters.get(r.org) || { org: r.org, reports: 0, messages: 0 }; rep.messages += x.count; reporters.set(r.org, rep);
      const s = src.get(x.source_ip) || { source_ip: x.source_ip, messages: 0, dmarc_pass: 0, dkim_aligned_pass: 0, spf_aligned_pass: 0, header_from: new Set(), envelope_from: new Set(), dkim_domains: new Set(), dispositions: {}, why: new Set() };
      src.set(x.source_ip, s);
      s.messages += x.count; if (ok) s.dmarc_pass += x.count; if (x.dkim === 'pass') s.dkim_aligned_pass += x.count; if (x.spf === 'pass') s.spf_aligned_pass += x.count;
      s.header_from.add(x.header_from); if (x.envelope_from) s.envelope_from.add(x.envelope_from);
      for (const d of x.dkim_auth) if (d.domain) s.dkim_domains.add(`${d.domain}${d.selector ? ` (s=${d.selector})` : ''}:${d.result}`);
      s.dispositions[x.disposition || 'none'] = (s.dispositions[x.disposition || 'none'] || 0) + x.count;
      if (!ok) {
        const spfPass = x.spf_auth.find((a) => a.result === 'pass');
        const dkimPass = x.dkim_auth.find((a) => a.result === 'pass');
        if (spfPass && !aligned(spfPass.domain, x.header_from, r.policy.aspf)) s.why.add(`SPF passes for ${spfPass.domain}, which does not align with ${x.header_from}: set a custom Return-Path (bounce) domain under ${x.header_from} at this service`);
        if (dkimPass && !aligned(dkimPass.domain, x.header_from, r.policy.adkim)) s.why.add(`DKIM is signed by ${dkimPass.domain}, which does not align with ${x.header_from}: set up custom DKIM for ${x.header_from} at this service`);
        if (!spfPass && !dkimPass) s.why.add('Neither SPF nor DKIM passes: if this is a real sender, add it to SPF and set up DKIM; if you do not recognise it, it may be spoofing');
      }
    }
    if (reporters.has(r.org)) reporters.get(r.org).reports++;
  }
  const sources = [...src.values()].map((s) => {
    const rate = pct(s.dmarc_pass, s.messages);
    return { source_ip: s.source_ip, messages: s.messages, dmarc_pass: s.dmarc_pass, pass_rate: rate, status: s.dmarc_pass === s.messages ? 'passing' : s.dmarc_pass === 0 ? 'failing' : 'partly_failing', dkim_aligned_pass: s.dkim_aligned_pass, spf_aligned_pass: s.spf_aligned_pass, header_from: [...s.header_from].sort(), envelope_from: [...s.envelope_from].sort(), dkim_domains: [...s.dkim_domains].sort(), dispositions: s.dispositions, why: [...s.why] };
  }).sort((a, b) => (a.status === 'passing') - (b.status === 'passing') || b.messages - a.messages || String(a.source_ip).localeCompare(String(b.source_ip)));
  const rate = pct(pass, total);
  const days = end > 0 && begin < Infinity ? Math.round((end - begin) / 86400) : 0;
  return {
    domain: want, reports: used.length, duplicate_reports_skipped: dupes.length, reporters: [...reporters.values()].sort((a, b) => b.messages - a.messages || a.org.localeCompare(b.org)),
    period: { from: day(begin < Infinity ? begin : 0), to: day(end), days }, published_policies: [...policies].sort(),
    messages: total, dmarc_pass: pass, pass_rate: rate, dkim_aligned_rate: pct(dk, total), spf_aligned_rate: pct(sp, total),
    sources, failing_sources: sources.filter((s) => s.status !== 'passing').length,
    readiness: { threshold, ready: total > 0 && rate >= threshold, reason: total === 0 ? 'No messages for this domain in the reports.' : rate >= threshold ? `${rate}% of ${total} message(s) pass DMARC (threshold ${threshold}%).` : `${rate}% of ${total} message(s) pass DMARC, under the ${threshold}% threshold: fix the failing real senders first.` },
    limits: 'Totals what receivers reported. Reports cover only receivers that send them, and Aeolus does not look up who owns an IP address.',
  };
}
