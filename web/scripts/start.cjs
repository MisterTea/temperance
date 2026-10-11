const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const standalone = path.join(root, '.next/standalone');
fs.cpSync(path.join(root, '.next/static'), path.join(standalone, '.next/static'), { recursive: true });
if (fs.existsSync(path.join(root, 'public'))) fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
const env = { ...process.env };
// Local builds may use a private .env.local; deploy platforms supply real secrets.
if (fs.existsSync(path.join(root, '.env.local'))) {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
}
const child = spawn(process.execPath, [path.join(standalone, 'server.js')], { cwd: root, env: { ...env, HOSTNAME: env.HOSTNAME || '127.0.0.1', PORT: env.PORT || '3000' }, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code || 0));
