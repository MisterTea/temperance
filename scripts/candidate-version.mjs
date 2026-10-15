#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const tag = process.env.CANDIDATE_TAG || '';
const build = process.env.TEMPERANCE_BUILD_NUMBER || '';
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(tag)) throw new Error('Use an exact stable or beta version tag.');
if (!/^[1-9]\d*$/.test(build) || Number(build) <= 7 || Number(build) > 2100000000) throw new Error('Use a unique increasing store build number between 8 and 2100000000.');
const commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
console.log(`TEMPERANCE_SOURCE_COMMIT=${commit}`);
console.log(`TEMPERANCE_VERSION=${tag.slice(1)}\nTEMPERANCE_APPLE_VERSION=${tag.slice(1).split('-')[0]}`);
