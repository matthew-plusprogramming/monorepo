#!/usr/bin/env node

/**
 * Detects post-approval content drift in spec files.
 *
 * When a spec has status: approved and an approval_hash in frontmatter,
 * computes the current content hash and warns if it doesn't match.
 * When a spec is first approved without a hash, suggests storing one.
 *
 * Does NOT auto-modify files — only reports.
 *
 * Usage:
 *   node spec-approval-hash.mjs <spec-file.md>
 *
 * Exit codes:
 *   0 - Always (warning only)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { fields: null, bodyStart: 0 };

  const fields = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) fields[key] = value;
  }

  const bodyStart = match[0].length;
  return { fields, bodyStart };
}

function computeBodyHash(content, bodyStart) {
  const body = content.slice(bodyStart).trim();
  return createHash('sha256').update(body).digest('hex').substring(0, 12);
}

function validateFile(filePath) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const { fields, bodyStart } = parseFrontmatter(content);
  if (!fields) return;

  // Only check approved specs
  if (fields.status !== 'approved') return;

  const currentHash = computeBodyHash(content, bodyStart);
  const storedHash = fields.approval_hash;

  if (!storedHash) {
    console.error(`Info: ${filePath}`);
    console.error(`  Spec is approved but has no approval_hash in frontmatter.`);
    console.error(`  Consider adding: approval_hash: ${currentHash}`);
    return;
  }

  if (storedHash !== currentHash) {
    console.error(`Warning: ${filePath}`);
    console.error(`  Spec content has drifted from approved version.`);
    console.error(`  Stored approval_hash: ${storedHash}`);
    console.error(`  Current content hash: ${currentHash}`);
    console.error(`  Consider re-approving or updating the approval_hash.`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: spec-approval-hash.mjs <spec-file.md> [spec-file2.md ...]');
    process.exit(0);
  }

  for (const filePath of args) {
    validateFile(filePath);
  }

  // Always exit 0 — warning only
  process.exit(0);
}

main();
