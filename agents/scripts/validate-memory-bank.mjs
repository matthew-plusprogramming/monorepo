import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = process.cwd();

const filesToScan = [
  'memory-bank.core.md',
  'memory-bank.deep.md',
];

const ROOT_BASENAMES = new Set([
  'README.md',
  'package.json',
  'package-lock.json',
  'turbo.json',
  'memory-bank.md',
  'memory-bank.core.md',
  'memory-bank.deep.md',
  'monorepo.code-workspace',
]);

const PREFIXES = ['apps/', 'packages/', 'cdk/'];

const extractCandidates = (md) => {
  const set = new Set();
  const codeMatches = md.matchAll(/`([^`]+)`/g);
  for (const m of codeMatches) {
    const token = m[1].trim();
    const startsWithPrefix = PREFIXES.some((p) => token.startsWith(p));
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
for (const rel of filesToScan) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    console.error(`❌ Missing reference file: ${rel}`);
    missing.push(rel);
    continue;
  }
  const md = readFileSync(abs, 'utf-8');
  const candidates = extractCandidates(md);
  for (const c of candidates) {
    if (!checkPath(c)) {
      missing.push(c);
    }
  }
}

if (missing.length) {
  console.error('❌ Memory bank path validation failed for:');
  for (const m of missing) console.error(` - ${m}`);
  process.exit(1);
}

console.info('✅ Memory bank paths validated');

