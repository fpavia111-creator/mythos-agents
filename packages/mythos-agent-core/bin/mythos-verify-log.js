#!/usr/bin/env node
import { readAudit, verifyChain } from '../src/audit.js';
import { loadPublicKeys } from '../src/signing.js';
import { parseFlags } from '../src/cli.js';
const { flags, pos } = parseFlags(process.argv.slice(2));
if (!pos[0]) { process.stdout.write('Usage: mythos-verify-log <audit.jsonl> [--pubkey public.pem[,old.pem]]\n'); process.exit(2); }
const r = verifyChain(readAudit(pos[0]), { publicKeys: flags.pubkey ? loadPublicKeys(String(flags.pubkey).split(',')) : null });
process.stdout.write(JSON.stringify(r, null, 2) + '\n');
process.exit(r.ok ? 0 : 1);
