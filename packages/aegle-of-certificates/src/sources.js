// Exports Aegle reads directly. A file already in Aegle's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const CERT_FIELDS = {
  id: { aliases: ['Certificate ID', 'Cert ID', 'Asset ID', 'Serial Number', 'Serial'] },
  type: { aliases: ['Kind', 'Asset Type', 'Certificate Type'] },
  name: { aliases: ['Common Name', 'CN', 'Domain', 'Domain Name', 'Host', 'Hostname', 'Title', 'Subject CN', 'Licence', 'License'], required: true },
  holder: { aliases: ['Subject', 'Organisation', 'Organization', 'Registrant', 'Licence Holder', 'License Holder'] },
  issuer: { aliases: ['Issuer Name', 'Issued By', 'CA', 'Certificate Authority', 'Registrar', 'Issuing Body'] },
  expires: { type: 'date', aliases: ['Expiry', 'Expiration', 'Not After', 'Valid To', 'Expires On', 'Expiry Date', 'Expiration Date', 'Valid Until', 'Renewal Date', 'Paid Till'], required: true },
  auto_renew: { type: 'bool', aliases: ['Auto Renew', 'Autorenew', 'Auto-Renew', 'Auto Renewal'] },
  renewal_cost: { type: 'money', aliases: ['Renewal Cost', 'Cost', 'Price', 'Renewal Price', 'Annual Cost'] },
  owner: { aliases: ['Contact', 'Responsible', 'Owned By', 'Team', 'Assigned To'] },
  key_type: { aliases: ['Key Type', 'Key Algorithm', 'Public Key Algorithm'] },
  key_bits: { type: 'number', aliases: ['Key Bits', 'Key Size', 'Bits', 'Key Length'] },
  signature: { aliases: ['Signature Algorithm', 'Sig Alg'] },
  registrar_lock: { type: 'bool', aliases: ['Registrar Lock', 'Transfer Lock', 'Locked', 'Domain Lock'] },
};

// AWS CLI v1 prints timestamps as epoch seconds (1795391999.0); v2 prints ISO 8601.
const epochToIso = (v) => { const s = String(v ?? '').trim(); return /^\d{9,10}(\.\d+)?$/.test(s) ? new Date(Number(s) * 1000).toISOString() : v; };
const CURVE_BITS = { prime256v1: 256, secp256r1: 256, secp384r1: 384, secp521r1: 521 };
function keyOf(alg) {
  const s = String(alg ?? '').trim();
  const rsa = /^RSA[-_ ]?(\d{3,5})$/i.exec(s); if (rsa) return ['RSA', rsa[1]];
  const ec = /^EC(?:DSA)?[-_ ]?([a-z0-9]+)$/i.exec(s); if (ec) return ['EC', String(CURVE_BITS[ec[1].toLowerCase()] ?? (/(\d{3})/.exec(ec[1]) || [])[1] ?? '')];
  return ['', ''];
}
// "C=US, O=Example Public CA, CN=Example Issuing CA 1" -> "Example Public CA (Example Issuing CA 1)"
function issuerOf(dn) {
  const s = String(dn ?? ''); const part = (k) => { const m = new RegExp(`(?:^|,\\s*)${k}=("([^"]*)"|[^,]*)`).exec(s); return m ? (m[2] ?? m[1]).trim() : ''; };
  const o = part('O'), cn = part('CN'); return o && cn && o !== cn ? `${o} (${cn})` : o || cn || s.trim();
}
const latestPerName = (rows) => {
  const best = new Map();
  for (const r of rows) { const k = String(r.name ?? '').trim().toLowerCase(); const cur = best.get(k); if (!cur || String(r.expires ?? '') > String(cur.expires ?? '')) best.set(k, r); }
  return [...best.values()];
};

export const SOURCES = {
  certificates: {
    label: 'Certificates, domains and licences', args: ['certificates', 'previous'], fields: CERT_FIELDS,
    profiles: [
      exportProfile('aws_acm', {
        id: { from: 'CertificateArn', transform: (v) => String(v).split('/').pop() },
        type: { value: 'tls' },
        name: 'DomainName',
        issuer: { from: 'Type', consume: false, compute: (_r, get) => ({ AMAZON_ISSUED: 'Amazon', PRIVATE: 'AWS Private CA' })[String(get('Type') ?? '').toUpperCase()] || '' },
        expires: { from: 'NotAfter', transform: epochToIso },
        auto_renew: { from: ['Type', 'RenewalEligibility'], consume: false, compute: (_r, get) => (/^AMAZON_ISSUED$/i.test(String(get('Type') ?? '')) && /^ELIGIBLE$/i.test(String(get('RenewalEligibility') ?? '')) ? 'yes' : 'no') },
        key_type: { from: 'KeyAlgorithm', consume: false, compute: (_r, get) => keyOf(get('KeyAlgorithm'))[0] },
        key_bits: { from: 'KeyAlgorithm', compute: (_r, get) => keyOf(get('KeyAlgorithm'))[1] },
      }, { skipRow: (_r, get) => String(get('NotAfter') ?? '').trim() === '', note: 'auto_renew is yes only for Amazon-issued certificates that ACM reports as eligible for renewal; imported certificates do not renew by themselves. Certificates with no expiry yet (pending validation or failed) are skipped. The list has no owner, issuer name for imported certificates or signature algorithm, so set an owner in mythos-sources.json and expect the weak-signature check to find nothing here.' }),
      exportProfile('crtsh', {
        id: { from: 'common_name', consume: false, compute: (_r, get) => `crtsh:${String(get('common_name') ?? '').trim().toLowerCase()}` },
        type: { value: 'tls' },
        name: 'common_name',
        issuer: { from: 'issuer_name', transform: issuerOf },
        expires: 'not_after',
      }, { rows: latestPerName, note: 'Certificate Transparency logs show what was issued for a name, not what is installed on a server. Only the certificate with the latest expiry is kept per common name. There are no owner, renewal or key details in this export.' }),
    ],
  },
  cois: {
    label: 'Certificates of insurance', fields: {
      vendor: { aliases: ['Vendor Name', 'Insured', 'Insured Name', 'Subcontractor', 'Supplier', 'Company'], required: true },
      coverage: { aliases: ['Type', 'Coverage Type', 'Policy Type', 'Line of Coverage', 'Type of Insurance'], required: true },
      limit: { type: 'money', aliases: ['Coverage Limit', 'Policy Limit', 'Each Occurrence', 'Limit Amount'] },
      expires: { type: 'date', aliases: ['Expiry', 'Expiration', 'Expiration Date', 'Policy Expiration', 'Policy Exp', 'Expiry Date', 'Policy End'] },
      additional_insured: { type: 'bool', aliases: ['Additional Insured', 'Addl Insd', 'AI'] },
      waiver_of_subrogation: { type: 'bool', aliases: ['Waiver of Subrogation', 'Subr Wvd', 'WOS', 'Waiver'] },
      certificate_id: { aliases: ['Certificate ID', 'Certificate Number', 'COI Number', 'COI ID'] },
    }, profiles: [],
  },
};
