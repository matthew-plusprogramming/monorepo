#!/usr/bin/env node

/**
 * Suggests promotion of frequently-tagged journal entries to memory-bank.
 *
 * Scans .claude/journal/entries/ for markdown files, parses frontmatter
 * tags/type fields, and suggests promotion when a tag appears 3+ times.
 *
 * Runs as a Stop hook at session end. Informational only.
 *
 * Usage:
 *   node journal-promotion-check.mjs
 *
 * Exit codes:
 *   0 - Always (informational only)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMOTION_THRESHOLD = 3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findClaudeDir() {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) return join(dir, '.claude');
    if (dir.endsWith('.claude')) return dir;
    dir = dirname(dir);
  }
  return null;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      // Handle YAML arrays: [tag1, tag2]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      }
      fields[key] = value;
    }
  }
  return fields;
}

function main() {
  const claudeDir = findClaudeDir();
  if (!claudeDir) {
    process.exit(0);
  }

  const entriesDir = join(claudeDir, 'journal', 'entries');
  if (!existsSync(entriesDir)) {
    process.exit(0);
  }

  let files;
  try {
    files = readdirSync(entriesDir).filter(f => f.endsWith('.md'));
  } catch {
    process.exit(0);
  }

  if (files.length === 0) {
    process.exit(0);
  }

  const tagCounts = {};
  const typeCounts = {};

  for (const file of files) {
    try {
      const content = readFileSync(join(entriesDir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      // Count tags
      if (fm.tags) {
        const tags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }

      // Count types
      if (fm.type) {
        typeCounts[fm.type] = (typeCounts[fm.type] || 0) + 1;
      }
    } catch {
      // Skip unreadable files
    }
  }

  const candidates = [];

  for (const [tag, count] of Object.entries(tagCounts)) {
    if (count >= PROMOTION_THRESHOLD) {
      candidates.push({ kind: 'tag', name: tag, count });
    }
  }

  for (const [type, count] of Object.entries(typeCounts)) {
    if (count >= PROMOTION_THRESHOLD) {
      candidates.push({ kind: 'type', name: type, count });
    }
  }

  if (candidates.length > 0) {
    console.error('Journal Promotion Candidates:');
    for (const c of candidates) {
      console.error(`  ${c.kind} "${c.name}" found in ${c.count} journal entries. Consider promoting to memory-bank.`);
    }
    console.error(`  Promotion path: journal entry → memory-bank file (after validation) → CLAUDE.md (after 3+ confirmed uses)`);
  }

  process.exit(0);
}

main();
