// Test-only: build a throwaway self-signed EC P-256 certificate with node:crypto
// (minimal X.509 DER), so the live TLS test needs no openssl and no fixture key.
import { generateKeyPairSync, sign } from 'node:crypto';

const len = (n) => { if (n < 128) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); };
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...x) => tlv(0x30, Buffer.concat(x));
const set = (...x) => tlv(0x31, Buffer.concat(x));
const oid = (s) => { const p = s.split('.').map(Number); const out = [40 * p[0] + p[1]]; for (const v of p.slice(2)) { const st = [v & 127]; let x = v >> 7; while (x) { st.unshift((x & 127) | 128); x >>= 7; } out.push(...st); } return tlv(0x06, Buffer.from(out)); };
const utc = (d) => { const t = new Date(d); const p = (n) => String(n).padStart(2, '0'); return tlv(0x17, Buffer.from(`${p(t.getUTCFullYear() % 100)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`)); };
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/** Returns { key, cert } PEM strings. notBefore/notAfter are ISO dates. */
export function selfSigned({ cn = 'aegle-test.invalid', notBefore = '2026-01-01T00:00:00Z', notAfter = '2026-12-01T00:00:00Z' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = seq(oid('1.2.840.10045.4.3.2'));
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([0x01, 0x23])), alg, name(cn), seq(utc(notBefore), utc(notAfter)), name(cn), publicKey.export({ type: 'spki', format: 'der' }));
  const sig = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', cert) };
}
