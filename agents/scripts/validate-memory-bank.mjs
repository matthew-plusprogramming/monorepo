import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import {
  MEMORY_OVERVIEW,
  MEMORY_DIR,
  WORKFLOWS_DIR,
  ROOT_BASENAMES,
  PATH_PREFIXES,
  CODE_SPAN_REGEX,
  LINK_IGNORE_SCHEMES,
  FENCED_BACKTICK_BLOCK_REGEX,
  FENCED_TILDE_BLOCK_REGEX,
  REF_DEFINITION_REGEX,
  PLAIN_AGENTS_REF_REGEX,
  SCHEME_PREFIX_REGEX,
  TRAILING_PUNCTUATION_REGEX,
  makeInlineLinkOrImageRe,
} from './constants.js';

const root = process.cwd();

// Collect all Memory Bank markdown files under MEMORY_DIR/** and the overview file
// Also include workflows under WORKFLOWS_DIR/** and the workflows overview file
const collectDocsFiles = () => {
  const acc = new Set([
    resolve(root, MEMORY_OVERVIEW),
    resolve(root, 'agents/workflows.md'),
  ]);
  const bases = [resolve(root, MEMORY_DIR), resolve(root, WORKFLOWS_DIR)];
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
  for (const b of bases) walk(b);
  return [...acc];
};
const filesToScan = collectDocsFiles();

// ROOT_BASENAMES and PATH_PREFIXES are sourced from ./constants.js

// Remove fenced code blocks to avoid false positives when scanning plain text/links
const stripFencedCodeBlocks = (md) =>
  md
    .replace(FENCED_BACKTICK_BLOCK_REGEX, '')
    .replace(FENCED_TILDE_BLOCK_REGEX, '');

// Inline code spans (keep existing behavior)
const extractCodeSpanCandidates = (md) => {
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

// Extract inline markdown links and images: ](path) and ![](path)
const extractMarkdownLinks = (md) => {
  const set = new Set();
  // Remove fenced blocks to reduce noise
  const text = stripFencedCodeBlocks(md);
  const regex = makeInlineLinkOrImageRe();
  let m;
  while ((m = regex.exec(text))) {
    let inside = (m[1] || '').trim();
    if (!inside) continue;
    // Take first token before whitespace unless enclosed in <>
    if (inside.startsWith('<') && inside.includes('>')) {
      inside = inside.slice(1, inside.indexOf('>'));
    } else {
      const sp = inside.split(/\s+/)[0];
      inside = sp;
    }
    const href = inside.trim();
    if (!href) continue;
    // Ignore in-page anchors and external schemes
    if (href.startsWith('#')) continue;
    if (href.startsWith('//')) continue; // protocol-relative
    const hasScheme = SCHEME_PREFIX_REGEX.test(href);
    if (hasScheme && LINK_IGNORE_SCHEMES.includes(href.split(':', 1)[0] + ':'))
      continue;
    set.add(href);
  }
  return [...set];
};

// Extract reference-style link definitions: [ref]: path "title"
const extractReferenceLinks = (md) => {
  const set = new Set();
  const text = stripFencedCodeBlocks(md);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(REF_DEFINITION_REGEX);
    if (!m) continue;
    let href = m[1];
    if (!href) continue;
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    href = href.trim();
    if (!href || href.startsWith('#')) continue;
    if (href.startsWith('//')) continue;
    const hasScheme = SCHEME_PREFIX_REGEX.test(href);
    if (hasScheme && LINK_IGNORE_SCHEMES.includes(href.split(':', 1)[0] + ':'))
      continue;
    set.add(href);
  }
  return [...set];
};

// Extract plain-text agents/** references anywhere in docs
const extractAgentRefs = (md) => {
  const set = new Set();
  const text = stripFencedCodeBlocks(md);
  let m;
  while ((m = PLAIN_AGENTS_REF_REGEX.exec(text))) {
    let token = m[0];
    // Trim trailing punctuation commonly adjacent to paths
    token = token.replace(TRAILING_PUNCTUATION_REGEX, '');
    set.add(token);
  }
  return [...set];
};

// Merge extracted candidates from different strategies
const extractCandidates = (md) => {
  const set = new Set([
    ...extractCodeSpanCandidates(md),
    ...extractMarkdownLinks(md),
    ...extractReferenceLinks(md),
    ...extractAgentRefs(md),
  ]);
  return [...set];
};

// Normalize a raw candidate string into a repo-root-relative path to check
const normalizeCandidate = (raw, baseDir) => {
  if (!raw) return null;
  let p = String(raw).trim();
  // Strip surrounding quotes/angle brackets
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1);

  // Ignore placeholder-like tokens containing angle brackets
  if (p.includes('<') || p.includes('>')) return null;

  // Strip query/fragment
  const cutIdx = (() => {
    const qi = p.indexOf('?');
    const hi = p.indexOf('#');
    if (qi === -1) return hi;
    if (hi === -1) return qi;
    return Math.min(qi, hi);
  })();
  if (cutIdx !== -1) p = p.slice(0, cutIdx);

  if (!p) return null;

  // Already absolute file path (rare) → make repo-relative if under root
  if (isAbsolute(p)) {
    const relAbs = relative(root, p);
    return relAbs.startsWith('..') ? null : relAbs || '.';
  }

  // In-page anchors handled earlier; external schemes are filtered on extraction
  // Repo-absolute links start with '/'
  if (p.startsWith('/')) return p.slice(1);

  // Root basenames → check at repo root
  if (!p.includes('/') && ROOT_BASENAMES.has(p)) return p;

  // For explicit repo-root prefixes (agents/, apps/, etc.) keep as-is
  if (PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) return p;

  // Relative links (./, ../, or bare like "file.md") → resolve against the current file's directory
  const base = baseDir || root;
  const abs = resolve(base, p);
  const rel = relative(root, abs);
  // Constrain to repository: ignore paths that resolve outside the repo
  if (rel.startsWith('..')) return null;
  return rel;
};

// Check existence; support * globs by validating the base directory up to first '*'
const checkPath = (repoRelOrAbs) => {
  if (!repoRelOrAbs) return false;
  let p = repoRelOrAbs;
  // Make absolute for fs
  const makeAbs = (x) => (isAbsolute(x) ? x : resolve(root, x));

  const starIdx = p.indexOf('*');
  if (starIdx !== -1) {
    const slashIdx = p.lastIndexOf('/', starIdx);
    const baseRel = slashIdx === -1 ? '.' : p.slice(0, slashIdx);
    const baseAbs = makeAbs(baseRel);
    return existsSync(baseAbs);
  }
  const abs = makeAbs(p);
  return existsSync(abs);
};

// Track missing paths once with an example source location
const missingMap = new Map(); // key: display path, value: { file, line }

for (const abs of filesToScan) {
  if (!existsSync(abs)) {
    const rel = relative(root, abs);
    if (!missingMap.has(rel))
      missingMap.set(rel, { file: '(collector)', line: 0 });
    continue;
  }
  const md = readFileSync(abs, 'utf-8');
  const dir = dirname(abs);
  const candidates = extractCandidates(md);

  // Helper to record a miss with location (first occurrence only)
  const recordMiss = (display, indexInDoc) => {
    if (missingMap.has(display)) return;
    // Compute line number from index if provided
    let line = 0;
    if (typeof indexInDoc === 'number' && indexInDoc >= 0) {
      const upto = md.slice(0, indexInDoc);
      line = upto.split(/\r?\n/).length;
    }
    missingMap.set(display, { file: relative(root, abs), line });
  };

  // 1) Code spans
  for (const m of md.matchAll(CODE_SPAN_REGEX)) {
    const token = (m[1] || '').trim();
    const startsWithPrefix = PATH_PREFIXES.some((pfx) => token.startsWith(pfx));
    const isRootFile = ROOT_BASENAMES.has(token);
    if (!startsWithPrefix && !isRootFile) continue;
    const norm = normalizeCandidate(token, dir);
    if (!norm) continue;
    if (!checkPath(norm)) recordMiss(norm, m.index ?? 0);
  }

  // 2) Inline links/images (same robust regex as extractor)
  const strippedForLinks = stripFencedCodeBlocks(md);
  const linkRe = makeInlineLinkOrImageRe();
  let lm;
  while ((lm = linkRe.exec(strippedForLinks))) {
    let inside = (lm[1] || '').trim();
    if (!inside) continue;
    if (inside.startsWith('<') && inside.includes('>'))
      inside = inside.slice(1, inside.indexOf('>'));
    else inside = inside.split(/\s+/)[0];
    const href = inside.trim();
    if (!href || href.startsWith('#') || href.startsWith('//')) continue;
    const hasScheme = SCHEME_PREFIX_REGEX.test(href);
    if (hasScheme && LINK_IGNORE_SCHEMES.includes(href.split(':', 1)[0] + ':'))
      continue;
    const norm = normalizeCandidate(href, dir);
    if (!norm) continue;
    // Note: line numbers here would be approximate due to stripping; omit index for clarity
    if (!checkPath(norm)) recordMiss(norm);
  }

  // 3) Reference-style definitions
  const lines = stripFencedCodeBlocks(md).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REF_DEFINITION_REGEX);
    if (!m) continue;
    let href = m[1];
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    href = href.trim();
    if (!href || href.startsWith('#') || href.startsWith('//')) continue;
    const hasScheme = SCHEME_PREFIX_REGEX.test(href);
    if (hasScheme && LINK_IGNORE_SCHEMES.includes(href.split(':', 1)[0] + ':'))
      continue;
    const norm = normalizeCandidate(href, dir);
    if (!norm) continue;
    if (!checkPath(norm)) recordMiss(norm, md.indexOf(lines[i]));
  }

  // 4) Plain-text agents/** references
  let am;
  const stripped = stripFencedCodeBlocks(md);
  while ((am = PLAIN_AGENTS_REF_REGEX.exec(stripped))) {
    let token = am[0].replace(TRAILING_PUNCTUATION_REGEX, '');
    const norm = normalizeCandidate(token, dir);
    if (!norm) continue;
    if (!checkPath(norm)) recordMiss(norm);
  }
}

if (missingMap.size) {
  console.error('❌ Memory/Workflow path validation failed for:');
  for (const [target, loc] of missingMap.entries()) {
    const where = loc.line ? `${loc.file}:${loc.line}` : loc.file;
    console.error(` - ${where} → ${target}`);
  }
  process.exit(1);
}

console.info('✅ Memory and workflow paths validated');
