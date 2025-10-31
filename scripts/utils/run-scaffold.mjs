import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

import { loadManifest, selectBundles } from './bundles.mjs';
import { parseCliArguments } from './cli-args.mjs';
import { writeFileSafely, replaceTokens, runCommand } from './fs-utils.mjs';
import { executeHookSequence } from './hooks.mjs';
import { buildSlugVariants } from './naming.mjs';
import { resolveTokens } from './token-resolvers.mjs';

const buildUsage = (config, manifest) => {
  const lines = [...config.usage];
  const optionalBundles = manifest.bundles.filter((bundle) => !bundle.required);

  if (optionalBundles.length > 0) {
    lines.push('', 'Optional bundles:');
    for (const bundle of optionalBundles) {
      lines.push(`  - ${bundle.name}: ${bundle.description}`);
    }
  }

  return lines.join('\n');
};

const ensureHookSuccess = (stage, hookResult) => {
  if (!hookResult.failedHook) return;

  const failed = hookResult.results.find(
    (result) => result.name === hookResult.failedHook,
  );
  const message = failed?.notes ?? `Hook "${hookResult.failedHook}" failed.`;
  throw new Error(`[${stage}] ${message}`);
};

export const runScaffold = async ({ argv, config }) => {
  const manifest = await loadManifest(config.manifestPath);
  let parsedArgs;

  try {
    parsedArgs = parseCliArguments(argv, config);
  } catch (error) {
    console.error(error.message);
    console.log(buildUsage(config, manifest));
    error.alreadyReported = true;
    throw error;
  }

  if (parsedArgs.helpRequested) {
    console.log(buildUsage(config, manifest));
    return;
  }

  const slug = parsedArgs.slug;
  const slugVariants = buildSlugVariants(slug);
  const outputRoot =
    config.outputRoot ?? resolve(config.configDir, '..', '..');

  const selectedBundles = await selectBundles({
    bundles: manifest.bundles,
    requestedNames: parsedArgs.flags.withBundles ?? [],
    input: process.stdin,
    output: process.stdout,
    interactive: config.interactive?.bundlePrompt !== false,
  });

  const tokens = resolveTokens(slug, config.tokens);
  const reportEntries = [];

  const context = {
    config,
    manifest,
    slug,
    slugVariants,
    tokens,
    bundles: manifest.bundles,
    selectedBundles,
    flags: parsedArgs.flags,
    paths: {
      configDir: config.configDir,
      templateRoot: config.templateRoot,
      manifestPath: config.manifestPath,
      outputRoot,
    },
    report: reportEntries,
    addReportEntry: (entry) => reportEntries.push(entry),
    stdin: process.stdin,
    stdout: process.stdout,
    helpers: {
      applyTokens: (value, overrides = {}) =>
        replaceTokens(value, { ...tokens, ...overrides }),
      writeFile: (targetPath, content) =>
        writeFileSafely(targetPath, content, {
          dryRun: parsedArgs.flags.dryRun,
          force: parsedArgs.flags.force,
          cwd: outputRoot,
        }),
      runCommand: (command, args) =>
        runCommand(command, args, {
          cwd: outputRoot,
          dryRun: parsedArgs.flags.dryRun,
        }),
      readTemplate: (relativePath) =>
        readFile(join(config.templateRoot, relativePath), 'utf-8'),
      readFile: (absolutePath) => readFile(absolutePath, 'utf-8'),
      replaceTokens,
      relativeToOutput: (targetPath) => relative(outputRoot, targetPath),
      resolveOutput: (...segments) => join(outputRoot, ...segments),
    },
  };

  const preResult = await executeHookSequence(
    'preScaffold',
    config.hooks.preScaffold,
    context,
  );
  ensureHookSuccess('preScaffold', preResult);

  const renderResult = await executeHookSequence(
    'renderTemplates',
    config.hooks.renderTemplates,
    context,
  );
  ensureHookSuccess('renderTemplates', renderResult);

  const postResult = await executeHookSequence(
    'postScaffold',
    config.hooks.postScaffold,
    context,
  );
  ensureHookSuccess('postScaffold', postResult);

  const bundleNames = selectedBundles.map((bundle) => bundle.name).join(', ');
  const actionVerb = parsedArgs.flags.dryRun ? 'Planned' : 'Created';

  console.log(`${actionVerb} ${config.name} scaffold for "${slug}" using bundles:`);
  for (const entry of reportEntries) {
    const prefix = entry.skipped ? '[dry-run] ' : '';
    const location = entry.location ?? entry.description ?? 'unknown';
    const bundle = entry.bundle ? ` from ${entry.bundle}` : '';
    console.log(`  - ${prefix}${location} (${entry.action}${bundle})`);
  }

  if (!parsedArgs.flags.dryRun && config.nextSteps?.length) {
    for (const message of config.nextSteps) {
      const resolved = replaceTokens(message, {
        ...tokens,
        __BUNDLES__: bundleNames,
        __SELECTED_BUNDLES__: bundleNames,
      });
      console.log(resolved);
    }
  }
};
