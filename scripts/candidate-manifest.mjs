#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint } from './check-release.mjs';
const [platform, ...files] = process.argv.slice(2);
if (!['android', 'apple', 'windows'].includes(platform) || !files.length) throw new Error('Candidate platform and artifact paths required.');
const manifest = {
  schema: 1, platform, version: process.env.CANDIDATE_TAG,
  build_number: process.env.TEMPERANCE_BUILD_NUMBER,
  source_commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  source_digest: fingerprint(process.cwd()),
  artifacts: files.map((file) => ({ file: basename(file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })),
};
writeFileSync(`${platform}-candidate.json`, JSON.stringify(manifest, null, 2) + '\n');
