export const slugToSegments = (slug) =>
  String(slug)
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

export const toPascalCase = (slug) =>
  slugToSegments(slug)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');

export const toCamelCase = (slug) => {
  const [first, ...rest] = slugToSegments(slug);
  if (!first) return '';
  const pascalTail = rest
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
  return `${first}${pascalTail}`;
};

export const toConstantCase = (slug) =>
  slugToSegments(slug)
    .map((segment) => segment.toUpperCase())
    .join('_');

export const buildSlugVariants = (slug) => ({
  slug,
  pascalCase: toPascalCase(slug),
  camelCase: toCamelCase(slug),
  constantCase: toConstantCase(slug),
});
