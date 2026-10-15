#!/usr/bin/env node
/* Recovery format 1 is an encrypted SQLite snapshot plus gateway identity and
 * operator configuration. Restore is offline and only into a new directory. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, scrypt: derive, createCipheriv, createDecipheriv, createPrivateKey } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(derive);
const FORMAT = 'temperance-recovery';
const MAX = 128 * 1024 * 1024;
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function key(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 1024)
    throw new Error('Set a recovery passphrase of 16–1024 characters. Keep a copy off this server.');
  return scrypt(passphrase, salt, 32, options);
}
async function seal(payload, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(FORMAT + '/1'));
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length > MAX) throw new Error('Recovery snapshot is too large.');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({ format: FORMAT, schema: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
async function unseal(archive, passphrase) {
  if (Buffer.byteLength(archive) > MAX * 1.5) throw new Error('Recovery archive is too large.');
  const envelope = JSON.parse(archive);
  if (envelope.format !== FORMAT || envelope.schema !== 1) throw new Error('Unsupported recovery format.');
  function decode(name, length) {
    const value = envelope[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid recovery archive.');
    const data = Buffer.from(value, 'base64');
    if (length && data.length !== length) throw new Error('Invalid recovery archive.');
    return data;
  }
  const decipher = createDecipheriv('aes-256-gcm', await key(passphrase, decode('salt', 16)), decode('iv', 12));
  decipher.setAAD(Buffer.from(FORMAT + '/1'));
  decipher.setAuthTag(decode('tag', 16));
  try {
    return JSON.parse(Buffer.concat([decipher.update(decode('data')), decipher.final()]).toString('utf8'));
  } catch { throw new Error('Recovery authentication failed: wrong passphrase or damaged archive.'); }
}
const dataDir = (env) => env.TEMPERANCE_DATA_DIR || path.join(process.cwd(), 'data');
function sqlitePath(env) {
  const url = env.TEMPERANCE_DATABASE_URL;
  if (url && /^postgres/.test(url)) throw new Error('Encrypted recovery currently supports SQLite only; use pg_dump and separately back up gateway keys for PostgreSQL.');
  return url ? url.replace(/^(sqlite|file):(\/\/)?/, '') : path.join(dataDir(env), 'temperance.sqlite3');
}
function validateKeys(keys) {
  if (typeof keys['gateway.key'] !== 'string' || !/^[A-Za-z0-9+/]{43}=\s*$/.test(keys['gateway.key']) || Buffer.from(keys['gateway.key'].trim(), 'base64').every((byte) => byte === 0)) throw new Error('Invalid VPN identity.');
  if (typeof keys['parent.key'] !== 'string' || !/^[A-Za-z0-9_-]{40,1024}\s*$/.test(keys['parent.key'])) throw new Error('Invalid remote identity.');
  const identity = createPrivateKey({ key: Buffer.from(keys['parent.key'].trim(), 'base64url'), type: 'pkcs8', format: 'der' });
  if (identity.asymmetricKeyType !== 'ed25519') throw new Error('Invalid remote identity algorithm.');
}
function validateDatabase(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Damaged recovery database.');
    const row = db.prepare('SELECT body FROM temperance_state WHERE id=1').get();
    if (!row || JSON.parse(row.body).schema !== 2) throw new Error('Unsupported household schema.');
  } finally { db.close(); }
}
/** @param {Record<string, string | undefined>} env */
async function createArchive(env = process.env) {
  const { DatabaseSync } = require('node:sqlite');
  const source = sqlitePath(env);
  const directory = dataDir(env);
  const keys = {};
  const identity = async (name) => name === 'gateway.key' && env.TEMPERANCE_GATEWAY_PRIVATE_KEY ? env.TEMPERANCE_GATEWAY_PRIVATE_KEY.trim() : await fs.readFile(path.join(directory, name), 'utf8');
  for (const name of ['gateway.key', 'parent.key']) keys[name] = await identity(name);
  validateKeys(keys);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'temperance-recovery-'));
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    // VACUUM INTO produces a consistent standalone snapshot, including committed
    // WAL content, without copying an open database or its transient WAL files.
    db.exec("VACUUM INTO '" + path.join(temporary, 'snapshot.sqlite3').replace(/'/g, "''") + "'");
    db.close(); db = undefined;
    validateDatabase(path.join(temporary, 'snapshot.sqlite3'));
    const config = Object.fromEntries(Object.entries(env).filter(([name, value]) => /^TEMPERANCE_[A-Z0-9_]+$/.test(name) && typeof value === 'string' && !['TEMPERANCE_DATA_DIR', 'TEMPERANCE_DATABASE_URL', 'TEMPERANCE_BACKUP_PASSPHRASE', 'TEMPERANCE_FORWARD_SECRET', 'TEMPERANCE_BUILD_VERSION'].includes(name)));
    for (const name of Object.keys(keys)) {
      if (keys[name] !== await identity(name)) throw new Error('Gateway identity changed during backup; retry.');
    }
    return await seal({ created_at: new Date().toISOString(), version: env.TEMPERANCE_BUILD_VERSION || 'dev', database: (await fs.readFile(path.join(temporary, 'snapshot.sqlite3'))).toString('base64'), keys, config }, env.TEMPERANCE_BACKUP_PASSPHRASE);
  } finally {
    db?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
/** @param {Record<string, string | undefined>} env */
async function saveArchive(env = process.env) {
  const archive = await createArchive(env);
  const directory = path.join(dataDir(env), 'backups');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `recovery-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  const file = path.join(directory, name);
  await fs.writeFile(file, archive, { mode: 0o600, flag: 'wx' });
  // Retain the most recent seven complete archives; never remove the new one first.
  const names = (await fs.readdir(directory)).filter((n) => /^recovery-\d+-[a-f0-9]{8}\.json$/.test(n)).sort().reverse();
  for (const old of names.slice(7)) await fs.unlink(path.join(directory, old));
  return file;
}
async function restoreArchive(archive, passphrase, target) {
  const payload = await unseal(archive, passphrase);
  if (!payload || typeof payload.database !== 'string' || !payload.config || !payload.keys) throw new Error('Incomplete recovery snapshot.');
  const database = Buffer.from(payload.database, 'base64');
  if (!database.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid recovery database.');
  validateKeys(payload.keys);
  const config = Object.entries(payload.config).map(([name, value]) => {
    if (!/^TEMPERANCE_[A-Z0-9_]+$/.test(name) || typeof value !== 'string' || /\0/.test(value)) throw new Error('Invalid recovery configuration.');
    // Compose interpolates dollars even inside double quotes.
    return name + '=' + JSON.stringify(value.replace(/\$/g, '$$$$'));
  }).join('\n') + '\n';
  const destination = path.resolve(target);
  // Stage on the same filesystem; refuse to overwrite any existing target.
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), '.temperance-restore-'));
  try {
    await fs.chmod(temporary, 0o700);
    await fs.writeFile(path.join(temporary, 'temperance.sqlite3'), database, { mode: 0o600 });
    validateDatabase(path.join(temporary, 'temperance.sqlite3'));
    for (const name of ['gateway.key', 'parent.key']) await fs.writeFile(path.join(temporary, name), payload.keys[name], { mode: 0o600 });
    await fs.writeFile(path.join(temporary, 'recovery.env'), config, { mode: 0o600 });
    // mkdir is the exclusive claim: renaming over an existing empty directory is unsafe.
    await fs.mkdir(destination, { mode: 0o700 });
    try { await fs.rename(temporary, destination); }
    catch (error) { await fs.rmdir(destination); throw error; }
    return destination;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
module.exports = { seal, unseal, createArchive, saveArchive, restoreArchive };
if (require.main === module) {
  (async () => {
    const [command, input, target] = process.argv.slice(2);
    if (command === 'backup') console.log(await saveArchive());
    else if (command === 'export') process.stdout.write(await createArchive());
    else if (command === 'restore' && input && target) {
      if ((await fs.stat(input)).size > MAX * 1.5) throw new Error('Recovery archive is too large.');
      console.log(await restoreArchive(await fs.readFile(input, 'utf8'), process.env.TEMPERANCE_BACKUP_PASSPHRASE, target));
    } else throw new Error('Usage: node scripts/recovery.cjs backup | export | restore <archive> <new-directory>');
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
