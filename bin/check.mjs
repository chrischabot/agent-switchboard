#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs', 'switchboard.mjs', 'mcp-client.mjs'];
for (const dir of ['src', 'bin']) {
  files.push(...(await readdir(dir)).filter(name => name.endsWith('.mjs')).map(name => `${dir}/${name}`));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} source files.`);
