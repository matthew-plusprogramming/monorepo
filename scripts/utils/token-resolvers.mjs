import { toCamelCase, toConstantCase, toPascalCase } from './naming.mjs';

const RESOLVERS = {
  slug: ({ slug }) => slug,
  pascalCase: ({ slug }) => toPascalCase(slug),
  camelCase: ({ slug }) => toCamelCase(slug),
  constantCase: ({ slug }) => toConstantCase(slug),
  timestamp: () => new Date().toISOString(),
};

export const resolveTokens = (slug, tokenDefinitions = []) => {
  const tokens = {};
  for (const token of tokenDefinitions) {
    if (!token.name || typeof token.name !== 'string') {
      throw new Error(
        `Token definition is missing "name": ${JSON.stringify(token)}`,
      );
    }
    if (!token.resolver || typeof token.resolver !== 'string') {
      throw new Error(
        `Token "${token.name}" missing "resolver" identifier.`,
      );
    }

    const resolver = RESOLVERS[token.resolver];
    if (!resolver) {
      throw new Error(
        `Unknown token resolver "${token.resolver}" for token "${token.name}".`,
      );
    }

    tokens[token.name] = resolver({ slug });
  }
  return tokens;
};

