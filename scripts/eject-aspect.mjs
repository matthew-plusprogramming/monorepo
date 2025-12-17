import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCliArguments } from './utils/cli-args.mjs';
import { fileExists } from './utils/fs-utils.mjs';

const ASPECTS_DIR = resolve(process.cwd(), 'scripts/aspects');

const CLI_CONFIG = {
  usage: [
    'Usage: node scripts/eject-aspect.mjs <aspect-slug> [options]',
    '',
    'Options:',
    '  --dry-run    Preview changes without writing',
    '  --help       Show this help message',
    '',
    'Examples:',
    '  node scripts/eject-aspect.mjs analytics --dry-run',
    '  node scripts/eject-aspect.mjs analytics',
    '  node scripts/eject-aspect.mjs users --dry-run',
    '  node scripts/eject-aspect.mjs users',
  ],
  flags: [
    {
      key: 'dryRun',
      long: '--dry-run',
      type: 'boolean',
      default: false,
    },
  ],
  arguments: {
    slug: {
      pattern: '^[a-z][a-z0-9-]*$',
      errorMessage: 'Aspect slug must be kebab-case.',
    },
  },
};

const getAvailableAspects = async () => {
  try {
    const entries = await readdir(ASPECTS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.aspect.mjs'))
      .map((entry) => entry.name.replace(/\.aspect\.mjs$/, ''))
      .sort();
  } catch {
    return [];
  }
};

const printUsage = async () => {
  const available = await getAvailableAspects();
  const lines = [...CLI_CONFIG.usage];
  lines.push('', 'Available aspects:');
  if (available.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const slug of available) {
      lines.push(`  - ${slug}`);
    }
  }
  console.log(lines.join('\n'));
};

const loadAspectDefinition = async (slug) => {
  const defPath = resolve(ASPECTS_DIR, `${slug}.aspect.mjs`);
  if (!(await fileExists(defPath))) {
    return null;
  }
  const module = await import(pathToFileURL(defPath).href);
  return module.default ?? null;
};

const applyTransform = (content, transform) => {
  if (Array.isArray(transform)) {
    return transform.reduce((current, fn) => fn(current), content);
  }
  return transform(content);
};

const main = async () => {
  let parsedArgs;
  try {
    parsedArgs = parseCliArguments(process.argv.slice(2), CLI_CONFIG);
  } catch (error) {
    console.error(error.message);
    await printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsedArgs.helpRequested) {
    await printUsage();
    return;
  }

  const slug = parsedArgs.slug;
  const { dryRun } = parsedArgs.flags;

  const aspect = await loadAspectDefinition(slug);
  if (!aspect) {
    console.error(`Unknown aspect "${slug}".`);
    await printUsage();
    process.exitCode = 1;
    return;
  }

  const actions = [];

  for (const repoPath of aspect.deletePaths ?? []) {
    const absPath = resolve(process.cwd(), repoPath);
    const exists = await fileExists(absPath);
    if (!exists) {
      actions.push({ type: 'delete', path: repoPath, action: 'skipped-missing' });
      continue;
    }

    if (dryRun) {
      actions.push({ type: 'delete', path: repoPath, action: 'would-delete' });
      continue;
    }

    await rm(absPath, { recursive: true, force: true });
    actions.push({ type: 'delete', path: repoPath, action: 'deleted' });
  }

  for (const edit of aspect.fileEdits ?? []) {
    const repoPath = edit.path;
    const absPath = resolve(process.cwd(), repoPath);
    const exists = await fileExists(absPath);
    if (!exists) {
      actions.push({ type: 'edit', path: repoPath, action: 'skipped-missing' });
      continue;
    }

    const original = await readFile(absPath, 'utf-8');
    let updated;
    try {
      updated = applyTransform(original, edit.transform);
    } catch (error) {
      console.error(`Transform failed for ${repoPath}`);
      throw error;
    }

    if (updated === original) {
      actions.push({ type: 'edit', path: repoPath, action: 'no-op' });
      continue;
    }

    if (dryRun) {
      actions.push({ type: 'edit', path: repoPath, action: 'would-edit' });
      continue;
    }

    await writeFile(absPath, updated, 'utf-8');
    actions.push({ type: 'edit', path: repoPath, action: 'edited' });
  }

  const heading = dryRun ? 'Planned' : 'Applied';
  console.log(`${heading} ejection for aspect "${slug}".`);
  for (const entry of actions) {
    console.log(`- ${entry.type}: ${entry.path} (${entry.action})`);
  }

  if (!dryRun && aspect.notes?.length) {
    console.log('\nNotes:');
    for (const note of aspect.notes) {
      console.log(`- ${note}`);
    }
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
