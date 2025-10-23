#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(__dirname, 'templates', 'repository-service');
const OUTPUT_ROOT = resolve(__dirname, '..');
const SCHEMAS_PACKAGE_JSON_PATH = join(
  OUTPUT_ROOT,
  'packages',
  'core',
  'schemas',
  'package.json',
);
const APP_LAYER_PATH = join(
  OUTPUT_ROOT,
  'apps',
  'node-server',
  'src',
  'layers',
  'app.layer.ts',
);

const slugToSegments = (slug) =>
  slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

const toPascalCase = (slug) =>
  slugToSegments(slug)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');

const toCamelCase = (slug) => {
  const [first, ...rest] = slugToSegments(slug);
  if (!first) return '';
  const pascalTail = rest
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
  return `${first}${pascalTail}`;
};

const toConstantCase = (slug) =>
  slugToSegments(slug)
    .map((segment) => segment.toUpperCase())
    .join('_');

const usage = (bundles = []) => {
  const optional = bundles.filter((bundle) => !bundle.required);
  const optionalSummary =
    optional.length > 0
      ? [
          '',
          'Optional bundles:',
          ...optional.map(
            (bundle) => `  - ${bundle.name}: ${bundle.description}`,
          ),
        ]
      : [];

  console.log(
    [
      'Usage: node scripts/create-repository-service.mjs <entity-slug> [--dry-run] [--force] [--with bundleA,bundleB]',
      '',
      'Examples:',
      '  node scripts/create-repository-service.mjs user-profile',
      '  node scripts/create-repository-service.mjs order --with handler --dry-run',
      '',
      'Flags:',
      '  --with bundleA,bundleB  Include optional bundles (use "all" to include everything)',
      '  --dry-run               Preview generated files without writing them',
      '  --force                 Overwrite existing files created by a previous run',
      '',
      'Run without --with in an interactive terminal to choose bundles via prompts.',
      ...optionalSummary,
    ].join('\n'),
  );
};

const parseArgs = (rawArgs) => {
  const options = {
    dryRun: false,
    force: false,
    slug: '',
    withBundles: [],
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--with') {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error('Missing value for --with flag.');
      }
      options.withBundles.push(...value.split(',').map((item) => item.trim()));
      index += 1;
      continue;
    }
    if (arg.startsWith('--with=')) {
      const [, value] = arg.split('=');
      options.withBundles.push(...value.split(',').map((item) => item.trim()));
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (options.slug) {
      throw new Error('Only a single entity slug is supported.');
    }
    options.slug = arg;
  }

  if (!options.slug) {
    throw new Error('Missing entity slug.');
  }

  if (!/^[a-z][a-z0-9-]*$/.test(options.slug)) {
    throw new Error(
      `Invalid slug "${options.slug}". Use kebab-case (letters, numbers, hyphen).`,
    );
  }

  options.withBundles = options.withBundles
    .filter(Boolean)
    .map((name) => name.toLowerCase());

  return options;
};

const ensureDir = async (targetDir) => {
  await mkdir(targetDir, { recursive: true });
};

const fileExists = async (filePath) => {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const replaceTokens = (template, tokens) => {
  let output = template;
  for (const [token, value] of Object.entries(tokens)) {
    const pattern = new RegExp(token, 'g');
    output = output.replace(pattern, value);
  }
  return output;
};

const writeFileSafely = async (targetPath, content, { dryRun, force }) => {
  const exists = await fileExists(targetPath);
  if (exists && !force) {
    throw new Error(
      `Refusing to overwrite existing file without --force: ${relative(
        OUTPUT_ROOT,
        targetPath,
      )}`,
    );
  }

  if (dryRun) {
    return;
  }

  await ensureDir(dirname(targetPath));
  await writeFile(targetPath, content, 'utf-8');
};

const updateSchemasPackageJson = async (slug, { dryRun, force }) => {
  const raw = await readFile(SCHEMAS_PACKAGE_JSON_PATH, 'utf-8');
  const data = JSON.parse(raw);

  if (!data.exports || typeof data.exports !== 'object') {
    throw new Error(
      `Unable to update exports in ${relative(
        OUTPUT_ROOT,
        SCHEMAS_PACKAGE_JSON_PATH,
      )}: missing "exports" field.`,
    );
  }

  const exportKey = `./${slug}`;
  const desiredExport = {
    types: `./dist/${slug}/index.d.ts`,
    import: `./dist/${slug}/index.js`,
  };

  const existingExport = data.exports[exportKey];

  const matchesExisting =
    existingExport &&
    existingExport.types === desiredExport.types &&
    existingExport.import === desiredExport.import;

  if (matchesExisting) {
    return { changed: false };
  }

  if (existingExport && !force) {
    throw new Error(
      [
        `Export "${exportKey}" already exists in ${relative(
          OUTPUT_ROOT,
          SCHEMAS_PACKAGE_JSON_PATH,
        )}.`,
        'Run again with --force to overwrite the existing export.',
      ].join(' '),
    );
  }

  const updatedExports = {
    ...data.exports,
    [exportKey]: desiredExport,
  };

  const sortedEntries = Object.entries(updatedExports).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  data.exports = Object.fromEntries(sortedEntries);

  if (!dryRun) {
    await writeFile(
      SCHEMAS_PACKAGE_JSON_PATH,
      `${JSON.stringify(data, null, 2)}\n`,
      'utf-8',
    );
  }

  return {
    changed: true,
    action: existingExport ? 'updated export' : 'added export',
    location: SCHEMAS_PACKAGE_JSON_PATH,
  };
};

const loadManifest = async () => {
  const manifestPath = join(TEMPLATE_ROOT, 'manifest.json');
  const manifestContent = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestContent);
  if (!Array.isArray(manifest?.bundles)) {
    throw new Error('Template manifest must contain a "bundles" array.');
  }
  return manifest.bundles;
};

const updateAppLayer = async (
  pascalCase,
  camelCase,
  { dryRun },
) => {
  const originalContent = await readFile(APP_LAYER_PATH, 'utf-8');

  const repositoryImportPattern =
    /^import { (Live[A-Za-z0-9]+Repo) } from '(@\/services\/[a-zA-Z0-9]+Repo\.service)';$/gm;

  const repositoryImports = new Map();
  let match;
  while ((match = repositoryImportPattern.exec(originalContent)) !== null) {
    repositoryImports.set(match[1], match[2]);
  }

  const importName = `Live${pascalCase}Repo`;
  const importPath = `@/services/${camelCase}Repo.service`;
  const alreadyPresent = repositoryImports.has(importName);

  if (!alreadyPresent) {
    repositoryImports.set(importName, importPath);
  }

  const sortedRepositoryImports = [...repositoryImports.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );

  const repositoryImportLines = sortedRepositoryImports.map(
    ([name, path]) => `import { ${name} } from '${path}';`,
  );

  const headerImports = [
    "import { Layer } from 'effect';",
    '',
    "import { LiveDynamoDbService } from '@/services/dynamodb.service';",
    "import { LiveEventBridgeService } from '@/services/eventBridge.service';",
    "import { ApplicationLoggerService } from '@/services/logger.service';",
    ...repositoryImportLines,
    '',
  ];

  const repositoryNames = sortedRepositoryImports.map(([name]) => name);

  const providedVariableNames = repositoryNames.map(
    (name) => `${name}Provided`,
  );

  const providedConstants = repositoryNames.map(
    (name, index) =>
      `const ${providedVariableNames[index]} = ${name}.pipe(Layer.provide(Base));`,
  );

  const mergeCalls = providedVariableNames.map(
    (providedName) => `Layer.merge(${providedName})`,
  );

  const appLayerBlock =
    mergeCalls.length > 0
      ? `export const AppLayer = Base.pipe(
  ${mergeCalls.join(',\n  ')}
);`
      : 'export const AppLayer = Base;';

  const baseSection = `const Base = LiveDynamoDbService.pipe(
  Layer.merge(ApplicationLoggerService),
).pipe(Layer.merge(LiveEventBridgeService));`;

  const updatedContent = [
    ...headerImports,
    baseSection,
    '',
    ...providedConstants,
    '',
    appLayerBlock,
    '',
  ].join('\n');

  if (updatedContent === originalContent) {
    return { changed: false };
  }

  if (!dryRun) {
    await writeFile(APP_LAYER_PATH, updatedContent, 'utf-8');
  }

  return {
    changed: true,
    action: alreadyPresent ? 'normalized AppLayer' : 'updated AppLayer',
    location: APP_LAYER_PATH,
  };
};

const runLintFix = ({ dryRun }) => {
  if (dryRun) {
    console.log('ℹ️  Skipping `npm run lint:fix` (dry run).');
    return false;
  }

  console.log('▶️  Running `npm run lint:fix` to format new scaffolding...');
  const result = spawnSync('npm', ['run', 'lint:fix'], {
    cwd: OUTPUT_ROOT,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error('`npm run lint:fix` failed. See output above for details.');
  }

  return true;
};

const normaliseName = (value) => value.toLowerCase();

const selectBundles = async (bundles, requestedNames) => {
  const requiredBundles = bundles.filter((bundle) => bundle.required);
  const optionalBundles = bundles.filter((bundle) => !bundle.required);

  const requested = new Set(requestedNames.map(normaliseName));

  if (requested.has('all')) {
    optionalBundles.forEach((bundle) =>
      requested.add(normaliseName(bundle.name)),
    );
    requested.delete('all');
  }

  const bundleLookup = new Map(
    bundles.map((bundle) => [normaliseName(bundle.name), bundle]),
  );

  const unknownSelection = [...requested].filter(
    (name) => !bundleLookup.has(normaliseName(name)),
  );
  if (unknownSelection.length > 0) {
    throw new Error(
      `Unknown bundle(s): ${unknownSelection.join(
        ', ',
      )}. Run with --help for available bundles.`,
    );
  }

  let selectedOptional = [...requested]
    .map((name) => bundleLookup.get(normaliseName(name)))
    .filter((bundle) => bundle && !bundle.required);

  if (selectedOptional.length === 0 && requested.size === 0) {
    const canPrompt = stdout.isTTY && stdin.isTTY && optionalBundles.length > 0;
    if (canPrompt) {
      const rl = createInterface({ input: stdin, output: stdout });
      const optionsList = optionalBundles
        .map(
          (bundle, index) =>
            `${index + 1}. ${bundle.name} — ${bundle.description}`,
        )
        .join('\n');
      const answer = await rl.question(
        [
          'Select optional bundles (comma-separated numbers, leave blank for none):',
          optionsList,
          '> ',
        ].join('\n'),
      );
      rl.close();

      const indices = answer
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((num) => Number.isInteger(num) && num > 0);

      selectedOptional = indices
        .map((index) => optionalBundles[index - 1])
        .filter(Boolean);
    }
  }

  const selectedBundleNames = new Set(
    [...requiredBundles, ...selectedOptional].map((bundle) => bundle.name),
  );

  return bundles.filter((bundle) => selectedBundleNames.has(bundle.name));
};

const buildChecklist = (entityName, timestamp, bundles, tokens) => {
  const bundleNames = bundles.map((bundle) => bundle.name).join(', ');
  const lines = [
    `# Repository Service Checklist: ${entityName}`,
    '',
    '- Workflow reference: `agents/workflows/repository-service.workflow.md`',
    `- Generated by \`scripts/create-repository-service.mjs\` on ${timestamp}`,
    `- Selected bundles: ${bundleNames}`,
    '',
  ];

  for (const bundle of bundles) {
    if (!Array.isArray(bundle.checklist)) continue;
    const replacedLines = bundle.checklist.map((line) =>
      replaceTokens(line, tokens),
    );
    lines.push(...replacedLines, '');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.join('\n');
};

const main = async () => {
  const bundles = await loadManifest();

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage(bundles);
    process.exit(0);
  }

  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage(bundles);
    process.exit(1);
  }

  const { slug, dryRun, force, withBundles } = options;

  const replacements = {
    __ENTITY_SLUG__: slug,
    __ENTITY_PASCAL__: toPascalCase(slug),
    __ENTITY_CAMEL__: toCamelCase(slug),
    __ENTITY_CONSTANT__: toConstantCase(slug),
    __TIMESTAMP__: new Date().toISOString(),
  };

  if (!replacements.__ENTITY_PASCAL__ || !replacements.__ENTITY_CAMEL__) {
    console.error('Failed to derive entity name variants.');
    process.exit(1);
  }

  const selectedBundles = await selectBundles(bundles, withBundles);

  const createdFiles = [];

  for (const bundle of selectedBundles) {
    if (!Array.isArray(bundle.templates)) continue;
    for (const templateMeta of bundle.templates) {
      const templatePath = join(
        TEMPLATE_ROOT,
        'bundles',
        bundle.name,
        templateMeta.source,
      );
      const targetPath = join(
        OUTPUT_ROOT,
        replaceTokens(templateMeta.target, replacements),
      );

      const templateContent = await readFile(templatePath, 'utf-8');
      const rendered = replaceTokens(templateContent, replacements);

      try {
        await writeFileSafely(targetPath, rendered, { dryRun, force });
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }

      createdFiles.push({
        location: relative(OUTPUT_ROOT, targetPath),
        skipped: dryRun,
        bundle: bundle.name,
        action: 'created',
      });
    }
  }

  try {
    const schemasUpdate = await updateSchemasPackageJson(slug, {
      dryRun,
      force,
    });
    if (schemasUpdate.changed) {
      createdFiles.push({
        location: relative(OUTPUT_ROOT, schemasUpdate.location),
        skipped: dryRun,
        bundle: 'schemas-package',
        action: schemasUpdate.action,
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  try {
    const appLayerUpdate = await updateAppLayer(
      replacements.__ENTITY_PASCAL__,
      replacements.__ENTITY_CAMEL__,
      { dryRun },
    );
    if (appLayerUpdate.changed) {
      createdFiles.push({
        location: relative(OUTPUT_ROOT, appLayerUpdate.location),
        skipped: dryRun,
        bundle: 'app-layer',
        action: appLayerUpdate.action,
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  try {
    const lintRan = runLintFix({ dryRun });
    if (lintRan) {
      createdFiles.push({
        location: 'npm run lint:fix',
        skipped: dryRun,
        bundle: 'post-process',
        action: 'executed',
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const checklistTarget = join(
    OUTPUT_ROOT,
    'scripts/output/repository-service',
    `${slug}-checklist.md`,
  );
  const checklistContent = buildChecklist(
    replacements.__ENTITY_PASCAL__,
    replacements.__TIMESTAMP__,
    selectedBundles,
    replacements,
  );

  try {
    await writeFileSafely(checklistTarget, checklistContent, { dryRun, force });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  createdFiles.push({
    location: relative(OUTPUT_ROOT, checklistTarget),
    skipped: dryRun,
    bundle: 'checklist',
    action: 'created',
  });

  const action = dryRun ? 'Planned' : 'Created';
  console.log(
    `${action} repository-service scaffold for "${slug}" using bundles:`,
  );
  for (const file of createdFiles) {
    const prefix = file.skipped ? '[dry-run] ' : '';
    console.log(
      `  - ${prefix}${file.location} (${file.action} from ${file.bundle})`,
    );
  }

  if (!dryRun) {
    console.log(
      `Next steps: review ${relative(OUTPUT_ROOT, checklistTarget)} and work through the checklist.`,
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
