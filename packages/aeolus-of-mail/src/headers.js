// Message header check: reads a saved message (.eml) or its headers offline and reports
// SPF/DKIM/DMARC results as the receiver recorded them, identifier alignment, the DKIM
// selectors in use, and the structure of any ARC chain (RFC 8617). It does not verify
// signatures cryptographically; it reads what the headers say.
import { orgDomain, parseTags } from './mail.js';

const SEV_RANK = { error: 0, warning: 1, advisory: 2 };
const f = (check, severity, detail, extra = {}) => ({ check, severity, detail, ...extra });

/** Unfold the header block (everything before the first blank line). */
export function parseHeaders(text) {
  const head = String(text).replace(/\r\n/g, '\n').split(/\n\n/)[0];
  const out = [];
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].value += ' ' + line.trim();
    else { const i = line.indexOf(':'); if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() }); }
  }
  return out;
}
const domainOfAddress = (v) => { const m = /<?[^<>\s@]+@([a-z0-9.-]+)>?/i.exec(String(v || '')); return m ? m[1].toLowerCase().replace(/\.$/, '') : null; };
const resultOf = (ar, method) => { const m = new RegExp(`\\b${method}=([a-z]+)`, 'i').exec(ar); return m ? m[1].toLowerCase() : null; };

export function checkHeaders(text, { trusted_authserv = null } = {}) {
  const h = parseHeaders(text);
  if (!h.length) throw new Error('no headers found; save the full message source (.eml) or paste its headers');
  const get = (n) => h.filter((x) => x.name === n);
  const findings = [];
  const fromHdr = get('from'); const from = domainOfAddress(fromHdr[0]?.value);
  if (fromHdr.length !== 1) findings.push(f('hdr_from_count', 'error', `${fromHdr.length} From headers; DMARC needs exactly one From address.`, { ref: 'RFC 7489 §6.6.1' }));
  const rp = domainOfAddress(get('return-path')[0]?.value);
  const sigs = get('dkim-signature').map((x) => { const { tags } = parseTags(x.value); return { d: (tags.d || '').toLowerCase(), s: tags.s || null, a: (tags.a || '').toLowerCase(), aligned: !!from && !!tags.d && orgDomain(tags.d.toLowerCase()) === orgDomain(from) }; });
  // The topmost Authentication-Results is the one added by the last receiver.
  let ars = get('authentication-results');
  if (trusted_authserv) ars = ars.filter((x) => x.value.toLowerCase().startsWith(trusted_authserv.toLowerCase()));
  const ar = ars[0]?.value || '';
  const results = { authserv_id: ar ? ar.split(';')[0].trim() : null, spf: resultOf(ar, 'spf'), dkim: resultOf(ar, 'dkim'), dmarc: resultOf(ar, 'dmarc'), arc: resultOf(ar, 'arc') };
  const spfAligned = !!from && !!rp && orgDomain(rp) === orgDomain(from);
  if (!ar) findings.push(f('hdr_no_auth_results', 'warning', trusted_authserv ? `No Authentication-Results header from ${trusted_authserv}.` : 'No Authentication-Results header; save the message as received (not as sent) so the receiver\'s results are included.'));
  if (results.dmarc && results.dmarc !== 'pass') findings.push(f('hdr_dmarc_fail', 'error', `The receiver recorded dmarc=${results.dmarc} for ${from || 'the From domain'}.`, { ref: 'RFC 7489' }));
  if (!sigs.length) findings.push(f('hdr_no_dkim', 'warning', 'The message has no DKIM-Signature, so DMARC can only pass through SPF, which breaks when mail is forwarded.'));
  else if (!sigs.some((s) => s.aligned)) findings.push(f('hdr_dkim_not_aligned', 'warning', `DKIM is signed by ${sigs.map((s) => s.d).join(', ')}, not by ${from}; DMARC cannot pass on DKIM. Set up custom DKIM for ${from} at the sending service.`, { ref: 'RFC 7489 §3.1.1' }));
  for (const s of sigs) if (s.a === 'rsa-sha1') findings.push(f('hdr_dkim_sha1', 'warning', `DKIM signature from ${s.d} uses rsa-sha1, which receivers treat as failing.`, { ref: 'RFC 8301' }));
  if (rp && from && !spfAligned) findings.push(f('hdr_spf_not_aligned', 'advisory', `Return-Path domain ${rp} does not align with From domain ${from}, so SPF cannot count toward DMARC; DMARC then depends on aligned DKIM.`, { ref: 'RFC 7489 §3.1.2' }));
  // ARC chain structure
  const arc = { seal: get('arc-seal'), ams: get('arc-message-signature'), aar: get('arc-authentication-results') };
  const inst = (v) => { const m = /(?:^|;)\s*i\s*=\s*(\d+)/i.exec(v); return m ? Number(m[1]) : null; };
  const sets = new Map();
  for (const [k, list] of Object.entries(arc)) for (const x of list) { const i = inst(x.value); if (i === null) { findings.push(f('arc_syntax', 'error', `An ARC-${k === 'seal' ? 'Seal' : k === 'ams' ? 'Message-Signature' : 'Authentication-Results'} header has no i= instance tag.`, { ref: 'RFC 8617 §4.2' })); continue; } const s = sets.get(i) || { i }; if (s[k]) findings.push(f('arc_duplicate', 'error', `Instance i=${i} has more than one ${k} header.`, { ref: 'RFC 8617 §4.2.1' })); s[k] = x.value; sets.set(i, s); }
  const chain = [...sets.values()].sort((a, b) => a.i - b.i).map((s) => ({ i: s.i, cv: s.seal ? (parseTags(s.seal).tags.cv || '').toLowerCase() || null : null, signer: s.seal ? (parseTags(s.seal).tags.d || '').toLowerCase() || null : null, complete: !!(s.seal && s.ams && s.aar) }));
  if (chain.length) {
    if (chain.length > 50) findings.push(f('arc_too_long', 'error', `${chain.length} ARC sets; the limit is 50.`, { ref: 'RFC 8617 §4.2.1' }));
    chain.forEach((c, n) => {
      if (c.i !== n + 1) findings.push(f('arc_instance_gap', 'error', `ARC instances must run 1, 2, 3...; found i=${c.i} at position ${n + 1}.`, { ref: 'RFC 8617 §4.2.1' }));
      if (!c.complete) findings.push(f('arc_incomplete_set', 'error', `ARC set i=${c.i} is missing one of ARC-Seal, ARC-Message-Signature or ARC-Authentication-Results.`, { ref: 'RFC 8617 §4.1' }));
      if (c.cv === 'fail') findings.push(f('arc_chain_failed', 'error', `ARC-Seal i=${c.i} (by ${c.signer || 'unknown'}) records cv=fail: an earlier hop broke the chain.`, { ref: 'RFC 8617 §5.1' }));
      else if (c.i === 1 && c.cv && c.cv !== 'none') findings.push(f('arc_cv_invalid', 'error', `ARC-Seal i=1 must have cv=none; it has cv=${c.cv}.`, { ref: 'RFC 8617 §4.1.3' }));
      else if (c.i > 1 && c.cv && c.cv !== 'pass') findings.push(f('arc_cv_invalid', 'error', `ARC-Seal i=${c.i} should have cv=pass; it has cv=${c.cv}.`, { ref: 'RFC 8617 §4.1.3' }));
    });
  }
  findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const by_severity = {}; for (const x of findings) by_severity[x.severity] = (by_severity[x.severity] || 0) + 1;
  const selectors = [...new Set(sigs.filter((s) => s.aligned && s.s).map((s) => s.s))];
  return {
    from_domain: from, return_path_domain: rp, spf_aligned: spfAligned, dkim: sigs, dkim_aligned: sigs.some((s) => s.aligned), receiver_results: results,
    arc: { sets: chain.length, chain }, selectors_in_use: selectors,
    next_step: selectors.length && from ? `Audit the DNS for ${from} with selectors ${JSON.stringify(selectors)} (aeolus_audit).` : null,
    issues: findings.length, by_severity, findings,
    limits: 'Reads the headers as saved. It does not verify DKIM or ARC signatures; the results are what the receiving server wrote. Headers can be added by anyone before the receiver, so trust only the Authentication-Results from your own receiving server (trusted_authserv).',
  };
}
