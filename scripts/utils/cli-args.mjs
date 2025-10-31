const HELP_FLAGS = new Set(['-h', '--help']);

const ensureFlagShape = (flag) => {
  if (!flag.key || typeof flag.key !== 'string') {
    throw new Error(`Flag definition is missing "key": ${JSON.stringify(flag)}`);
  }
  if (!flag.long || typeof flag.long !== 'string') {
    throw new Error(
      `Flag definition "${flag.key}" missing "long" property (e.g. --dry-run).`,
    );
  }
  if (!flag.type || !['boolean', 'string', 'list'].includes(flag.type)) {
    throw new Error(
      `Flag definition "${flag.key}" has unsupported type "${flag.type}".`,
    );
  }
};

const normaliseListValue = (value, separator = ',') =>
  value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);

export const parseCliArguments = (rawArgs, config) => {
  const flags = config.flags ?? [];
  const flagLookup = new Map();
  const result = {
    flags: {},
    slug: '',
    helpRequested: false,
  };

  for (const flag of flags) {
    ensureFlagShape(flag);
    flagLookup.set(flag.long, flag);
    for (const alias of flag.aliases ?? []) {
      flagLookup.set(alias, flag);
    }

    if (flag.type === 'boolean') {
      result.flags[flag.key] = flag.default ?? false;
    } else if (flag.type === 'list') {
      const defaultList = flag.default ?? [];
      result.flags[flag.key] = Array.isArray(defaultList)
        ? [...defaultList]
        : [];
    } else {
      result.flags[flag.key] = flag.default ?? null;
    }
  }

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (HELP_FLAGS.has(arg)) {
      result.helpRequested = true;
      return result;
    }

    const [flagCandidate, inlineValue] = arg.split('=');
    const flagDef = flagLookup.get(flagCandidate);

    if (flagDef) {
      if (flagDef.type === 'boolean') {
        result.flags[flagDef.key] = true;
        continue;
      }

      const hasInline = inlineValue !== undefined;
      let value = inlineValue;

      if (!hasInline) {
        value = rawArgs[index + 1];
        if (value === undefined) {
          throw new Error(`Missing value for ${flagDef.long}`);
        }
        index += 1;
      }

      if (flagDef.type === 'list') {
        const separator = flagDef.separator ?? ',';
        const items = normaliseListValue(value, separator);
        result.flags[flagDef.key].push(...items);
      } else {
        result.flags[flagDef.key] = value;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (result.slug) {
      throw new Error('Only a single entity slug is supported.');
    }

    result.slug = arg;
  }

  if (!result.slug) {
    throw new Error('Missing entity slug.');
  }

  const slugRules = config.arguments?.slug;
  if (slugRules?.pattern) {
    const matcher = new RegExp(slugRules.pattern);
    if (!matcher.test(result.slug)) {
      throw new Error(
        slugRules.errorMessage ??
          `Invalid slug "${result.slug}". Expected pattern: ${slugRules.pattern}`,
      );
    }
  }

  if (config.normalise?.withBundles === 'lowercase') {
    result.flags.withBundles = (result.flags.withBundles ?? []).map((item) =>
      item.toLowerCase(),
    );
  }

  return result;
};

