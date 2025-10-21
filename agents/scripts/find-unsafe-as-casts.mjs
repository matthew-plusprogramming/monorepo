import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();

const DEFAULT_UNSAFE_TYPES = ['any', 'never'];

const args = process.argv.slice(2);

const options = {
  unsafeTypes: new Set(DEFAULT_UNSAFE_TYPES),
  includeDouble: true,
  includeAll: false,
  failOnMatch: false,
};

const printHelp = () => {
  console.log(`Usage: node agents/scripts/find-unsafe-as-casts.mjs [options]

Options
  --unsafe-types=types   Comma-separated list of lower-case type names treated as unsafe (default: any,never)
  --no-double            Disable detection of chained assertions (e.g., "as unknown as Target")
  --include-all          Report every "as" assertion (not just unsafe/double heuristics)
  --fail-on-match        Exit with code 1 if any unsafe assertions are found
  -h, --help             Show this message
`);
};

for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
  if (arg.startsWith('--unsafe-types=')) {
    const list = arg
      .slice('--unsafe-types='.length)
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (list.length) {
      options.unsafeTypes = new Set(list);
    } else {
      console.warn('⚠️ No types provided to --unsafe-types. Using defaults.');
    }
    continue;
  }
  if (arg === '--no-double') {
    options.includeDouble = false;
    continue;
  }
  if (arg === '--include-all') {
    options.includeAll = true;
    continue;
  }
  if (arg === '--fail-on-match') {
    options.failOnMatch = true;
    continue;
  }
  console.error(`Unknown option: ${arg}`);
  printHelp();
  process.exit(1);
}

const normalizeType = (text) => {
  let trimmed = text.trim();
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const normalizeForCompare = (text) =>
  normalizeType(text).replace(/\s+/g, ' ').toLowerCase();

const determineScriptKind = (file) => {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.mts')) return ts.ScriptKind.MTS;
  if (file.endsWith('.cts')) return ts.ScriptKind.CTS;
  return ts.ScriptKind.TS;
};

const isTrackedTsFile = (file) => {
  if (!/\.(cts|mts|tsx|ts)$/.test(file)) return false;
  return !file.endsWith('.d.ts');
};

const collectTrackedFiles = () => {
  try {
    const output = execSync('git ls-files', { cwd: root });
    return output
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    console.error(
      '❌ Failed to run "git ls-files". Ensure the script runs inside the repository.',
    );
    console.error(error.message);
    process.exit(1);
  }
};

const collectLeadingComments = (lines, index) => {
  const block = [];
  let i = index - 1;
  let inBlock = false;
  let sawComment = false;

  while (i >= 0) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      if (!sawComment) {
        i -= 1;
        continue;
      }
      break;
    }

    if (trimmed.startsWith('//')) {
      block.unshift(raw);
      sawComment = true;
      i -= 1;
      continue;
    }

    if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) {
      block.unshift(raw);
      sawComment = true;
      i -= 1;
      continue;
    }

    if (trimmed.endsWith('*/')) {
      inBlock = true;
      block.unshift(raw);
      sawComment = true;
      i -= 1;
      continue;
    }

    if (inBlock) {
      block.unshift(raw);
      if (trimmed.startsWith('/*')) {
        inBlock = false;
      }
      i -= 1;
      continue;
    }

    if (trimmed.startsWith('/*')) {
      block.unshift(raw);
      sawComment = true;
      break;
    }

    break;
  }

  return block;
};

const trackedFiles = collectTrackedFiles().filter(isTrackedTsFile);

const unwrapExpression = (expression) => {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
};

if (!trackedFiles.length) {
  console.log('✅ No tracked TypeScript files found to scan.');
  process.exit(0);
}

const results = [];

for (const relativePath of trackedFiles) {
  const absolutePath = resolve(root, relativePath);
  let sourceText = '';
  try {
    sourceText = readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    console.warn(`⚠️ Unable to read ${relativePath}: ${error.message}`);
    continue;
  }

  const lines = sourceText.split(/\r?\n/);
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    determineScriptKind(relativePath),
  );

  const skip = new Set();

  const visit = (node) => {
    if (skip.has(node)) return;

    if (ts.isAsExpression(node)) {
      const typeTextRaw = node.type.getText(sourceFile);
      const typeDisplay = normalizeType(typeTextRaw);
      const typeCompare = normalizeForCompare(typeTextRaw);

      let reason = null;
      let innerTypeDisplay = null;

      if (options.unsafeTypes.has(typeCompare)) {
        reason = `cast to "${typeDisplay.replace(/\s+/g, ' ')}"`;
      } else if (options.includeDouble) {
        const innerCandidate = unwrapExpression(node.expression);
        if (ts.isAsExpression(innerCandidate)) {
          const innerTypeRaw = innerCandidate.type.getText(sourceFile);
          const innerCompare = normalizeForCompare(innerTypeRaw);
          const innerDisplay = normalizeType(innerTypeRaw).replace(/\s+/g, ' ');
          const innerIsUnsafe =
            innerCompare === 'unknown' || options.unsafeTypes.has(innerCompare);
          if (innerIsUnsafe) {
            reason = `double assertion via "${innerDisplay}" → "${typeDisplay.replace(/\s+/g, ' ')}"`;
            innerTypeDisplay = innerDisplay;
            skip.add(innerCandidate);
          }
        }
      }

      if (reason || options.includeAll) {
        if (!reason) {
          reason = `cast to "${typeDisplay.replace(/\s+/g, ' ')}"`;
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.type.getStart(sourceFile),
        );
        const commentBlock = collectLeadingComments(lines, line);
        const codeLine = lines[line] ?? '';
        results.push({
          file: relativePath,
          line: line + 1,
          reason,
          commentBlock,
          codeLine,
          innerTypeDisplay,
          typeDisplay: typeDisplay.replace(/\s+/g, ' '),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

if (!results.length) {
  console.log('✅ No unsafe assertions found.');
  process.exit(0);
}

results.sort((a, b) => {
  const fileCompare = a.file.localeCompare(b.file);
  if (fileCompare !== 0) return fileCompare;
  return a.line - b.line;
});

for (const entry of results) {
  console.log(`${entry.file}:${entry.line} — ${entry.reason}`);
  if (entry.commentBlock.length) {
    for (const commentLine of entry.commentBlock) {
      console.log(`    ${commentLine.replace(/\s+$/, '')}`);
    }
  }
  console.log(`    ${entry.codeLine.replace(/\s+$/, '')}`);
  console.log('');
}

if (options.failOnMatch) {
  process.exit(1);
}

process.exit(0);
