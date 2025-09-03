import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  MEMORY_OVERVIEW,
  MEMORY_DIR,
  ROOT_BASENAMES,
  PATH_PREFIXES,
  CODE_SPAN_REGEX,
} from './constants.js';

const root = process.cwd();

// Collect all Memory Bank markdown files under MEMORY_DIR/** and the overview file
const collectMemoryBankFiles = () => {
  const acc = new Set([resolve(root, MEMORY_OVERVIEW)]);
  const base = resolve(root, MEMORY_DIR);
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && name.endsWith('.md')) acc.add(p);
      } catch {
        // ignore unreadable entries
      }
    }
  };
  walk(base);
  return [...acc];
};

const filesToScan = collectMemoryBankFiles();

// ROOT_BASENAMES and PATH_PREFIXES are sourced from ./constants.js

const extractCandidates = (md) => {
  const set = new Set();
  const codeMatches = md.matchAll(CODE_SPAN_REGEX);
  for (const m of codeMatches) {
    const token = m[1].trim();
    const startsWithPrefix = PATH_PREFIXES.some((p) => token.startsWith(p));
    const isRootFile = ROOT_BASENAMES.has(token);
    if (!startsWithPrefix && !isRootFile) continue;
    set.add(token);
  }
  return [...set];
};

const checkPath = (p) => {
  // Handle simple globs by validating base directory up to first '*'
  const starIdx = p.indexOf('*');
  let toCheck = p;
  if (starIdx !== -1) {
    const slashIdx = p.lastIndexOf('/', starIdx);
    toCheck = slashIdx === -1 ? '.' : p.slice(0, slashIdx);
  }
  const abs = resolve(root, toCheck);
  return existsSync(abs);
};

let missing = [];
for (const abs of filesToScan) {
  if (!existsSync(abs)) {
    console.error(`❌ Missing reference file: ${abs.replace(root + '/', '')}`);
    missing.push(abs);
    continue;
  }
  const md = readFileSync(abs, 'utf-8');
  const candidates = extractCandidates(md);
  for (const c of candidates) {
    if (!checkPath(c)) missing.push(c);
  }
}

if (missing.length) {
  console.error('❌ Memory bank path validation failed for:');
  for (const m of missing) console.error(` - ${m}`);
  process.exit(1);
}

console.info('✅ Memory bank paths validated');
