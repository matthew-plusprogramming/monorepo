#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import process from 'node:process';

const USAGE = `Usage: node agents/scripts/list-files-recursively.mjs --root <path> [--pattern <pattern>]
       [--types ts|md|all] [--regex] [--case-sensitive]

Recursively scans the provided root directory, filters files whose relative paths
match the supplied pattern, and prints a CSV with path,size,modifiedAt columns.

Options
  -r, --root <path>          Root directory to start the scan (required)
  -p, --pattern <pattern>    Pattern to match against repo-relative paths (default: match all)
  -t, --types <types>        Comma-separated filter for file groups: ts, md, all (default: all)
      --regex                Treat the pattern as a JavaScript regular expression
      --case-sensitive       Match pattern using case-sensitive comparisons (default: case-insensitive)
  -h, --help                 Show this help message

Examples
  node agents/scripts/list-files-recursively.mjs --root apps --pattern services
  node agents/scripts/list-files-recursively.mjs --root packages --pattern schema --types ts
  node agents/scripts/list-files-recursively.mjs --root . --pattern \\\\.(md|ts)$ --types md,ts --regex
`;

const TYPE_GROUPS = {
  ts: ['.ts', '.tsx', '.cts', '.mts'],
  md: ['.md'],
};

const args = process.argv.slice(2);

const options = {
  root: null,
  pattern: null,
  types: 'all',
  useRegex: false,
  caseSensitive: false,
  showHelp: false,
};

const popValue = (idx, flag) => {
  if (idx + 1 >= args.length) {
    console.error(`❌ Missing value after "${flag}"`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }
  return args[idx + 1];
};

for (let index = 0; index < args.length; index += 1) {
  const token = args[index];

  switch (token) {
    case '-h':
    case '--help':
      options.showHelp = true;
      break;
    case '-r':
    case '--root':
      options.root = popValue(index, token);
      index += 1;
      break;
    case '-p':
    case '--pattern':
      options.pattern = popValue(index, token);
      index += 1;
      break;
    case '-t':
    case '--types':
      options.types = popValue(index, token);
      index += 1;
      break;
    case '--regex':
      options.useRegex = true;
      break;
    case '--case-sensitive':
      options.caseSensitive = true;
      break;
    default:
      if (token.startsWith('-')) {
        console.error(`❌ Unknown option: ${token}`);
        console.error(USAGE.trimEnd());
        process.exit(1);
      }
  }
}

if (options.showHelp) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

if (!options.root) {
  console.error('❌ --root is required.');
  console.error(USAGE.trimEnd());
  process.exit(1);
}

const toPosix = (value) => value.replace(/\\/g, '/');

const makePatternPredicate = (pattern, { useRegex, caseSensitive }) => {
  if (!pattern) {
    return () => true;
  }

  if (useRegex) {
    try {
      const flags = caseSensitive ? undefined : 'i';
      const matcher = new RegExp(pattern, flags);
      return (text) => matcher.test(text);
    } catch (error) {
      console.error(`❌ Invalid regular expression: ${error.message}`);
      process.exit(1);
    }
  }

  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (text) => {
    const haystack = caseSensitive ? text : text.toLowerCase();
    return haystack.includes(needle);
  };
};

const makeTypeFilter = (types) => {
  if (!types) {
    return null;
  }

  const tokens = types
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0 || tokens.includes('all')) {
    return null;
  }

  const allowedExtensions = new Set();
  const unknown = [];

  for (const token of tokens) {
    const group = TYPE_GROUPS[token];
    if (!group) {
      unknown.push(token);
      continue;
    }
    group.forEach((ext) => allowedExtensions.add(ext));
  }

  if (unknown.length > 0) {
    console.error(
      `❌ Unsupported type(s): ${unknown.join(
        ', ',
      )}. Allowed values: ${Object.keys(TYPE_GROUPS).join(', ')}, all`,
    );
    process.exit(1);
  }

  return (filePath) => {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.ts' && filePath.endsWith('.d.ts')) {
      return false;
    }
    return allowedExtensions.has(ext);
  };
};

const escapeCsv = (value) => {
  const stringValue = String(value ?? '');
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
};

const main = async () => {
  const rootPath = resolve(process.cwd(), options.root);

  let rootStats;
  try {
    rootStats = await fs.stat(rootPath);
  } catch (error) {
    console.error(
      `❌ Failed to access root "${options.root}": ${error.message}`,
    );
    process.exit(1);
  }

  if (!rootStats.isDirectory()) {
    console.error(`❌ Root path "${options.root}" is not a directory.`);
    process.exit(1);
  }

  const predicate = makePatternPredicate(options.pattern ?? '', {
    useRegex: options.useRegex,
    caseSensitive: options.caseSensitive,
  });
  const typeFilter = makeTypeFilter(options.types);

  const results = [];

  const walk = async (currentDir) => {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      console.error(
        `⚠️  Failed to read directory "${currentDir}": ${error.message}`,
      );
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }

      const fullPath = join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = toPosix(relative(rootPath, fullPath));

      if (typeFilter && !typeFilter(relativePath)) {
        continue;
      }

      if (!predicate(relativePath)) {
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (error) {
        console.error(`⚠️  Failed to stat "${relativePath}": ${error.message}`);
        continue;
      }

      results.push({
        path: relativePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  };

  await walk(rootPath);

  results.sort((a, b) => a.path.localeCompare(b.path));

  console.log('path,size,modifiedAt');
  for (const record of results) {
    console.log(
      `${escapeCsv(record.path)},${escapeCsv(record.size)},${escapeCsv(record.modifiedAt)}`,
    );
  }
};

main().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
