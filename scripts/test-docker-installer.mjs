#!/usr/bin/env node
// Failure-injection tests: all Docker operations are fake, and each install has
// a fresh temporary HOME. Never starts containers or reads operator settings.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'temperance-install-'));
try {
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const source = join(directory, 'source'); mkdirSync(source);
  copyFileSync('deploy/docker/install.sh', join(source, 'install.sh'));
  writeFileSync(join(source, 'compose.yml'), 'name: temperance\nservices: {}\n');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$QA_LOG"
case "$*" in
  'compose ps -q --status running temperance') printf '%s' "$QA_RUNNING" ;;
  'compose exec -T temperance node scripts/recovery.cjs backup') [ "$QA_FAILURE" != backup ] ;;
  'compose -f compose.yml.next pull --quiet') [ "$QA_FAILURE" != pull ] ;;
  'compose up -d --remove-orphans') [ "$QA_FAILURE" != up ] ;;
  'compose ps -q temperance') echo synthetic-container ;;
  'inspect --format '* ) echo healthy ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  for (const failure of ['', 'backup', 'pull', 'up']) {
    const home = join(directory, failure || 'success'); mkdirSync(home);
    const old = 'name: temperance\n# preserved operator configuration\nservices: {}\n';
    writeFileSync(join(home, 'compose.yml'), old);
    const settings = 'TEMPERANCE_UPDATER_TOKEN=synthetic-token\nTEMPERANCE_PUBLIC_URL=http://localhost\n';
    writeFileSync(join(home, '.env'), settings);
    const log = join(home, 'docker.log');
    const result = spawnSync('sh', [join(source, 'install.sh')], { encoding: 'utf8', env: {
      PATH: bin + ':' + process.env.PATH, HOME: home, TEMPERANCE_DIR: home,
      TEMPERANCE_HOSTNAME: 'synthetic.example', TEMPERANCE_HTTPS: 'none', TEMPERANCE_UPDATES: 'no',
      QA_FAILURE: failure, QA_RUNNING: 'synthetic-container', QA_LOG: log,
    }, timeout: 10_000 });
    const calls = readFileSync(log, 'utf8');
    assert.equal(result.status, failure ? 1 : 0, result.stderr);
    assert.equal(readFileSync(join(home, '.env'), 'utf8'), settings);
    assert.ok(!existsSync(join(home, 'compose.yml.next')));
    if (failure) assert.equal(readFileSync(join(home, 'compose.yml'), 'utf8'), old);
    if (failure === 'backup') assert.ok(!calls.includes('pull --quiet'));
    if (failure === 'pull' || failure === 'backup') assert.ok(!calls.includes('compose up -d'));
    if (!failure) {
      assert.equal(readFileSync(join(home, 'compose.yml.previous'), 'utf8'), old);
      assert.ok(calls.indexOf('recovery.cjs backup') < calls.indexOf('pull --quiet'));
      assert.ok(calls.indexOf('pull --quiet') < calls.indexOf('compose up -d'));
    }
    console.log('PASS: installer ' + (failure ? failure + ' failure preserves configuration' : 'backs up before replacement'));
  }
  const home = join(directory, 'fresh'); mkdirSync(home);
  const result = spawnSync('sh', [join(source, 'install.sh')], { encoding: 'utf8', env: {
    PATH: bin + ':' + process.env.PATH, HOME: home, TEMPERANCE_DIR: home,
    TEMPERANCE_HOSTNAME: 'synthetic.example', TEMPERANCE_HTTPS: 'none', TEMPERANCE_UPDATES: 'no',
    TEMPERANCE_IMAGE: 'mistertea/temperance:candidate-synthetic', TEMPERANCE_UPDATE_CHANNEL: 'beta',
    QA_FAILURE: '', QA_RUNNING: '', QA_LOG: join(home, 'docker.log'),
  }, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const settings = readFileSync(join(home, '.env'), 'utf8');
  assert.match(settings, /^TEMPERANCE_IMAGE=mistertea\/temperance:candidate-synthetic$/m);
  assert.match(settings, /^TEMPERANCE_UPDATE_CHANNEL=beta$/m);
  assert.match(settings, /^TEMPERANCE_BACKUP_PASSPHRASE=\S{30,}$/m);
  assert.match(settings, /^TEMPERANCE_DASHBOARD_ADDRESS=127\.0\.0\.1$/m);
  assert.match(settings, /^TEMPERANCE_DASHBOARD_PORT=8788$/m);
  console.log('PASS: fresh installer persists the selected image, channel and recovery passphrase');

  const bridged = join(directory, 'bridged'); mkdirSync(bridged);
  writeFileSync(join(bridged, 'compose.yml'), 'name: temperance\nservices: {}\n');
  writeFileSync(join(bridged, '.env'), 'TEMPERANCE_UPDATER_TOKEN=synthetic-token\nCOMPOSE_PROFILES=cloudflared\nTEMPERANCE_DASHBOARD_PORT=0.0.0.0:9000\n');
  const upgrade = spawnSync('sh', [join(source, 'install.sh')], { encoding: 'utf8', env: {
    PATH: bin + ':' + process.env.PATH, HOME: bridged, TEMPERANCE_DIR: bridged,
    QA_FAILURE: '', QA_RUNNING: '', QA_LOG: join(bridged, 'docker.log'),
  }, timeout: 20_000 });
  assert.equal(upgrade.status, 0, upgrade.stderr);
  const migrated = readFileSync(join(bridged, '.env'), 'utf8');
  assert.match(migrated, /^TEMPERANCE_DASHBOARD_ADDRESS=0\.0\.0\.0$/m);
  assert.match(migrated, /^TEMPERANCE_DASHBOARD_PORT=9000$/m);
  assert.doesNotMatch(migrated, /:9000/);
  assert.match(upgrade.stdout, /route the tunnel's hostname to http:\/\/localhost:9000/);
  console.log('PASS: upgrading a bridged install splits the dashboard address and flags the tunnel route');
} finally { rmSync(directory, { recursive: true, force: true }); }
