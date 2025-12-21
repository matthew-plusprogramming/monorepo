#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { parseFrontMatter, parseYamlList, readTextFile } from './spec-utils.mjs';

const USAGE = `Usage: node agents/scripts/spec-merge.mjs --specs <path[,path...]> --output <path> [options]

Merges workstream specs into a MasterSpec and emits a gate report summary.

Options
  --specs <path[,path...]>   Comma-separated workstream spec paths
  --root <path>              Root directory to scan for workstream specs
  --output <path>            Output path for the MasterSpec (required)
  --report <path>            Output path for the gate report (default: <output-dir>/gate-report.md)
  --registry <path>          Contract registry path (default: agents/contracts/registry.yaml)
  --id <value>               MasterSpec id override
  --title <value>            MasterSpec title override
  -h, --help                 Show this help message

Examples
  node agents/scripts/spec-merge.mjs --specs agents/specs/foo/workstreams/ws-a.md --output agents/specs/foo/master-spec.md
  node agents/scripts/spec-merge.mjs --root agents/specs/foo --output agents/specs/foo/master-spec.md
`;

const args = process.argv.slice(2);
const options = {
  specs: [],
  root: null,
  output: null,
  report: null,
  registry: 'agents/contracts/registry.yaml',
  id: null,
  title: null,
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
    case '--specs': {
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
    case '--output':
      options.output = popValue(index, token);
      index += 1;
      break;
    case '--report':
      options.report = popValue(index, token);
      index += 1;
      break;
    case '--registry':
      options.registry = popValue(index, token);
      index += 1;
      break;
    case '--id':
      options.id = popValue(index, token);
      index += 1;
      break;
    case '--title':
      options.title = popValue(index, token);
      index += 1;
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

if (!options.output) {
  console.error('❌ --output is required.');
  console.error(USAGE.trimEnd());
  process.exit(1);
}

const repoRoot = process.cwd();
const specsRoot = resolve(repoRoot, 'agents/specs');

const toPosix = (value) => value.replace(/\\/g, '/');

const ensureSafeOutputPath = (targetPath, label) => {
  const abs = resolve(repoRoot, targetPath);
  const rel = relative(specsRoot, abs);
  if (rel.startsWith('..') || rel === '') {
    console.error(
      `❌ ${label} must be under agents/specs/. Received: ${targetPath}`,
    );
    process.exit(1);
  }
  return abs;
};

const isWorkstreamSpec = (relativePath) => {
  const normalized = toPosix(relativePath);
  if (normalized.includes('/templates/') || normalized.includes('/schema/')) {
    return false;
  }
  return normalized.includes('/workstreams/') && normalized.endsWith('.md');
};

const collectWorkstreamSpecs = (rootPath) => {
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
      if (isWorkstreamSpec(rel)) {
        results.push(rel);
      }
    }
  };

  walk(rootAbs);
  return results;
};

const loadRegistryIds = (registryPath) => {
  const abs = resolve(repoRoot, registryPath);
  if (!existsSync(abs)) {
    return { ids: new Set(), errors: [`Registry not found: ${registryPath}`] };
  }
  const content = readTextFile(abs);
  const { items, errors } = parseYamlList(content);
  const ids = new Set();
  const issues = [...errors];
  items.forEach((item) => {
    if (!item?.id) {
      issues.push('Registry entry missing id field.');
      return;
    }
    if (ids.has(item.id)) {
      issues.push(`Duplicate registry id: ${item.id}`);
    }
    ids.add(item.id);
  });
  return { ids, errors: issues };
};

const specs =
  options.specs.length > 0
    ? options.specs
    : options.root
      ? collectWorkstreamSpecs(options.root)
      : [];

if (specs.length === 0) {
  console.error('❌ No workstream specs provided or found.');
  console.error(USAGE.trimEnd());
  process.exit(1);
}

const outputAbs = ensureSafeOutputPath(options.output, 'Output path');
const reportPath =
  options.report ??
  join(dirname(options.output), 'gate-report.md');
const reportAbs = ensureSafeOutputPath(reportPath, 'Report path');

const registry = loadRegistryIds(options.registry);
const registryIds = registry.ids;
const errors = [];

const workstreams = [];
const ids = new Set();
const duplicateIds = new Set();

for (const specPath of specs) {
  const abs = resolve(repoRoot, specPath);
  if (!existsSync(abs)) {
    errors.push(`Spec not found: ${specPath}`);
    continue;
  }
  const content = readTextFile(abs);
  const { data, errors: fmErrors } = parseFrontMatter(content);
  if (fmErrors.length > 0) {
    fmErrors.forEach((message) =>
      errors.push(`${specPath}: ${message}`),
    );
    continue;
  }
  const id = data?.id;
  if (!id) {
    errors.push(`${specPath}: Missing id in front matter.`);
    continue;
  }
  if (ids.has(id)) {
    duplicateIds.add(id);
  }
  ids.add(id);
  const dependencies = Array.isArray(data?.dependencies)
    ? data.dependencies
    : [];
  const contracts = Array.isArray(data?.contracts)
    ? data.contracts
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && entry.id) return entry.id;
          return null;
        })
        .filter(Boolean)
    : [];

  workstreams.push({
    id,
    owner: data?.owner ?? 'unknown',
    scope: data?.scope ?? '',
    dependencies,
    contracts,
    source: specPath,
  });
}

if (duplicateIds.size > 0) {
  errors.push(`Duplicate workstream ids: ${[...duplicateIds].join(', ')}`);
}

const graph = new Map();
const missingDependencies = new Map();
workstreams.forEach((ws) => {
  graph.set(ws.id, ws.dependencies ?? []);
});

const availableIds = new Set(workstreams.map((ws) => ws.id));
for (const ws of workstreams) {
  const missing = (ws.dependencies ?? []).filter(
    (dep) => !availableIds.has(dep),
  );
  if (missing.length > 0) {
    missingDependencies.set(ws.id, missing);
  }
}

const cycles = [];
const visiting = new Set();
const visited = new Set();
const stack = [];

const visit = (node) => {
  if (visiting.has(node)) {
    const index = stack.indexOf(node);
    cycles.push([...stack.slice(index), node]);
    return;
  }
  if (visited.has(node)) return;
  visiting.add(node);
  stack.push(node);
  const deps = graph.get(node) ?? [];
  deps.forEach((dep) => {
    if (graph.has(dep)) visit(dep);
  });
  visiting.delete(node);
  stack.pop();
  visited.add(node);
};

for (const node of graph.keys()) {
  visit(node);
}

if (cycles.length > 0) {
  cycles.forEach((cycle) => {
    errors.push(`Dependency cycle detected: ${cycle.join(' -> ')}`);
  });
}

const allContracts = new Set();
const missingContracts = new Set();
workstreams.forEach((ws) => {
  (ws.contracts ?? []).forEach((contractId) => {
    allContracts.add(contractId);
    if (!registryIds.has(contractId)) {
      missingContracts.add(contractId);
    }
  });
});

if (missingContracts.size > 0) {
  errors.push(
    `Missing contract registry entries: ${[...missingContracts].join(', ')}`,
  );
}

for (const registryError of registry.errors ?? []) {
  errors.push(`Registry: ${registryError}`);
}

const outputDir = dirname(outputAbs);
mkdirSync(outputDir, { recursive: true });

const outputRel = toPosix(relative(specsRoot, outputAbs));
const taskSegment = outputRel.split('/')[0];
const derivedId = taskSegment ? `master-${taskSegment}` : 'master-spec';
const masterId = options.id ?? derivedId;
const masterTitle = options.title ?? (taskSegment ? `MasterSpec for ${taskSegment}` : 'MasterSpec');

const masterFrontMatter = [
  '---',
  `id: ${masterId}`,
  `title: ${masterTitle}`,
  'workstreams:',
  ...workstreams.map((ws) => `  - ${ws.id}`),
  'contracts:',
  ...[...allContracts].map((contractId) => `  - ${contractId}`),
  'gates:',
  '  - spec_complete',
  'status: draft',
  '---',
].join('\n');

const masterBody = [
  `# ${masterTitle}`,
  '',
  '## Summary',
  '',
  `- Generated by spec-merge from ${workstreams.length} workstream spec(s).`,
  '',
  '## Workstreams',
  '',
  ...workstreams.map(
    (ws) => `- \`${ws.id}\`: ${ws.owner} - ${ws.scope || 'scope pending'}`,
  ),
  '',
  '## Contracts',
  '',
  ...[...allContracts].map((contractId) => `- ${contractId}`),
  '',
  '## Gates',
  '',
  '- spec_complete',
  '',
  '## Additional considerations',
  '',
  '- ...',
  '',
  '## Open Questions',
  '',
  '- ...',
  '',
  '## Decision & Work Log',
  '',
  '- Decision:',
  '- Approval:',
  '- Work Log:',
  '',
].join('\n');

writeFileSync(outputAbs, `${masterFrontMatter}\n\n${masterBody}`, 'utf8');

const gateStatus = errors.length === 0 ? 'pass' : 'fail';
const gateReport = [
  '# Gate Report',
  '',
  `- status: ${gateStatus}`,
  `- generated_at: ${new Date().toISOString()}`,
  '',
  '## Summary',
  '',
  `- workstreams: ${workstreams.length}`,
  `- contracts: ${allContracts.size}`,
  '',
  '## Issues',
  '',
  ...(errors.length === 0 ? ['- none'] : errors.map((issue) => `- ${issue}`)),
  '',
].join('\n');

mkdirSync(dirname(reportAbs), { recursive: true });
writeFileSync(reportAbs, gateReport, 'utf8');

if (errors.length > 0) {
  console.error('❌ spec-merge completed with issues:');
  errors.forEach((issue) => console.error(` - ${issue}`));
  process.exit(1);
}

console.log(`✅ MasterSpec written to ${options.output}`);
console.log(`✅ Gate report written to ${reportPath}`);
