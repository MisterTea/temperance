#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const [directory, destination] = process.argv.slice(2);
const evidence = JSON.parse(readFileSync('docs/release-evidence.json', 'utf8'));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const files = walk(directory);
const selected = [];
for (const platform of ['android', 'apple', 'windows']) {
  const manifests = files.filter((file) => basename(file) === `${platform}-candidate.json`);
  if (manifests.length !== 1) throw new Error(`Exactly one ${platform} manifest required.`);
  const manifest = JSON.parse(readFileSync(manifests[0], 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.version !== evidence.version || manifest.source_digest !== evidence.source_digest || !manifest.artifacts?.length) throw new Error(`Candidate ${platform} does not match qualified source/version.`);
  for (const item of manifest.artifacts) {
    if (basename(item.file) !== item.file || !/\.(apk|aab|ipa|zip|exe)$/.test(item.file)) throw new Error('Invalid candidate artifact name.');
    const matches = files.filter((file) => basename(file) === item.file);
    if (matches.length !== 1 || createHash('sha256').update(readFileSync(matches[0])).digest('hex') !== item.sha256) throw new Error(`Artifact checksum mismatch: ${item.file}`);
    if (selected.some((s) => s.name === item.file) || existsSync(join(destination, item.file))) throw new Error(`Duplicate release artifact: ${item.file}`);
    selected.push({ path: matches[0], name: item.file });
  }
}
// Validate every platform before copying any candidate into the release directory.
for (const item of selected) copyFileSync(item.path, join(destination, item.name));
for (const platform of ['android', 'apple', 'windows']) copyFileSync(files.find((f) => basename(f) === `${platform}-candidate.json`), join(destination, `${platform}-candidate.json`));
console.log(`Verified ${selected.length} signed candidate artifacts against qualified source.`);
