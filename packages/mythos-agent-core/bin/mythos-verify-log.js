#!/usr/bin/env node
import { readAudit, verifyChain } from '../src/audit.js';
const file = process.argv[2];
if (!file) { process.stdout.write('Usage: mythos-verify-log <audit.jsonl>\n'); process.exit(2); }
const r = verifyChain(readAudit(file));
process.stdout.write(JSON.stringify(r, null, 2) + '\n');
process.exit(r.ok ? 0 : 1);
