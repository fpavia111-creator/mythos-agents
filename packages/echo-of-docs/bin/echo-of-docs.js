#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main } from 'mythos-agent-core';
import { manifest } from '../src/manifest.js';
import { demo } from '../src/demo.js';
import { runCi } from '../src/ci-cli.js';

if (process.argv[2] === 'ci') runCi(manifest, process.argv.slice(3)).then((code) => { process.exitCode = code; });
else main(manifest, { bin: 'echo-of-docs', demo, evalFile: fileURLToPath(new URL('../evals/cases.json', import.meta.url)) });
