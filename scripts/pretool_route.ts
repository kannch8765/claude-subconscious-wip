#!/usr/bin/env npx tsx
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { getMode } from './conversation_utils.js';

const raw = await new Promise<string>((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
if (getMode() !== 'full') process.exit(0);
const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(here, '..', 'hooks', 'silent-npx.cjs');
const child = spawnSync(process.execPath, [wrapper, 'tsx', path.join(here, 'pretool_sync.ts')], { input: raw, env: process.env, encoding: 'utf8' });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 0);
