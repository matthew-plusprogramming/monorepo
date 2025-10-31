import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const REQUIRED_HOOK_STAGES = ['preScaffold', 'renderTemplates', 'postScaffold'];

const assertArray = (value, message) => {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
};

export const loadScaffoldConfig = async (configPath) => {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);

  const raw = await readFile(absolutePath, 'utf-8');
  const data = JSON.parse(raw);

  if (!data.name || typeof data.name !== 'string') {
    throw new Error(`Scaffold config missing "name": ${absolutePath}`);
  }
  if (!data.templateRoot || typeof data.templateRoot !== 'string') {
    throw new Error(`Scaffold config missing "templateRoot": ${absolutePath}`);
  }
  if (!data.manifest || typeof data.manifest !== 'string') {
    throw new Error(`Scaffold config missing "manifest": ${absolutePath}`);
  }

  assertArray(
    data.usage,
    `Scaffold config "${data.name}" missing "usage" list.`,
  );
  assertArray(
    data.flags,
    `Scaffold config "${data.name}" missing "flags" definitions.`,
  );
  assertArray(
    data.tokens,
    `Scaffold config "${data.name}" missing "tokens" definitions.`,
  );

  const hooks = data.hooks ?? {};
  const normalizedHooks = {};
  for (const stage of REQUIRED_HOOK_STAGES) {
    const list = hooks[stage] ?? [];
    assertArray(
      list,
      `Scaffold config "${data.name}" has invalid hook list for "${stage}".`,
    );
    normalizedHooks[stage] = list;
  }

  return {
    ...data,
    configPath: absolutePath,
    configDir,
    templateRoot: resolve(configDir, data.templateRoot),
    manifestPath: resolve(configDir, data.manifest),
    hooks: normalizedHooks,
  };
};

