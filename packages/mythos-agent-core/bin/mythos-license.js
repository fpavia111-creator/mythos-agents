#!/usr/bin/env node
// Licence tools for the seller. Runs on the seller's own computer only.
//   mythos-license keygen --out DIR
//   mythos-license issue --key DIR/private.pem --licensee "Name" --plan pro [--days 365 | --expires YYYY-MM-DD]
//                        [--agents a,b] [--features x,y] [--seats N] [--id ID] [--out file]
//   mythos-license verify <file> --pubkey DIR/public.pem [--agent name]
// The private key never leaves DIR. The key it prints is the customer's licence text.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags } from '../src/cli.js';
import { generateSigningKey, loadSigner } from '../src/signing.js';
import { issueLicense, checkLicense, licenseView } from '../src/license.js';

const { flags, pos } = parseFlags(process.argv.slice(2));
const out = (s) => process.stdout.write((typeof s === 'string' ? s : JSON.stringify(s, null, 2)) + '\n');
const USAGE = `Usage:
  mythos-license keygen --out DIR            Make the licence signing key pair (keep DIR off every repo and shared drive)
  mythos-license issue --key DIR/private.pem --licensee "Name" --plan pro [--days N | --expires YYYY-MM-DD]
                       [--agents a,b] [--features x,y] [--seats N] [--id ID] [--out FILE]
  mythos-license verify FILE --pubkey DIR/public.pem [--agent NAME]`;
const list = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((x) => x.trim()).filter(Boolean));
try {
  const cmd = pos[0];
  if (cmd === 'keygen') {
    if (!flags.out || flags.out === true) { out(USAGE); process.exit(2); }
    const k = generateSigningKey(String(flags.out));
    out(`Licence key pair ${k.keyId} written.\nPrivate: ${k.privateKeyFile} (never share, never commit; back it up offline)\nPublic:  ${k.publicKeyFile}\nPaste this into packages/mythos-agent-core/src/license-keys.js, inside LICENSE_PUBLIC_KEYS, as a string:\n`);
    out(readFileSync(k.publicKeyFile, 'utf8').trim());
    process.exit(0);
  }
  if (cmd === 'issue') {
    if (!flags.key || flags.key === true) { out(USAGE); process.exit(2); }
    const signer = loadSigner(String(flags.key));
    const token = issueLicense(signer, { licensee: flags.licensee === true ? '' : flags.licensee, plan: flags.plan === true ? '' : flags.plan, days: flags.days, expires: flags.expires, agents: list(flags.agents), features: list(flags.features), seats: flags.seats, id: flags.id });
    if (flags.out && flags.out !== true) {
      const f = resolve(String(flags.out)); if (existsSync(f)) throw new Error(`${f} already exists`);
      writeFileSync(f, token + '\n', { mode: 0o600 });
      out(`Licence written to ${f}. Send that file to the customer; they run "<agent> license install ${f.split(/[\\/]/).pop()}".`);
    } else out(token);
    process.exit(0);
  }
  if (cmd === 'verify') {
    if (!pos[1] || !flags.pubkey || flags.pubkey === true) { out(USAGE); process.exit(2); }
    const token = readFileSync(resolve(pos[1]), 'utf8').trim();
    const st = checkLicense(token, { keys: [readFileSync(resolve(String(flags.pubkey)), 'utf8')], agent: flags.agent && flags.agent !== true ? String(flags.agent) : null });
    out(licenseView(st)); process.exit(st.valid ? 0 : 1);
  }
  out(USAGE); process.exit(cmd ? 2 : 0);
} catch (e) { out(`Error: ${e.message}`); process.exit(1); }
