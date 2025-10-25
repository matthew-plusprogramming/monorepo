#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import process from 'node:process';
import { listGitTrackedFiles, root as repoRoot } from './utils.mjs';

const { default: picomatch } = await import('picomatch');

const USAGE = `Usage: node agents/scripts/smart-file-query.mjs --regex "<pattern>" [options]

Searches repo files for a JavaScript regular expression, returning matches with
context and optional full file contents as minified JSON.

Options
  --regex <pattern>           Regex pattern (required, without surrounding / /)
  --flags <value>             Optional regex flags (i, m, u, etc.)
  --glob <pattern>            Comma-separated include globs (default: **/*)
  --ignore <pattern>          Comma-separated ignore globs (default: .git/**,node_modules/**,.turbo/**)
  --contextLines <number>     Number of lines before/after each match (0-20, default: 2)
  --includeAllContent         Include full content for files with matches (subject to size limits)
  --maxFileSizeKB <number>    Skip files larger than this size in KB (default: 256)
  --maxMatches <number>       Maximum total matches to return (default: 500)
  --encoding <value>          File encoding (default: utf8)
  --json                      Emit JSON payload (default: numbered text summary)
  --text                      Force numbered text summary output (default)
  -h, --help                  Show this help message
`;

const FLAG_ORDER = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];
const DEFAULT_INCLUDE_GLOBS = ['**/*'];
const DEFAULT_IGNORE_GLOBS = ['.git/**', 'node_modules/**', '.turbo/**'];
const MAX_CONTEXT_LINES = 20;

const args = process.argv.slice(2);

const parseList = (value) =>
  value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const parseArgs = () => {
  const options = {
    regex: null,
    flags: '',
    includeGlobs: [],
    ignoreGlobs: [],
    contextLines: 2,
    includeAllContent: false,
    maxFileSizeKB: 256,
    maxMatches: 500,
    encoding: 'utf8',
    showHelp: false,
    outputMode: 'text',
  };

  const consumeValue = (index, flag) => {
    if (index + 1 >= args.length) {
      console.error(`❌ Missing value after "${flag}"`);
      console.error(USAGE.trimEnd());
      process.exit(1);
    }
    return args[index + 1];
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    const [rawFlag, inlineValue] = token.startsWith('--')
      ? token.split('=')
      : [token, undefined];

    switch (rawFlag) {
      case '-h':
      case '--help':
        options.showHelp = true;
        break;
      case '--regex': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.regex = value;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--flags': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.flags = value;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--glob': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.includeGlobs.push(...parseList(value));
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--ignore': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.ignoreGlobs.push(...parseList(value));
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--contextLines': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.contextLines = Number.parseInt(value, 10);
        if (Number.isNaN(options.contextLines)) {
          console.error('❌ --contextLines must be an integer.');
          process.exit(1);
        }
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--includeAllContent':
        options.includeAllContent = true;
        break;
      case '--maxFileSizeKB': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.maxFileSizeKB = Number.parseInt(value, 10);
        if (Number.isNaN(options.maxFileSizeKB)) {
          console.error('❌ --maxFileSizeKB must be an integer.');
          process.exit(1);
        }
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--maxMatches': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.maxMatches = Number.parseInt(value, 10);
        if (Number.isNaN(options.maxMatches)) {
          console.error('❌ --maxMatches must be an integer.');
          process.exit(1);
        }
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--encoding': {
        const value = inlineValue ?? consumeValue(index, rawFlag);
        options.encoding = value;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--json':
        options.outputMode = 'json';
        break;
      case '--text':
        options.outputMode = 'text';
        break;
      default:
        if (token.startsWith('-')) {
          console.error(`❌ Unknown option: ${token}`);
          console.error(USAGE.trimEnd());
          process.exit(1);
        } else {
          console.error(`❌ Unexpected argument: ${token}`);
          console.error(USAGE.trimEnd());
          process.exit(1);
        }
    }
  }

  if (options.showHelp) {
    console.log(USAGE.trimEnd());
    process.exit(0);
  }

  if (!options.regex) {
    console.error('❌ --regex <pattern> is required.');
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  if (options.contextLines < 0 || options.contextLines > MAX_CONTEXT_LINES) {
    console.error(`❌ --contextLines must be between 0 and ${MAX_CONTEXT_LINES}.`);
    process.exit(1);
  }

  if (options.maxFileSizeKB <= 0) {
    console.error('❌ --maxFileSizeKB must be greater than 0.');
    process.exit(1);
  }

  if (options.maxMatches <= 0) {
    console.error('❌ --maxMatches must be greater than 0.');
    process.exit(1);
  }

  if (!Buffer.isEncoding(options.encoding)) {
    console.error(`❌ Unsupported encoding: ${options.encoding}`);
    process.exit(1);
  }

  if (options.includeGlobs.length === 0) {
    options.includeGlobs = [...DEFAULT_INCLUDE_GLOBS];
  }

  if (options.ignoreGlobs.length === 0) {
    options.ignoreGlobs = [...DEFAULT_IGNORE_GLOBS];
  }

  return options;
};

const normalizeFlags = (rawFlags) => {
  const invalid = [];
  const seen = new Set();

  for (const char of rawFlags) {
    if (!FLAG_ORDER.includes(char)) {
      invalid.push(char);
      continue;
    }
    seen.add(char);
  }

  if (invalid.length > 0) {
    console.error(
      `❌ Unsupported regex flag(s): ${invalid.join(
        ', ',
      )}. Allowed flags: ${FLAG_ORDER.join(', ')}`,
    );
    process.exit(1);
  }

  seen.add('g');

  return FLAG_ORDER.filter((char) => seen.has(char)).join('');
};

const toPosix = (value) => value.replace(/\\/g, '/');

const buildMatcher = (patterns, { matchAll = false } = {}) => {
  if (!patterns || patterns.length === 0) {
    return matchAll ? () => true : () => false;
  }

  const compiled = patterns.map((pattern) =>
    picomatch(pattern, { dot: true, posixSlashes: true }),
  );

  return (candidate) => compiled.some((matcher) => matcher(candidate));
};

const walkDirectory = async (rootPath, shouldIgnore) => {
  const results = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const current = queue.pop();
    let entries;

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      console.warn(`⚠️  Failed to read directory: ${current} (${error.code ?? error.message})`);
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      const relativePath = toPosix(relative(rootPath, absolutePath));

      if (relativePath.length === 0) {
        continue;
      }

      const ignored =
        shouldIgnore(relativePath) || shouldIgnore(`${relativePath}/`);

      if (ignored) {
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }

  return results;
};

const isBinary = (buffer) => {
  const length = Math.min(buffer.length, 1024);
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index];
    if (byte === 0) {
      return true;
    }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return true;
    }
  }
  return false;
};

const buildLineStarts = (text) => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') {
      starts.push(index + 1);
    } else if (char === '\r') {
      if (text[index + 1] === '\n') {
        starts.push(index + 2);
        index += 1;
      } else {
        starts.push(index + 1);
      }
    }
  }
  return starts;
};

const findLineIndex = (lineStarts, position) => {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;

    if (position >= start && position < nextStart) {
      return mid;
    }

    if (position < start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return lineStarts.length - 1;
};

const searchFile = (text, baseRegex, contextLines, maxRemainingMatches) => {
  const regex = new RegExp(baseRegex.source, baseRegex.flags);
  const lines = text.split(/\r?\n/);
  const lineStarts = buildLineStarts(text);
  const matches = [];
  let truncated = false;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }

    const position = match.index;
    const lineIndex = findLineIndex(lineStarts, position);
    const lineStart = lineStarts[lineIndex] ?? 0;
    const line = lines[lineIndex] ?? '';
    const columnOffset = position - lineStart;
    const column = Array.from(line.slice(0, columnOffset)).length + 1;

    const before = [];
    const beforeNumbers = [];
    for (let offset = 1; offset <= contextLines; offset += 1) {
      const targetIndex = lineIndex - offset;
      if (targetIndex < 0) {
        break;
      }
      before.unshift(lines[targetIndex] ?? '');
      beforeNumbers.unshift(targetIndex + 1);
    }

    const after = [];
    const afterNumbers = [];
    for (let offset = 1; offset <= contextLines; offset += 1) {
      const targetIndex = lineIndex + offset;
      if (targetIndex >= lines.length) {
        break;
      }
      after.push(lines[targetIndex] ?? '');
      afterNumbers.push(targetIndex + 1);
    }

    matches.push({
      lineNumber: lineIndex + 1,
      column,
      match: match[0],
      context: {
        before,
        line,
        after,
      },
      lineNumbers: {
        before: beforeNumbers,
        line: lineIndex + 1,
        after: afterNumbers,
      },
    });

    if (matches.length >= maxRemainingMatches) {
      truncated = true;
      break;
    }
  }

  return { matches, truncated, lineCount: lines.length };
};

const summarizeSkipped = (skipped) => {
  if (skipped.length === 0) {
    return;
  }

  const counts = skipped.reduce((accumulator, item) => {
    accumulator[item.reason] = (accumulator[item.reason] ?? 0) + 1;
    return accumulator;
  }, {});

  const details = Object.entries(counts)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');

  console.error(`⚠️  Skipped ${skipped.length} file(s): ${details}`);
};

const normalizeNewlines = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const buildNumberedLines = (text, lineCountHint) => {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split('\n');
  const width = String(lineCountHint ?? lines.length).length;

  return lines
    .map(
      (line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`,
    )
    .join('\n');
};

const formatContextBlock = (match, width) => {
  const rows = [];

  const beforeNumbers = match.lineNumbers?.before ?? [];
  match.context.before.forEach((text, index) => {
    rows.push({
      lineNumber: beforeNumbers[index],
      text,
      isMatch: false,
    });
  });

  rows.push({
    lineNumber: match.lineNumbers?.line ?? match.lineNumber,
    text: match.context.line,
    isMatch: true,
  });

  const afterNumbers = match.lineNumbers?.after ?? [];
  match.context.after.forEach((text, index) => {
    rows.push({
      lineNumber: afterNumbers[index],
      text,
      isMatch: false,
    });
  });

  return rows
    .map((segment) => {
      const marker = segment.isMatch ? '>' : ' ';
      const label =
        segment.lineNumber !== undefined
          ? String(segment.lineNumber).padStart(width, ' ')
          : ' '.repeat(width);
      return `${marker} ${label} | ${segment.text}`;
    })
    .join('\n');
};

const formatFileResult = (fileResult, includeAllContent) => {
  const digits = String(fileResult.lineCount ?? 1).length;
  const divider = '='.repeat(fileResult.path.length + 8);
  const lines = [
    divider,
    `=== ${fileResult.path} ===`,
    divider,
    `Matches: ${fileResult.matchCount}${
      fileResult.truncated ? ' (truncated)' : ''
    }`,
  ];

  fileResult.matches.forEach((match, index) => {
    lines.push('');
    lines.push(
      `Match ${index + 1}: L${match.lineNumber}:C${match.column} — ${
        match.match
      }`,
    );
    lines.push(formatContextBlock(match, digits));
  });

  if (includeAllContent && fileResult.content) {
    lines.push('');
    lines.push('Full content');
    lines.push('-'.repeat(12));
    lines.push(buildNumberedLines(fileResult.content, fileResult.lineCount));
  }

  return lines.join('\n');
};

const formatTextOutput = (payload, includeAllContent) => {
  if (payload.results.length === 0) {
    return `No matches found for /${payload.query.regex}/${payload.query.flags}.`;
  }

  const formattedFiles = payload.results.map((fileResult) =>
    formatFileResult(fileResult, includeAllContent),
  );

  const summary = [
    `Query: /${payload.query.regex}/${payload.query.flags}`,
    `Files visited: ${payload.aggregate.filesVisited}`,
    `Files matched: ${payload.aggregate.filesMatched}`,
    `Total matches: ${payload.aggregate.totalMatches}${
      payload.aggregate.truncated ? ' (truncated)' : ''
    }`,
  ].join('\n');

  return `${summary}\n\n${formattedFiles.join('\n\n')}\n`;
};

const main = async () => {
  const options = parseArgs();
  const normalizedFlags = normalizeFlags(options.flags);
  const baseRegex = new RegExp(options.regex, normalizedFlags);

  const includeMatcher = buildMatcher(options.includeGlobs, { matchAll: true });
  const ignoreMatcher = buildMatcher(options.ignoreGlobs);

  let candidateFiles;

  try {
    candidateFiles = listGitTrackedFiles();
  } catch {
    candidateFiles = await walkDirectory(repoRoot, ignoreMatcher);
  }

  const uniquePaths = Array.from(
    new Set(
      candidateFiles
        .map((filePath) => toPosix(filePath))
        .filter((filePath) => includeMatcher(filePath) && !ignoreMatcher(filePath)),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const maxFileSizeBytes = options.maxFileSizeKB * 1024;

  const results = [];
  const skipped = [];

  let filesVisited = 0;
  let totalMatches = 0;
  let aggregateTruncated = false;

  for (const relativePath of uniquePaths) {
    if (totalMatches >= options.maxMatches) {
      aggregateTruncated = true;
      break;
    }

    const absolutePath = resolve(repoRoot, relativePath);
    filesVisited += 1;

    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      skipped.push({
        path: relativePath,
        reason: 'statError',
        details: error.code ?? error.message,
      });
      continue;
    }

    if (stats.size > maxFileSizeBytes) {
      skipped.push({
        path: relativePath,
        reason: 'maxFileSizeExceeded',
        size: stats.size,
      });
      continue;
    }

    let buffer;
    try {
      buffer = await fs.readFile(absolutePath);
    } catch (error) {
      skipped.push({
        path: relativePath,
        reason: 'readError',
        details: error.code ?? error.message,
      });
      continue;
    }

    if (isBinary(buffer)) {
      skipped.push({
        path: relativePath,
        reason: 'binary',
        size: stats.size,
      });
      continue;
    }

    let text;
    try {
      text = buffer.toString(options.encoding);
    } catch (error) {
      skipped.push({
        path: relativePath,
        reason: 'encodingError',
        details: error.code ?? error.message,
      });
      continue;
    }

    const remainingAllowed = options.maxMatches - totalMatches;
    const { matches, truncated, lineCount } = searchFile(
      text,
      baseRegex,
      options.contextLines,
      remainingAllowed,
    );

    if (matches.length === 0) {
      continue;
    }

    totalMatches += matches.length;

    const fileResult = {
      path: relativePath,
      size: stats.size,
      matchCount: matches.length,
      matches,
      truncated,
      lineCount,
    };

    if (options.includeAllContent) {
      fileResult.content = text;
    }

    if (truncated) {
      aggregateTruncated = true;
    }

    results.push(fileResult);
  }

  const payload = {
    query: {
      regex: options.regex,
      flags: normalizedFlags,
      glob: options.includeGlobs,
      ignore: options.ignoreGlobs,
      contextLines: options.contextLines,
      includeAllContent: options.includeAllContent,
      maxFileSizeKB: options.maxFileSizeKB,
      maxMatches: options.maxMatches,
      encoding: options.encoding,
    },
    results,
    skipped,
    aggregate: {
      filesVisited,
      filesMatched: results.length,
      totalMatches,
      truncated: aggregateTruncated,
    },
  };

  summarizeSkipped(skipped);

  if (aggregateTruncated) {
    console.error('⚠️  Match results truncated by maxMatches limit.');
  }

  if (options.outputMode === 'json') {
    process.stdout.write(JSON.stringify(payload));
  } else {
    process.stdout.write(formatTextOutput(payload, options.includeAllContent));
  }
};

main().catch((error) => {
  console.error('❌ Unexpected error while running smart-file-query.');
  console.error(error);
  process.exit(1);
});
