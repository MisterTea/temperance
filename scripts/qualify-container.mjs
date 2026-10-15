#!/usr/bin/env node
// Qualifies an already-built image using fresh named volumes and no published
// ports or external network. It never loads operator .env files or data.
import { execFileSync } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/qualify-container.mjs <image> [report.json]');
const id = 'temperance-qa-' + randomUUID().slice(0, 8);
const volumes = [id + '-source', id + '-replacement'];
const container = id + '-server';
const env = {
  TEMPERANCE_ADMIN_PASSWORD: 'synthetic-container-admin-password',
  TEMPERANCE_GATEWAY_TOKEN: 'synthetic-gateway-token-32-characters',
  TEMPERANCE_BACKUP_PASSPHRASE: 'synthetic-separately-stored-recovery-passphrase',
  TEMPERANCE_DATA_DIR: '/data', TEMPERANCE_DATABASE_URL: '',
  TEMPERANCE_GATEWAY_LISTEN: '127.0.0.1:51820',
  TEMPERANCE_VPN_ENDPOINT: '198.51.100.10:51820',
  TEMPERANCE_PUBLIC_URL: 'http://127.0.0.1:3000',
  TEMPERANCE_TIMEZONE: 'UTC', TEMPERANCE_UPDATE_CHECK: 'off',
};
const environment = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const restrictions = ['--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
const checks = [];
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
function check(condition, description) {
  if (!condition) throw new Error(description);
  checks.push(description);
  console.log('PASS: ' + description);
}
const exec = (code, payload = {}) => JSON.parse(docker(['exec', '-i', container, 'node', '-e', code], JSON.stringify(payload)));
const input = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const p=JSON.parse(raw);`;
const apiCode = `(async()=>{${input}const r=await fetch('http://127.0.0.1:3000'+p.path,{method:p.method||'GET',headers:{Authorization:'Bearer '+p.token,'Content-Type':'application/json'},body:p.body===undefined?undefined:JSON.stringify(p.body),signal:AbortSignal.timeout(65000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));})().catch(()=>{process.exitCode=1})`;
function api(path, body, token = env.TEMPERANCE_ADMIN_PASSWORD) {
  return exec(apiCode, { path, body, token, method: body === undefined ? 'GET' : 'POST' });
}
function body(response) {
  if (response.status !== 200) throw new Error('Unexpected API response: ' + response.status);
  return JSON.parse(response.body);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(volume, data = '/data') {
  docker(['run', '-d', '--name', container, ...restrictions, ...environment, '-e', `TEMPERANCE_DATA_DIR=${data}`, '-v', `${volume}:/data`, image]);
  for (let i = 0; i < 90; i++) {
    try { if (api('/api/readiness').status === 200) return; } catch { /* Startup retries are bounded. */ }
    await sleep(500);
  }
  throw new Error('Container did not become ready.');
}
function stop() { docker(['rm', '-f', container]); }
function identityHashes() {
  return exec(`const fs=require('node:fs');const c=require('node:crypto');console.log(JSON.stringify(['gateway.key','parent.key'].map(n=>c.createHash('sha256').update(fs.readFileSync(process.env.TEMPERANCE_DATA_DIR+'/'+n)).digest('hex'))))`);
}
function restore(archive, target, password = env.TEMPERANCE_BACKUP_PASSPHRASE) {
  const code = `(async()=>{${input}try{await require('./scripts/recovery.cjs').restoreArchive(p.archive,p.password,p.target);console.log(JSON.stringify({restored:true}))}catch{console.log(JSON.stringify({restored:false}))}})()`;
  return JSON.parse(docker(['run', '--rm', '-i', ...restrictions, ...environment, '-v', `${volumes[1]}:/data`, '--entrypoint', 'node', image, '-e', code], JSON.stringify({ archive, target, password })));
}
try {
  for (const volume of volumes) docker(['volume', 'create', volume]);
  const seed = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/temperance.sqlite3');db.exec('CREATE TABLE temperance_state(id INTEGER PRIMARY KEY,revision BIGINT NOT NULL,body TEXT NOT NULL)');db.prepare('INSERT INTO temperance_state VALUES(1,1,?)').run(JSON.stringify({schema:2,version:1,nextProfileId:1,profiles:[],devices:[],codes:[],rewards:[],usage:{},history:[],requests:[],events:[],paused:false,extra_domains:{},retention_days:30,offline_grace_seconds:86400,network:{upnp:false}}));db.close();`;
  // Disable UPnP before first boot; other configuration is the real reference runtime.
  docker(['run', '--rm', ...restrictions, '-v', `${volumes[0]}:/data`, '--entrypoint', 'node', image, '-e', seed]);
  await start(volumes[0]);
  const settings = JSON.parse(docker(['inspect', container]))[0];
  check(!!settings.Config.User && !['root', '0'].includes(settings.Config.User.split(':')[0]), 'Server runs as a non-root user with a read-only root filesystem');
  check(settings.HostConfig.ReadonlyRootfs && settings.HostConfig.CapDrop.includes('ALL'), 'Reference container restrictions are active');
  check(api('/api/readiness', undefined, 'wrong-token').status === 401, 'Readiness rejects unauthorized access');
  const update = body(api('/api/update'));
  if (process.env.TEMPERANCE_EXPECT_VERSION) check(update.current === process.env.TEMPERANCE_EXPECT_VERSION, 'Image reports the exact candidate version');
  body(api('/api/setup/client', { profile: { name: 'containerqa', limit: 90 }, password: 'synthetic-client-password' }));
  const publicKey = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const enrolled = body(api('/v1/device/login', { username: 'containerqa', password: 'synthetic-client-password', name: 'Synthetic QA device', public_key: publicKey }));
  check(!!enrolled.token && !!enrolled.emergency_unlock, 'Device enrollment provisions scoped credentials and offline emergency access');
  check(api('/api/state', undefined, enrolled.token).status === 401, 'Device credentials cannot administer the household');
  const identities = identityHashes();
  const archive = api('/api/recovery', {});
  check(archive.status === 200 && JSON.parse(archive.body).format === 'temperance-recovery', 'Running container produces an encrypted disaster-recovery archive');
  check(!archive.body.includes(enrolled.token) && !archive.body.includes(env.TEMPERANCE_ADMIN_PASSWORD), 'Recovery archive does not contain plaintext credentials');
  const support = body(api('/api/support'));
  check(!JSON.stringify(support).includes('containerqa') && !JSON.stringify(support).includes(enrolled.token), 'Support bundle excludes household names and device credentials');
  // Recreate the process and container against the same volume, as Compose updates do.
  stop();
  await start(volumes[0]);
  check(body(api('/api/state')).profiles.length === 1 && body(api('/v1/device/state', undefined, enrolled.token)).device_id === enrolled.device_id, 'Container replacement preserves household configuration and enrolled device credentials');
  check(JSON.stringify(identityHashes()) === JSON.stringify(identities), 'Container replacement preserves both gateway identities');
  stop();
  check(!restore(archive.body, '/data/wrong-password', 'deliberately-wrong-recovery-passphrase').restored, 'Restore rejects an incorrect passphrase');
  const damaged = JSON.parse(archive.body); damaged.tag = Buffer.alloc(16).toString('base64');
  check(!restore(JSON.stringify(damaged), '/data/corrupt').restored, 'Restore rejects an altered archive');
  check(restore(archive.body, '/data/restored').restored, 'Offline restore succeeds into a clean replacement volume');
  check(!restore(archive.body, '/data/restored').restored, 'Restore refuses to overwrite an existing installation');
  await start(volumes[1], '/data/restored');
  check(JSON.stringify(identityHashes()) === JSON.stringify(identities), 'Replacement host retains VPN and remote-admin identities');
  const restored = body(api('/v1/device/state', undefined, enrolled.token));
  check(restored.device_id === enrolled.device_id && restored.policy.name === 'containerqa', 'Existing device credentials work against the restored server');
  check(body(api('/api/state')).profiles.length === 1, 'Replacement host retains the household rules');
  const report = { schema: 1, tested_at: new Date().toISOString(), image, image_id: docker(['image', 'inspect', '--format', '{{.Id}}', image]).trim(), version: update.current, checks, boundaries: ['No physical-device traffic or external UDP reachability test.', 'Container replacement uses the same candidate image; previous-version migration and rollback remain separate acceptance checks.', 'Signing and customer release gates are not satisfied by this report.'] };
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log('Container qualification passed.');
} catch (error) {
  try { process.stderr.write(docker(['logs', '--tail', '30', container])); } catch { /* Container may already have stopped. */ }
  throw error;
} finally {
  try { stop(); } catch { /* Only the uniquely named QA resources are removed. */ }
  for (const volume of volumes) { try { docker(['volume', 'rm', volume]); } catch { /* Preserve the original failure. */ } }
}
