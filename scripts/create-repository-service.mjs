#!/usr/bin/env node

import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadScaffoldConfig } from './utils/config.mjs';
import { registerCoreHooks } from './utils/hooks/core.mjs';
import { runScaffold } from './utils/run-scaffold.mjs';
import { registerRepositoryServiceHooks } from './scaffolds/repository-service/hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const main = async () => {
  registerCoreHooks();
  registerRepositoryServiceHooks();

  const configPath = join(__dirname, 'scaffolds', 'repository-service.config.json');
  const config = await loadScaffoldConfig(configPath);

  await runScaffold({
    argv: process.argv.slice(2),
    config,
  });
};

main().catch((error) => {
  if (error?.alreadyReported) {
    process.exit(1);
  }

  console.error(error?.message ?? error);
  process.exit(1);
});
