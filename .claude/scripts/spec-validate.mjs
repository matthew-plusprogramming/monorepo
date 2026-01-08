#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve, relative, join } from 'node:path';
import process from 'node:process';
import {
  extractHeadings,
  normalizeSection,
  parseFrontMatter,
  parseYamlList,
  readTextFile,
} from './spec-utils.mjs';

const USAGE = `Usage: node .claude/scripts/spec-validate.mjs [options]

Validates spec front matter, required sections, and contract registry references.

Options
  --specs <path[,path...]>   Comma-separated spec file paths to validate
  --root <path>              Root directory to scan for specs (default: .claude/specs)
  --registry <path>          Contract registry path (default: .claude/contracts/registry.yaml)
  --allow-empty              Exit 0 when no specs are found
  -h, --help                 Show this help message

Examples
  node .claude/scripts/spec-validate.mjs --specs .claude/specs/active/my-spec.md
  node .claude/scripts/spec-validate.mjs --root .claude/specs/active
`;

const REQUIRED_SECTIONS = {
  workstream: [
    'Context',
    'Goals / Non-goals',
    'Requirements',
    'Core Flows',
    'Sequence Diagram(s)',
    'Edge Cases',
    'Interfaces & Data Model',
    'Security',
    'Additional considerations',
    'Task List',
    'Testing',
    'Open Questions',
    'Decision & Work Log',
  ],
  problem: [
    'Context',
    'Goals / Non-goals',
    'Constraints',
    'Success Criteria',
    'Additional considerations',
    'Open Questions',
    'Decision & Work Log',
  ],
  master: [
    'Summary',
    'Workstreams',
    'Contracts',
    'Gates',
    'Additional considerations',
    'Open Questions',
    'Decision & Work Log',
  ],
};

const args = process.argv.slice(2);
const options = {
  specs: [],
  root: '.claude/specs',
  registry: '.claude/contracts/registry.yaml',
  allowEmpty: false,
  showHelp: false,
};

const popValue = (index, flag) => {
  if (index + 1 >= args.length) {
    console.error(`❌ Missing value after "${flag}"`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }
  return args[index + 1];
};

for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  switch (token) {
    case '-h':
    case '--help':
      options.showHelp = true;
      break;
    case '--specs':
    case '--spec': {
      const value = popValue(index, token);
      options.specs.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
      break;
    }
    case '--root':
      options.root = popValue(index, token);
      index += 1;
      break;
    case '--registry':
      options.registry = popValue(index, token);
      index += 1;
      break;
    case '--allow-empty':
      options.allowEmpty = true;
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

const repoRoot = process.cwd();

const toPosix = (value) => value.replace(/\\/g, '/');

const isSpecCandidate = (relativePath) => {
  const normalized = toPosix(relativePath);
  if (
    normalized.includes('/templates/') ||
    normalized.includes('/schema/') ||
    normalized.includes('/fixtures/')
  ) {
    return false;
  }
  if (normalized.includes('/workstreams/')) {
    return true;
  }
  const base = basename(normalized);
  return (
    base.startsWith('problem-brief') ||
    base.startsWith('master-spec')
  );
};

const collectSpecFiles = (rootPath) => {
  const results = [];
  const rootAbs = resolve(repoRoot, rootPath);

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stats.isFile() || !name.endsWith('.md')) {
        continue;
      }
      const rel = toPosix(relative(repoRoot, abs));
      if (isSpecCandidate(rel)) {
        results.push(rel);
      }
    }
  };

  walk(rootAbs);
  return results;
};

const loadRegistry = (registryPath) => {
  const abs = resolve(repoRoot, registryPath);
  if (!existsSync(abs)) {
    return {
      entries: [],
      errors: [`Registry not found: ${registryPath}`],
    };
  }
  const content = readTextFile(abs);
  const { items, errors } = parseYamlList(content);
  const entryErrors = [...errors];
  const ids = new Set();

  items.forEach((item, index) => {
    const missing = ['id', 'type', 'path', 'owner'].filter(
      (field) => !item?.[field],
    );
    if (missing.length > 0) {
      entryErrors.push(
        `Registry entry ${index + 1} missing fields: ${missing.join(', ')}`,
      );
    }
    if (item?.id) {
      if (ids.has(item.id)) {
        entryErrors.push(`Duplicate registry id: ${item.id}`);
      }
      ids.add(item.id);
    }
  });

  return { entries: items, ids, errors: entryErrors };
};

const detectSpecType = (path, data) => {
  if (data?.workstreams && data?.gates) return 'master';
  if (data?.summary && data?.success_criteria) return 'problem';
  if (data?.owner && data?.scope) return 'workstream';
  // TaskSpec: has id, title, date, status (lightweight spec for single tasks)
  if (data?.id && data?.title && data?.date && data?.status) return 'task';
  const base = basename(path);
  if (base.startsWith('problem-brief')) return 'problem';
  if (base.startsWith('master-spec')) return 'master';
  if (path.includes('/workstreams/')) return 'workstream';
  // Default to task for specs in active/ directory with standard naming
  if (path.includes('/active/') && /^\d{4}-\d{2}-\d{2}/.test(base)) return 'task';
  return 'unknown';
};

const ensureArray = (value) => Array.isArray(value);
const ensureString = (value) => typeof value === 'string' && value.length > 0;

const validateFrontMatter = (type, data) => {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return ['Missing or invalid YAML front matter data.'];
  }
  const requireFields = {
    task: {
      id: ensureString,
      title: ensureString,
      date: ensureString,
      status: ensureString,
    },
    workstream: {
      id: ensureString,
      title: ensureString,
      owner: ensureString,
      scope: ensureString,
      dependencies: ensureArray,
      contracts: ensureArray,
      status: ensureString,
    },
    problem: {
      id: ensureString,
      title: ensureString,
      summary: ensureString,
      goals: ensureArray,
      non_goals: ensureArray,
      constraints: ensureArray,
      success_criteria: ensureArray,
      open_questions: ensureArray,
    },
    master: {
      id: ensureString,
      title: ensureString,
      workstreams: ensureArray,
      contracts: ensureArray,
      gates: ensureArray,
      status: ensureString,
    },
  };
  const validators = requireFields[type];
  if (!validators) {
    return [`Unknown spec type: ${type}`];
  }
  for (const [field, validator] of Object.entries(validators)) {
    if (!validator(data[field])) {
      errors.push(`Missing or invalid front matter field: ${field}`);
    }
  }
  return errors;
};

const collectContractIds = (type, data) => {
  if (!data?.contracts) return [];
  if (!Array.isArray(data.contracts)) return [];
  if (type === 'workstream') {
    return data.contracts
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && entry.id) return entry.id;
        return null;
      })
      .filter(Boolean);
  }
  return data.contracts.filter((entry) => typeof entry === 'string');
};

const specs =
  options.specs.length > 0 ? options.specs : collectSpecFiles(options.root);

if (specs.length === 0) {
  const message = `No spec files found under ${options.root}.`;
  if (options.allowEmpty) {
    console.warn(`⚠️  ${message}`);
    process.exit(0);
  }
  console.error(`❌ ${message}`);
  process.exit(1);
}

const registry = loadRegistry(options.registry);
const registryIds = registry.ids ?? new Set();
const errors = [];

for (const specPath of specs) {
  const abs = resolve(repoRoot, specPath);
  if (!existsSync(abs)) {
    errors.push({ file: specPath, message: 'Spec file not found.' });
    continue;
  }
  const content = readTextFile(abs);
  const { data, body, errors: fmErrors } = parseFrontMatter(content);
  if (fmErrors.length > 0) {
    fmErrors.forEach((message) =>
      errors.push({ file: specPath, message }),
    );
    continue;
  }
  const type = detectSpecType(specPath, data);
  const fmIssues = validateFrontMatter(type, data);
  fmIssues.forEach((message) => errors.push({ file: specPath, message }));

  const headings = extractHeadings(body);
  const required = REQUIRED_SECTIONS[type] ?? [];
  for (const section of required) {
    const normalized = normalizeSection(section);
    if (!headings.has(normalized)) {
      errors.push({
        file: specPath,
        message: `Missing required section: ${section}`,
      });
    }
  }

  const contractIds = collectContractIds(type, data);
  for (const contractId of contractIds) {
    if (!registryIds.has(contractId)) {
      errors.push({
        file: specPath,
        message: `Missing contract registry entry: ${contractId}`,
      });
    }
  }
}

for (const registryError of registry.errors ?? []) {
  errors.push({ file: options.registry, message: registryError });
}

if (errors.length > 0) {
  console.error('❌ Spec validation failed:');
  for (const issue of errors) {
    console.error(` - ${issue.file}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`✅ Spec validation passed (${specs.length} file(s)).`);
