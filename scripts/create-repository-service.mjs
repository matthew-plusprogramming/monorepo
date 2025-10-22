#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(__dirname, 'templates', 'repository-service');
const OUTPUT_ROOT = resolve(__dirname, '..');

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
  slugToSegments(slug).map((segment) => segment.toUpperCase()).join('_');

const usage = () => {
  console.log(
    [
      'Usage: node scripts/create-repository-service.mjs <entity-slug> [--dry-run] [--force]',
      '',
      'Examples:',
      '  node scripts/create-repository-service.mjs user-profile',
      '  node scripts/create-repository-service.mjs order --dry-run',
    ].join('\n'),
  );
};

const parseArgs = (rawArgs) => {
  const options = {
    dryRun: false,
    force: false,
    slug: '',
  };

  for (const arg of rawArgs) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
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

const main = async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }

  const { slug, dryRun, force } = options;

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

  const manifest = [
    {
      template: join(TEMPLATE_ROOT, 'schema', 'index.ts.tpl'),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        'index.ts',
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'schema',
        'constants',
        'index.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        'constants',
        'index.ts',
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'schema',
        'constants',
        '__ENTITY_CAMEL__.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        'constants',
        `${replacements.__ENTITY_CAMEL__}.ts`,
      ),
    },
    {
      template: join(TEMPLATE_ROOT, 'schema', '__ENTITY_CAMEL__.ts.tpl'),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        `${replacements.__ENTITY_CAMEL__}.ts`,
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'schema',
        '__ENTITY_CAMEL__Create.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        `${replacements.__ENTITY_CAMEL__}Create.ts`,
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'schema',
        '__ENTITY_CAMEL__.schemas.test.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'packages/core/schemas/schemas',
        slug,
        `${replacements.__ENTITY_CAMEL__}.schemas.test.ts`,
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'service',
        'repository.service.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'apps/node-server/src/services',
        `${replacements.__ENTITY_CAMEL__}Repo.service.ts`,
      ),
    },
    {
      template: join(TEMPLATE_ROOT, 'fake', 'repository.fake.ts.tpl'),
      target: join(
        OUTPUT_ROOT,
        'apps/node-server/src/__tests__/fakes',
        `${replacements.__ENTITY_CAMEL__}Repo.ts`,
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'cdk',
        '__ENTITY_CAMEL__-table.constants.ts.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'cdk/backend-server-cdk/src/stacks/api-stack',
        `${replacements.__ENTITY_CAMEL__}-table.constants.ts`,
      ),
    },
    {
      template: join(TEMPLATE_ROOT, 'cdk', 'generate-table.ts.tpl'),
      target: join(
        OUTPUT_ROOT,
        'cdk/backend-server-cdk/src/stacks/api-stack',
        `generate-${slug}-table.ts`,
      ),
    },
    {
      template: join(
        TEMPLATE_ROOT,
        'checklist',
        'checklist.md.tpl',
      ),
      target: join(
        OUTPUT_ROOT,
        'scripts/output/repository-service',
        `${slug}-checklist.md`,
      ),
    },
  ];

  const checklistTarget =
    manifest[manifest.length - 1]?.target ??
    join(
      OUTPUT_ROOT,
      'scripts/output/repository-service',
      `${slug}-checklist.md`,
    );

  const createdFiles = [];

  for (const entry of manifest) {
    const templateContent = await readFile(entry.template, 'utf-8');
    const rendered = replaceTokens(templateContent, replacements);

    try {
      await writeFileSafely(entry.target, rendered, { dryRun, force });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }

    const location = relative(OUTPUT_ROOT, entry.target);
    createdFiles.push({ location, skipped: dryRun });
  }

  const action = dryRun ? 'Planned' : 'Created';
  console.log(
    `${action} repository-service scaffold for "${slug}" using:`,
  );
  for (const file of createdFiles) {
    console.log(`  - ${file.skipped ? '[dry-run] ' : ''}${file.location}`);
  }
  if (!dryRun) {
    console.log('');
    console.log(`Next steps: review ${relative(OUTPUT_ROOT, checklistTarget)} and work through the checklist.`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
