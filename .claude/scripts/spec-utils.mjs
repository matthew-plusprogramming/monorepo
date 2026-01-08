import { readFileSync } from 'node:fs';

const FRONT_MATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

const stripQuotes = (value) => {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const parseSimpleYaml = (raw) => {
  const data = {};
  const errors = [];
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  let currentIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;

    if (currentKey && indent <= currentIndent) {
      currentKey = null;
      currentIndent = -1;
    }

    if (trimmed.startsWith('- ')) {
      if (!currentKey || !Array.isArray(data[currentKey])) {
        errors.push(`Unexpected list item at line ${index + 1}.`);
        continue;
      }
      const itemRaw = trimmed.slice(2).trim();
      if (!itemRaw) {
        data[currentKey].push('');
        continue;
      }
      const itemMatch = itemRaw.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
      if (itemMatch) {
        data[currentKey].push({
          [itemMatch[1]]: stripQuotes(itemMatch[2]),
        });
      } else {
        data[currentKey].push(stripQuotes(itemRaw));
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      errors.push(`Unrecognized line at ${index + 1}: ${trimmed}`);
      continue;
    }
    const key = match[1];
    const value = match[2];

    if (value === '') {
      data[key] = [];
      currentKey = key;
      currentIndent = indent;
      continue;
    }

    if (value === '[]') {
      data[key] = [];
      continue;
    }

    data[key] = stripQuotes(value);
  }

  return { data, errors };
};

export const parseFrontMatter = (content) => {
  const match = content.match(FRONT_MATTER_REGEX);
  if (!match) {
    return { data: null, body: content, errors: ['Missing YAML front matter.'] };
  }
  const raw = match[1];
  const body = content.slice(match[0].length);
  const { data, errors } = parseSimpleYaml(raw);
  return { data, body, errors };
};

export const parseYamlList = (content) => {
  const items = [];
  const errors = [];
  const lines = content.split(/\r?\n/);
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (current) {
        items.push(current);
      }
      current = {};
      const remainder = trimmed.slice(2).trim();
      if (remainder) {
        const match = remainder.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
        if (match) {
          current[match[1]] = stripQuotes(match[2]);
        } else {
          errors.push(`Unrecognized list item at line ${index + 1}.`);
        }
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (match && current) {
      current[match[1]] = stripQuotes(match[2]);
      continue;
    }

    errors.push(`Unrecognized line at ${index + 1}: ${trimmed}`);
  }

  if (current) {
    items.push(current);
  }

  return { items, errors };
};

export const normalizeSection = (value) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const extractHeadings = (body) => {
  const headings = new Set();
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (!match) continue;
    headings.add(normalizeSection(match[1]));
  }
  return headings;
};

export const readTextFile = (path) => readFileSync(path, 'utf8');
