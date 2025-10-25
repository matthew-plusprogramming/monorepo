#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { root as repoRoot } from './utils.mjs';

const USAGE = `Usage: node agents/scripts/read-files.mjs --files "<path[,path...]>" [options]

Read the contents of one or more repo-relative files and print a JSON payload
preserving the requested order.

Options
  --files "<path[,path...]>"   Comma-separated repo-relative paths (repeatable)
  --file-list <path>           File containing newline-delimited repo-relative paths
  --encoding <value>           Text encoding (default: utf8)
  --maxFileSizeKB <number>     Reject files larger than this size in KB (default: 256)
  --json                       Emit the legacy JSON payload (default: numbered text output)
  --text                       Force numbered text output (default)
  -h, --help                   Show this help message

Examples
  node agents/scripts/read-files.mjs --files "AGENTS.md,agents/tools.md"
  node agents/scripts/read-files.mjs --file-list scripts/files-to-read.txt
  node agents/scripts/read-files.mjs --files docs/README.md --encoding utf8 --maxFileSizeKB 512
`;

const args = process.argv.slice(2);

const options = {
  fileTokens: [],
  listFiles: [],
  encoding: 'utf8',
  maxFileSizeKB: 256,
  showHelp: false,
  outputMode: 'text',
};

const parseListArgument = (value) =>
  value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

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
    case '--files': {
      const value = inlineValue ?? consumeValue(index, rawFlag);
      options.fileTokens.push(...parseListArgument(value));
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--file-list': {
      const value = inlineValue ?? consumeValue(index, rawFlag);
      options.listFiles.push(value);
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--encoding': {
      const value = inlineValue ?? consumeValue(index, rawFlag);
      options.encoding = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--maxFileSizeKB': {
      const value = inlineValue ?? consumeValue(index, rawFlag);
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        console.error('❌ --maxFileSizeKB must be an integer.');
        process.exit(1);
      }
      options.maxFileSizeKB = parsed;
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

const maxFileSizeBytes = options.maxFileSizeKB * 1024;

const ensureRepoRelative = (inputPath) => {
  if (!inputPath || inputPath.length === 0) {
    console.error('❌ Encountered empty file path.');
    process.exit(1);
  }

  if (inputPath.startsWith('/')) {
    console.error(`❌ File path must be repo-relative: "${inputPath}"`);
    process.exit(1);
  }

  const absolutePath = resolve(repoRoot, inputPath);
  const relativePath = relative(repoRoot, absolutePath);

  if (relativePath.startsWith('..') || relativePath === '') {
    console.error(`❌ File path escapes repository root: "${inputPath}"`);
    process.exit(1);
  }

  return { absolutePath, relativePath: relativePath.replace(/\\/g, '/') };
};

const readListFile = async (listPath) => {
  const { absolutePath } = ensureRepoRelative(listPath);

  let text;
  try {
    text = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    console.error(
      `❌ Failed to read file list "${listPath}": ${error.message}`,
    );
    process.exit(1);
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
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

const gatherRequestedFiles = async () => {
  const fromLists = await Promise.all(
    options.listFiles.map((file) => readListFile(file)),
  );

  const allPaths = [...options.fileTokens, ...fromLists.flat()].map((path) =>
    path.trim(),
  );

  const uniquePaths = [];
  const seen = new Set();

  for (const candidate of allPaths) {
    if (candidate.length === 0) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      uniquePaths.push(candidate);
    }
  }

  if (uniquePaths.length === 0) {
    console.error(
      '❌ At least one repo-relative file must be provided via --files or --file-list.',
    );
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  return uniquePaths;
};

const readFileContent = async (inputPath) => {
  const { absolutePath, relativePath } = ensureRepoRelative(inputPath);

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    console.error(`❌ File not found: "${inputPath}"`);
    process.exit(1);
  }

  if (!stats.isFile()) {
    console.error(`❌ Path is not a file: "${inputPath}"`);
    process.exit(1);
  }

  if (stats.size > maxFileSizeBytes) {
    console.error(
      `❌ File "${inputPath}" is larger than ${options.maxFileSizeKB} KB.`,
    );
    process.exit(1);
  }

  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (error) {
    console.error(`❌ Failed to read "${inputPath}": ${error.message}`);
    process.exit(1);
  }

  if (isBinary(buffer)) {
    console.error(
      `❌ File appears to be binary and was skipped: "${inputPath}"`,
    );
    process.exit(1);
  }

  let content;
  try {
    content = buffer.toString(options.encoding);
  } catch (error) {
    console.error(
      `❌ Failed to decode "${inputPath}" with encoding "${options.encoding}".`,
    );
    process.exit(1);
  }

  return { path: relativePath, content };
};

const buildNumberedText = (path, content) => {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const width = String(lines.length).length;
  const divider = '='.repeat(path.length + 8);

  const numbered = lines
    .map(
      (line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`,
    )
    .join('\n');

  return `${divider}\n=== ${path} ===\n${divider}\n${numbered}`;
};

const main = async () => {
  const requestedFiles = await gatherRequestedFiles();
  const results = [];

  for (const file of requestedFiles) {
    const record = await readFileContent(file);
    results.push(record);
  }

  if (options.outputMode === 'json') {
    process.stdout.write(JSON.stringify({ files: results }));
    return;
  }

  const formatted = results.map(({ path, content }) =>
    buildNumberedText(path, content),
  );

  process.stdout.write(`${formatted.join('\n\n')}\n`);
};

main().catch((error) => {
  console.error('❌ Unexpected error while reading files.');
  console.error(error);
  process.exit(1);
});
