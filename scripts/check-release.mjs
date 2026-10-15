#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const betaChecks = ['automated_acceptance', 'fresh_install', 'android_device', 'ios_device', 'macos_device', 'windows_device', 'signed_distribution', 'enforcement_matrix', 'filter_corpus', 'accessibility', 'security_review', 'upgrade_restore'];
export const stableChecks = [...betaChecks, 'beta_households', 'ipv6_compatibility', 'capacity_soak', 'stable_households', 'production_distribution'];
export function validateEvidence(evidence, stage, version, digest) {
  if (!['beta', 'stable'].includes(stage)) throw new Error('Stage must be beta or stable.');
  const errors = [];
  if (evidence.schema !== 1) errors.push('Unsupported evidence schema.');
  if (evidence.version !== version) errors.push('Evidence does not match the release version.');
  if (evidence.source_digest !== digest) errors.push('Evidence does not match this source tree.');
  if (!/^[1-9]\d*$/.test(String(evidence.checks?.signed_distribution?.run_id || ''))) errors.push('signed_distribution: candidate workflow run_id required.');
  for (const id of stage === 'beta' ? betaChecks : stableChecks) {
    const item = evidence.checks?.[id];
    if (item?.status !== 'passed' || typeof item.owner !== 'string' || !item.owner.trim() || typeof item.evidence !== 'string' || !item.evidence.trim() || !/^\d{4}-\d{2}-\d{2}T/.test(item.verified_at || '') || !Number.isFinite(Date.parse(item.verified_at))) errors.push(`${id}: passing evidence, owner and verification timestamp required.`);
  }
  return errors;
}
export function fingerprint(root) {
  // Git tree objects normalize checkout line endings across Windows/macOS/Linux.
  // Source must be committed before qualification; only the evidence commit may follow.
  const files = execFileSync('git', ['ls-tree', '-rz', 'HEAD'], { cwd: root }).toString().split('\0').filter((entry) => entry && entry.split('\t')[1] !== 'docs/release-evidence.json').sort();
  const hash = createHash('sha256');
  for (const entry of files) hash.update(entry + '\0');
  return hash.digest('hex');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [stage, version = process.env.GITHUB_REF_NAME] = process.argv.slice(2);
  if (stage === '--fingerprint') console.log(fingerprint(root));
  else {
    const evidence = JSON.parse(readFileSync(resolve(root, 'docs/release-evidence.json'), 'utf8'));
    const errors = validateEvidence(evidence, stage, version, fingerprint(root));
    if (errors.length) { console.error('Release blocked:\n' + errors.map((e) => '- ' + e).join('\n')); process.exitCode = 1; }
    else console.log(`${version}: ${stage} evidence accepted.`);
  }
}
