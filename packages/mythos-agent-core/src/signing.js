// Ed25519 signing for audit logs and reports (node:crypto, no dependencies).
// The private key lives in a file outside --root. It is never logged and never
// written under the agent's root.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { sha256 } from './util.js';

/** Short stable id for a public key: first 16 hex chars of sha256(SPKI DER). */
export function keyId(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return sha256(der).slice(0, 16);
}

function inside(root, p) {
  if (!root) return false;
  let r = resolve(root); let a = resolve(p);
  try { r = realpathSync(r); } catch { /* root may not exist yet */ }
  try { a = realpathSync(dirname(a)) + '/' + a.split(/[\\/]/).pop(); } catch { /* parent may not exist */ }
  const rel = relative(r, a);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Generate a key pair into dir (private.pem 0600, public.pem). Refuses a dir under root. */
export function generateSigningKey(dir, { root } = {}) {
  const d = resolve(dir);
  if (root && inside(root, join(d, 'private.pem'))) throw new Error('refusing to write a signing key under --root; keep it where the agent cannot read or write');
  mkdirSync(d, { recursive: true });
  const priv = join(d, 'private.pem'); const pub = join(d, 'public.pem');
  if (existsSync(priv)) throw new Error(`${priv} already exists; rotate with a new folder`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  try { chmodSync(priv, 0o600); } catch { /* windows */ }
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { privateKeyFile: priv, publicKeyFile: pub, keyId: keyId(publicKey) };
}

/** Load a signer from a private key PEM file. Refuses a key file under root. */
export function loadSigner(file, { root } = {}) {
  const f = resolve(file);
  if (root && inside(root, f)) throw new Error('signing key must not live under --root (the agent could read it)');
  const privateKey = createPrivateKey(readFileSync(f));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const id = keyId(publicKey);
  return {
    keyId: id,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (text) => sign(null, Buffer.from(text), privateKey).toString('base64'),
    toJSON: () => ({ keyId: id }), // never serialise the private key
  };
}

/** Load one or more public keys (PEM files or PEM strings). Returns Map keyId -> KeyObject. */
export function loadPublicKeys(list) {
  const m = new Map();
  for (const item of [].concat(list || [])) {
    const pem = /BEGIN PUBLIC KEY/.test(String(item)) ? String(item) : readFileSync(resolve(item), 'utf8');
    const k = createPublicKey(pem);
    m.set(keyId(k), k);
  }
  return m;
}

export function verifySignature(publicKey, text, sigB64) {
  try { return verify(null, Buffer.from(text), publicKey, Buffer.from(String(sigB64), 'base64')); } catch { return false; }
}
