const STAGES = new Set(['preScaffold', 'renderTemplates', 'postScaffold']);

const hookRegistry = new Map();

export const registerHook = (stage, name, handler) => {
  if (!STAGES.has(stage)) {
    throw new Error(`Unsupported hook stage "${stage}".`);
  }
  if (hookRegistry.has(name)) {
    throw new Error(`Hook "${name}" is already registered.`);
  }
  hookRegistry.set(name, { stage, handler });
};

export const resolveHooksForStage = (stage, hookNames = []) => {
  if (!STAGES.has(stage)) {
    throw new Error(`Unsupported hook stage "${stage}".`);
  }

  return hookNames.map((name) => {
    const entry = hookRegistry.get(name);
    if (!entry) {
      throw new Error(`Unknown hook "${name}" requested for stage "${stage}".`);
    }
    if (entry.stage !== stage) {
      throw new Error(
        `Hook "${name}" is registered for stage "${entry.stage}" but requested for "${stage}".`,
      );
    }
    return { name, handler: entry.handler };
  });
};

export const executeHookSequence = async (stage, hookNames, context) => {
  const hooks = resolveHooksForStage(stage, hookNames);
  const results = [];

  for (const { name, handler } of hooks) {
    try {
      const result = await handler(context);
      const status = result?.status ?? 'ok';
      const notes = result?.notes;
      results.push({ name, status, notes });

      if (status === 'error') {
        return { results, failedHook: name };
      }
    } catch (error) {
      results.push({ name, status: 'error', notes: error.message });
      return { results, failedHook: name };
    }
  }

  return { results };
};

