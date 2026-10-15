#!/usr/bin/env node
// Runs a packaged server with synthetic data and loopback-only listeners. Never
// uses an operator's data directory or enables router/AP/UPnP/SMTP/feed services.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';

const entry = resolve(process.argv[2] || 'server.js');
const recovery = createRequire(import.meta.url)(join(dirname(entry), 'scripts/recovery.cjs'));
const directory = await mkdtemp(join(tmpdir(), 'temperance-acceptance-'));
const password = 'synthetic-acceptance-admin-password';
const passphrase = 'synthetic-acceptance-recovery-passphrase';
let child;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolvePort(p)); });
});
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TEMPERANCE_') && name !== 'NODE_OPTIONS')),
  NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
  TEMPERANCE_ADMIN_PASSWORD: password, TEMPERANCE_ADMIN_TOKEN: '',
  TEMPERANCE_GATEWAY_TOKEN: 'synthetic-gateway-credential-32-characters',
  TEMPERANCE_GATEWAY_LISTEN: '127.0.0.1:0', TEMPERANCE_VPN_ENDPOINT: '198.51.100.1:51820',
  TEMPERANCE_PUBLIC_URL: origin, TEMPERANCE_TIMEZONE: 'UTC',
  TEMPERANCE_BACKUP_PASSPHRASE: passphrase,
  TEMPERANCE_GATEWAY_ROUTER: '', TEMPERANCE_GATEWAY_AP: '', TEMPERANCE_GATEWAY_HOME_DNS: 'off',
  TEMPERANCE_GATEWAY_LAN_NETWORKS: '', TEMPERANCE_GATEWAY_PRIVATE_KEY: '', TEMPERANCE_VPN_PUBLIC_KEY: '',
  TEMPERANCE_FEEDS: '', TEMPERANCE_SMTP_HOST: '', TEMPERANCE_UPDATE_CHECK: 'off',
};
let output = '';
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}
async function start(data) {
  child = spawn(process.execPath, [entry], { cwd: dirname(entry), env: { ...env, TEMPERANCE_DATA_DIR: data, TEMPERANCE_DATABASE_URL: `sqlite:${join(data, 'temperance.sqlite3')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-8000); });
  child.on('error', (error) => { output += error.message; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Packaged server exited: ' + output);
    try {
      const response = await fetch(origin + '/api/readiness', { headers: { Authorization: 'Bearer ' + password }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Startup is bounded below. */ }
    await sleep(100);
  }
  throw new Error('Packaged server did not become ready: ' + output);
}
async function api(path, data) {
  const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + password, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(65000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.text();
}
try {
  const db = new DatabaseSync(join(directory, 'temperance.sqlite3'));
  // Seed UPnP off before the gateway starts, using the existing on-disk contract.
  db.exec('CREATE TABLE temperance_state(id INTEGER PRIMARY KEY, revision BIGINT NOT NULL, body TEXT NOT NULL)');
  db.prepare('INSERT INTO temperance_state VALUES(1,1,?)').run(JSON.stringify({ schema: 2, version: 1, nextProfileId: 1, profiles: [], devices: [], codes: [], rewards: [], usage: {}, history: [], requests: [], events: [], paused: false, extra_domains: {}, retention_days: 30, offline_grace_seconds: 86400, network: { upnp: false } }));
  db.close();
  await start(directory);
  await api('/api/setup/client', { profile: { name: 'acceptance', limit: 90 }, password: 'synthetic-client-password' });
  const archive = await api('/api/recovery', {});
  const replacement = join(directory, 'replacement');
  await recovery.restoreArchive(archive, passphrase, replacement);
  for (const name of ['gateway.key', 'parent.key']) {
    if (await readFile(join(directory, name), 'utf8') !== await readFile(join(replacement, name), 'utf8')) throw new Error('Recovery changed gateway identity');
  }
  await stop();
  await start(replacement);
  const state = JSON.parse(await api('/api/state'));
  if (state.profiles.length !== 1 || state.profiles[0].name !== 'acceptance') throw new Error('Recovered household configuration differs');
  const support = JSON.parse(await api('/api/support'));
  if (JSON.stringify(support).includes(password)) throw new Error('Support report exposed a credential');
  console.log('Packaged acceptance passed: readiness, atomic setup, encrypted recovery, preserved identities and replacement-server startup.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
