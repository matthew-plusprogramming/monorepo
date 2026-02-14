#!/usr/bin/env node

/**
 * Computes content hashes for all artifacts and optionally updates the registry.
 *
 * Usage:
 *   node compute-hashes.mjs           # Display current hashes
 *   node compute-hashes.mjs --verify  # Verify registry hashes match files
 *   node compute-hashes.mjs --update  # Update registry with new hashes
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const REGISTRY_PATH = resolve(__dirname, '../metaclaude-registry.json');

function computeHash(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function getAllArtifactPaths(registry) {
  const paths = [];

  for (const [category, artifacts] of Object.entries(registry.artifacts)) {
    for (const [name, artifact] of Object.entries(artifacts)) {
      // Skip category-level metadata (e.g., _sync_policy)
      if (name.startsWith('_') || typeof artifact !== 'object' || !artifact.path) continue;
      paths.push({
        id: `${category}/${name}`,
        path: artifact.path,
        registeredHash: artifact.hash,
        version: artifact.version,
      });
    }
  }

  return paths;
}

function main() {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  const update = args.includes('--update');

  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  const artifacts = getAllArtifactPaths(registry);

  console.error('\nMetaClaude Artifact Hashes');
  console.error('='.repeat(70));

  let mismatches = 0;
  let missing = 0;
  let matched = 0;

  for (const artifact of artifacts) {
    const fullPath = resolve(ROOT, artifact.path);
    const currentHash = computeHash(fullPath);

    if (!currentHash) {
      console.error(`  ? ${artifact.id}: FILE MISSING (${artifact.path})`);
      missing++;
      continue;
    }

    const status = currentHash === artifact.registeredHash ? '✓' : '✗';
    const color = currentHash === artifact.registeredHash ? '\x1b[32m' : '\x1b[33m';

    console.error(`${color}  ${status} ${artifact.id}: ${currentHash}${currentHash !== artifact.registeredHash ? ` (registry: ${artifact.registeredHash})` : ''}\x1b[0m`);

    if (currentHash !== artifact.registeredHash) {
      mismatches++;

      if (update) {
        // Update the registry
        const [category, name] = artifact.id.split('/');
        registry.artifacts[category][name].hash = currentHash;
      }
    } else {
      matched++;
    }
  }

  console.error('\n' + '-'.repeat(70));
  console.error(`Summary: ${matched} matched, ${mismatches} mismatched, ${missing} missing`);

  if (update && mismatches > 0) {
    registry.updated_at = new Date().toISOString();
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    console.error(`\nRegistry updated with ${mismatches} new hashes.`);
  }

  if (verify && (mismatches > 0 || missing > 0)) {
    console.error('\nVerification FAILED');
    process.exit(1);
  }

  if (verify && mismatches === 0 && missing === 0) {
    console.error('\nVerification PASSED');
  }
}

main();
