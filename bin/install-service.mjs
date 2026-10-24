#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin') throw new Error('This installer manages the local macOS LaunchAgent.');
const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = process.env.SWITCHBOARD_CONFIG ?? path.join(os.homedir(), '.local/state/agent-switchboard/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const label = 'ai.chabot.agent-switchboard';
const directory = path.join(os.homedir(), 'Library/LaunchAgents');
const filename = path.join(directory, `${label}.plist`);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
await mkdir(directory, { recursive: true }); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await writeFile(filename, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(root, 'bin/hub.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>SWITCHBOARD_CONFIG</key><string>${escape(configPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escape(path.join(config.stateDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(config.stateDir, 'service.log'))}</string>
</dict></plist>\n`, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
let installed = false;
try { execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }); installed = true; } catch {}
if (installed) throw new Error(`LaunchAgent already installed. Its definition is updated; restart explicitly with launchctl kickstart -k ${domain}/${label} after checking active operations.`);
execFileSync('launchctl', ['bootstrap', domain, filename], { stdio: 'inherit' });
process.stdout.write(`Installed ${label}; config ${configPath}; endpoint http://127.0.0.1:${config.port}/mcp\n`);
