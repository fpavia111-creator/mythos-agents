#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main } from 'mythos-agent-core';
import { manifest } from '../src/manifest.js';
import { demo } from '../src/demo.js';

main(manifest, { bin: 'agon-of-evals', demo, evalFile: fileURLToPath(new URL('../evals/cases.json', import.meta.url)) });
