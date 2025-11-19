#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  IndentationText,
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
} from 'ts-morph';

import { replaceTokens, writeFileSafely } from './utils/fs-utils.mjs';
import { buildSlugVariants } from './utils/naming.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const templateRoot = join(__dirname, 'templates', 'node-server-handler');

const SUPPORTED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const TEMPLATE_DEFINITIONS = {
  basic: {
    handlerTemplate: 'basic/handler.ts.tpl',
    testTemplate: 'basic/handler.test.ts.tpl',
    requiresEntity: false,
    description: 'Minimal handler skeleton with placeholder response.',
  },
  'repo-get-by-id': {
    handlerTemplate: 'repo-get-by-id/handler.ts.tpl',
    testTemplate: 'repo-get-by-id/handler.test.ts.tpl',
    requiresEntity: true,
    description:
      'Repository-backed GET handler that loads an entity by identifier.',
  },
};

const ensureSlug = (value, label) => {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(
      `${label} "${value}" is invalid. Use kebab-case (letters, numbers, hyphen).`,
    );
  }
  return value;
};

const normalizeRoutePath = (route) => {
  if (!route) {
    throw new Error('Route path is required.');
  }
  if (!route.startsWith('/')) {
    throw new Error(
      `Route "${route}" is invalid. Routes must start with "/".`,
    );
  }
  return route;
};

const buildTemplateTokens = ({
  handlerSlug,
  method,
  entitySlug,
}) => {
  const handlerVariants = buildSlugVariants(handlerSlug);
  const tokens = {
    __HANDLER_SLUG__: handlerSlug,
    __HANDLER_PASCAL__: handlerVariants.pascalCase,
    __HANDLER_CAMEL__: handlerVariants.camelCase,
    __HANDLER_CONSTANT__: handlerVariants.constantCase,
    __HTTP_METHOD__: method.toUpperCase(),
  };

  if (entitySlug) {
    const entityVariants = buildSlugVariants(entitySlug);
    Object.assign(tokens, {
      __ENTITY_SLUG__: entityVariants.slug,
      __ENTITY_PASCAL__: entityVariants.pascalCase,
      __ENTITY_CAMEL__: entityVariants.camelCase,
      __ENTITY_CONSTANT__: entityVariants.constantCase,
    });
  }

  return { handlerVariants, tokens };
};

const loadTemplate = async (relativePath) =>
  readFile(join(templateRoot, relativePath), 'utf-8');

const renderTemplates = async (templateName, tokens) => {
  const definition = TEMPLATE_DEFINITIONS[templateName];
  const [handlerTemplate, testTemplate] = await Promise.all([
    loadTemplate(definition.handlerTemplate),
    loadTemplate(definition.testTemplate),
  ]);

  return {
    handlerContent: replaceTokens(handlerTemplate, tokens),
    testContent: replaceTokens(testTemplate, tokens),
  };
};

const relativeToRepo = (absolutePath) => relative(repoRoot, absolutePath);

const ensureHandlerImport = ({
  sourceFile,
  handlerIdentifier,
  moduleSpecifier,
  dryRun,
}) => {
  const existing = sourceFile
    .getImportDeclarations()
    .find(
      (declaration) => declaration.getModuleSpecifierValue() === moduleSpecifier,
    );

  if (existing) {
    const alreadyImported = existing
      .getNamedImports()
      .some((named) => named.getName() === handlerIdentifier);
    if (alreadyImported) {
      return { added: false };
    }

    if (!dryRun) {
      existing.addNamedImport(handlerIdentifier);
    }
    return { added: true };
  }

  const imports = sourceFile.getImportDeclarations();
  let insertIndex = imports.length;

  for (let index = imports.length - 1; index >= 0; index -= 1) {
    const declaration = imports[index];
    if (declaration.getModuleSpecifierValue().startsWith('@/handlers/')) {
      insertIndex = index + 1;
      break;
    }
  }

  if (!dryRun) {
    sourceFile.insertImportDeclaration(insertIndex, {
      namedImports: [handlerIdentifier],
      moduleSpecifier,
    });
  }

  return { added: true };
};

const findListenStatementIndex = (sourceFile) => {
  const statements = sourceFile.getStatements();
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (!Node.isExpressionStatement(statement)) continue;
    const expression = statement.getExpression();
    if (!Node.isCallExpression(expression)) continue;
    const callee = expression.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getExpression().getText() !== 'app') continue;
    if (callee.getName() !== 'listen') continue;
    return index;
  }
  throw new Error('Unable to locate app.listen statement in src/index.ts.');
};

const ensureRouteRegistration = ({
  sourceFile,
  method,
  routePath,
  middlewares,
  handlerIdentifier,
  dryRun,
}) => {
  const callExpressions = sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  );

  const conflictingCall = callExpressions.find((call) => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return false;
    }
    if (callee.getExpression().getText() !== 'app') {
      return false;
    }
    if (callee.getName().toLowerCase() !== method) {
      return false;
    }
    const [pathArg] = call.getArguments();
    if (!pathArg || pathArg.getKind() !== SyntaxKind.StringLiteral) {
      return false;
    }
    const routeMatches = pathArg.getText().slice(1, -1) === routePath;
    if (!routeMatches) {
      return false;
    }
    const lastArg = call.getArguments().at(-1);
    return lastArg?.getText() === handlerIdentifier;
  });

  if (conflictingCall) {
    throw new Error(
      `Route "${routePath}" with handler "${handlerIdentifier}" is already registered.`,
    );
  }

  const args = [`'${routePath}'`, ...middlewares, handlerIdentifier];
  const statement = `app.${method}(${args.join(', ')});`;
  const listenIndex = findListenStatementIndex(sourceFile);

  if (!dryRun) {
    sourceFile.insertStatements(listenIndex, `${statement}\n`);
  }

  return { added: true };
};

const updateServerIndex = async ({
  handlerIdentifier,
  handlerModulePath,
  method,
  routePath,
  middlewares,
  dryRun,
  report,
}) => {
  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      quoteKind: QuoteKind.Single,
      useTrailingCommas: true,
    },
    skipAddingFilesFromTsConfig: true,
  });

  const serverIndexPath = join(
    repoRoot,
    'apps',
    'node-server',
    'src',
    'index.ts',
  );
  const sourceFile = project.addSourceFileAtPath(serverIndexPath);

  const importResult = ensureHandlerImport({
    sourceFile,
    handlerIdentifier,
    moduleSpecifier: handlerModulePath,
    dryRun,
  });

  const routeResult = ensureRouteRegistration({
    sourceFile,
    method,
    routePath,
    middlewares,
    handlerIdentifier,
    dryRun,
  });

  if (!dryRun && (importResult.added || routeResult.added)) {
    await sourceFile.save();
  }

  if (importResult.added) {
    report({
      location: relativeToRepo(serverIndexPath),
      action: dryRun ? 'would-add import' : 'updated import',
      skipped: dryRun,
      kind: 'import',
      description: `added ${handlerIdentifier} import to apps/node-server/src/index.ts`,
    });
  }

  report({
    location: relativeToRepo(serverIndexPath),
    action: dryRun ? 'would-add route' : 'updated routes',
    skipped: dryRun,
    kind: 'route',
    description: `registered ${method.toUpperCase()} ${routePath} in apps/node-server/src/index.ts`,
  });
};

const defaultReporter = (entry) => {
  const prefix = entry.skipped ? '[dry-run] ' : '';
  console.log(`${prefix}${entry.description}`);
};

export const createNodeServerHandler = async ({
  handlerSlug,
  routePath,
  method = 'get',
  middlewares = [],
  template = 'basic',
  entitySlug,
  dryRun = false,
  force = false,
  onReport = defaultReporter,
}) => {
  const normalizedSlug = ensureSlug(handlerSlug, 'Handler slug');
  const normalizedMethod = method.toLowerCase();
  if (!SUPPORTED_METHODS.has(normalizedMethod)) {
    throw new Error(
      `Unsupported method "${method}". Supported methods: ${[
        ...SUPPORTED_METHODS,
      ].join(', ')}`,
    );
  }

  const templateDefinition = TEMPLATE_DEFINITIONS[template];
  if (!templateDefinition) {
    const available = Object.keys(TEMPLATE_DEFINITIONS)
      .map((key) => `"${key}"`)
      .join(', ');
    throw new Error(
      `Unknown template "${template}". Available templates: ${available}`,
    );
  }

  if (templateDefinition.requiresEntity) {
    ensureSlug(entitySlug, 'Entity slug (required for this template)');
  }

  const normalizedRoute = normalizeRoutePath(routePath ?? `/${normalizedSlug}`);
  const { handlerVariants, tokens } = buildTemplateTokens({
    handlerSlug: normalizedSlug,
    method: normalizedMethod,
    entitySlug,
  });

  const { handlerContent, testContent } = await renderTemplates(
    template,
    tokens,
  );

  const handlerPath = join(
    repoRoot,
    'apps',
    'node-server',
    'src',
    'handlers',
    `${handlerVariants.camelCase}.handler.ts`,
  );
  const testPath = join(
    repoRoot,
    'apps',
    'node-server',
    'src',
    '__tests__',
    'handlers',
    `${handlerVariants.camelCase}.handler.test.ts`,
  );

  const handlerWrite = await writeFileSafely(handlerPath, handlerContent, {
    dryRun,
    force,
    cwd: repoRoot,
  });
  onReport({
    location: relativeToRepo(handlerPath),
    action: handlerWrite.action,
    skipped: handlerWrite.skipped,
    kind: 'file',
    description: `${handlerWrite.skipped ? 'would write' : 'wrote'} handler ${relativeToRepo(
      handlerPath,
    )} (${templateDefinition.description})`,
  });

  const testWrite = await writeFileSafely(testPath, testContent, {
    dryRun,
    force,
    cwd: repoRoot,
  });
  onReport({
    location: relativeToRepo(testPath),
    action: testWrite.action,
    skipped: testWrite.skipped,
    kind: 'file',
    description: `${testWrite.skipped ? 'would write' : 'wrote'} test ${relativeToRepo(
      testPath,
    )}`,
  });

  const handlerIdentifier = `${handlerVariants.camelCase}RequestHandler`;
  await updateServerIndex({
    handlerIdentifier,
    handlerModulePath: `@/handlers/${handlerVariants.camelCase}.handler`,
    method: normalizedMethod,
    routePath: normalizedRoute,
    middlewares,
    dryRun,
    report: onReport,
  });
};

const USAGE = `
Usage: node scripts/create-node-server-handler.mjs <handler-slug> [options]

Options:
  --route <path>          Route path to register (default: /<handler-slug>)
  --method <verb>         HTTP method (get, post, put, patch, delete). Default: get
  --middlewares <list>    Comma-separated middleware identifiers to pass before the handler
  --template <name>       Template to use (default: basic)
  --entity <slug>         Entity slug (required for repo-get-by-id template)
  --dry-run               Preview changes without writing
  --force                 Overwrite existing files
  --help                  Show this help message

Available templates:
${Object.entries(TEMPLATE_DEFINITIONS)
  .map(([name, meta]) => `  - ${name}: ${meta.description}`)
  .join('\n')}
`.trim();

const parseCliArguments = (argv) => {
  const args = [];
  const flags = {
    dryRun: false,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      args.push(value);
      continue;
    }

    switch (value) {
      case '--help':
        flags.help = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--force':
        flags.force = true;
        break;
      case '--route':
      case '--method':
      case '--template':
      case '--entity':
      case '--middlewares': {
        const next = argv[++index];
        if (!next) {
          throw new Error(`Flag ${value} expects a value.`);
        }
        switch (value) {
          case '--route':
            flags.route = next;
            break;
          case '--method':
            flags.method = next;
            break;
          case '--template':
            flags.template = next;
            break;
          case '--entity':
            flags.entity = next;
            break;
          case '--middlewares':
            flags.middlewares = next
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean);
            break;
          default:
            break;
        }
        break;
      }
      default:
        throw new Error(`Unknown flag "${value}". Use --help to see options.`);
    }
  }

  if (args.length === 0 && !flags.help) {
    throw new Error('Handler slug argument is required.');
  }

  return { slug: args[0], flags };
};

const main = async () => {
  try {
    const { slug, flags } = parseCliArguments(process.argv.slice(2));

    if (flags.help) {
      console.log(USAGE);
      return;
    }

    await createNodeServerHandler({
      handlerSlug: slug,
      routePath: flags.route,
      method: flags.method,
      middlewares: flags.middlewares,
      template: flags.template,
      entitySlug: flags.entity,
      dryRun: flags.dryRun,
      force: flags.force,
    });
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === __filename) {
  main();
}
