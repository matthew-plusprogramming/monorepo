#!/usr/bin/env node

/**
 * Validate spec files against JSON schemas in .claude/specs/schema/.
 *
 * Logic:
 * 1. Accept spec file path as argument
 * 2. Determine spec type from path or frontmatter:
 *    - atomic/*.md -> atomic-spec.schema.json
 *    - manifest.json -> spec-group.schema.json
 *    - Files with 'workstream' in frontmatter -> workstream-spec.schema.json
 *    - Files with 'master' type -> master-spec.schema.json
 * 3. Parse YAML frontmatter from markdown
 * 4. Validate against appropriate schema
 * 5. Report validation errors clearly
 * 6. Exit 0 on valid, non-zero on invalid
 *
 * Usage:
 *   node spec-schema-validate.mjs <spec-file>
 *
 * Exit codes:
 *   0 - Validation passed
 *   1 - Validation failed
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Find the .claude directory by walking up from script location
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    // Check if we're inside .claude
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Default to relative path from cwd
  return join(process.cwd(), '.claude');
}

const CLAUDE_DIR = findClaudeDir();
const SCHEMA_DIR = join(CLAUDE_DIR, 'specs', 'schema');

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no frontmatter found.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yamlContent = match[1];
  const fields = {};

  let currentKey = null;
  let currentValue = [];
  let inArray = false;
  let inBracketedArray = false;
  let bracketedArrayContent = '';

  for (const line of yamlContent.split('\n')) {
    // Handle multi-line bracketed array collection (prettier format)
    // e.g.:
    //   requirements_refs:
    //     [
    //       REQ-SEC-014,
    //       REQ-SEC-015,
    //     ]
    if (inBracketedArray) {
      bracketedArrayContent += ' ' + line.trim();
      if (line.trim().endsWith(']')) {
        // End of bracketed array -- parse it
        const inner = bracketedArrayContent.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
        fields[currentKey] = inner
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s);
        inBracketedArray = false;
        bracketedArrayContent = '';
        inArray = false;
      }
      continue;
    }

    // Handle array items (YAML list format: - item)
    if (line.match(/^\s*-\s/)) {
      if (inArray && currentKey) {
        const value = line.replace(/^\s*-\s*/, '').trim();
        if (!fields[currentKey]) fields[currentKey] = [];
        // Handle object array items like "- id: foo"
        if (value.includes(':')) {
          const obj = {};
          const colonIdx = value.indexOf(':');
          obj[value.slice(0, colonIdx).trim()] = value.slice(colonIdx + 1).trim();
          fields[currentKey].push(obj);
        } else {
          fields[currentKey].push(value);
        }
      }
      continue;
    }

    // Check if this is the start of a multi-line bracketed array (indented "[")
    if (inArray && currentKey && line.trim() === '[') {
      inBracketedArray = true;
      bracketedArrayContent = '[';
      continue;
    }

    // Check if this is a single-line indented bracketed array: "  [item1, item2]"
    if (inArray && currentKey && line.trim().startsWith('[') && line.trim().endsWith(']')) {
      const arrayContent = line.trim().slice(1, -1);
      fields[currentKey] = arrayContent
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s);
      inArray = false;
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key) {
      currentKey = key;
      // Check if this starts an array (empty value followed by array items)
      if (value === '' || value === '[]') {
        inArray = true;
        fields[key] = value === '[]' ? [] : undefined;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array like [REQ-001, REQ-002]
        const arrayContent = value.slice(1, -1);
        fields[key] = arrayContent
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s);
        inArray = false;
      } else {
        fields[key] = value;
        inArray = false;
      }
    }
  }

  return fields;
}

/**
 * Determine spec type from file path and frontmatter.
 */
function determineSpecType(filePath, frontmatter) {
  const fileName = basename(filePath);
  const dirName = basename(dirname(filePath));

  // manifest.json files
  if (fileName === 'manifest.json') {
    return 'spec-group';
  }

  // Files in atomic/ directory
  if (dirName === 'atomic' || filePath.includes('/atomic/')) {
    return 'atomic-spec';
  }

  // Check frontmatter for type hints
  if (frontmatter) {
    // Check for workstream indicators
    if (
      frontmatter.owner !== undefined ||
      frontmatter.scope !== undefined ||
      frontmatter.implementation_status !== undefined
    ) {
      // Could be workstream or task spec
      if (frontmatter.workstreams || frontmatter.gates) {
        return 'master-spec';
      }
      if (frontmatter.contracts !== undefined || frontmatter.dependencies !== undefined) {
        return 'workstream-spec';
      }
    }

    // Check for master spec indicators
    if (frontmatter.workstreams || frontmatter.gates) {
      return 'master-spec';
    }

    // Check ID patterns
    if (frontmatter.id) {
      if (frontmatter.id.startsWith('as-')) return 'atomic-spec';
      if (frontmatter.id.startsWith('ws-')) return 'workstream-spec';
      if (frontmatter.id.startsWith('ms-')) return 'master-spec';
    }
  }

  // Default: can't determine type
  return null;
}

/**
 * Load JSON schema from file.
 */
function loadSchema(schemaName) {
  const schemaPath = join(SCHEMA_DIR, `${schemaName}.schema.json`);

  if (!existsSync(schemaPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(schemaPath, 'utf-8'));
  } catch (err) {
    console.error(`Error loading schema ${schemaPath}: ${err.message}`);
    return null;
  }
}

/**
 * Fields that typically live in frontmatter vs markdown body for different spec types.
 * This allows us to validate only the frontmatter portion of markdown files.
 */
const FRONTMATTER_FIELDS = {
  'atomic-spec': ['id', 'title', 'requirements_refs', 'status', 'spec_group', 'parent_spec_section'],
  'workstream-spec': ['id', 'title', 'owner', 'scope', 'dependencies', 'contracts', 'status', 'implementation_status'],
  'master-spec': ['id', 'title', 'workstreams', 'contracts', 'gates', 'status'],
  'spec-group': null, // JSON file - validate all fields
};

/**
 * Required markdown sections for different spec types.
 */
const REQUIRED_MARKDOWN_SECTIONS = {
  'atomic-spec': ['## Description', '## Acceptance Criteria', '## Test Strategy', '## Atomicity Justification'],
  'workstream-spec': ['## Context', '## Requirements', '## Task List'],
  'master-spec': ['## Context', '## Workstreams'],
};

/**
 * Simple JSON schema validator.
 * Validates required fields, types, enums, and patterns.
 * @param {object} data - Data to validate
 * @param {object} schema - JSON schema
 * @param {string} path - Current path for error messages
 * @param {string[]} onlyFields - If provided, only validate these fields
 */
function validateAgainstSchema(data, schema, path = '', onlyFields = null) {
  const errors = [];

  if (!schema || !data) {
    return errors;
  }

  // Check required fields (only those in onlyFields if specified)
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      // Skip fields not in frontmatter for markdown files
      if (onlyFields && !onlyFields.includes(field)) {
        continue;
      }
      if (data[field] === undefined) {
        errors.push(`${path}${field}: required field is missing`);
      }
    }
  }

  // Check properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      // Skip fields not in onlyFields if specified
      if (onlyFields && !onlyFields.includes(key)) {
        continue;
      }

      const value = data[key];
      const propPath = path ? `${path}.${key}` : key;

      if (value === undefined) continue;

      // Type checking
      if (propSchema.type) {
        const types = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
        const valueType = Array.isArray(value) ? 'array' : typeof value;
        const typeMatch = types.some((t) => {
          if (t === 'array') return Array.isArray(value);
          if (t === 'null') return value === null;
          if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
          return typeof value === t;
        });

        if (!typeMatch) {
          errors.push(`${propPath}: expected type ${types.join('|')}, got ${valueType}`);
        }
      }

      // Enum checking
      if (propSchema.enum && !propSchema.enum.includes(value)) {
        errors.push(`${propPath}: value '${value}' not in allowed values [${propSchema.enum.join(', ')}]`);
      }

      // Pattern checking
      if (propSchema.pattern && typeof value === 'string') {
        const regex = new RegExp(propSchema.pattern);
        if (!regex.test(value)) {
          errors.push(`${propPath}: value '${value}' does not match pattern ${propSchema.pattern}`);
        }
      }

      // Array items
      if (propSchema.type === 'array' && propSchema.items && Array.isArray(value)) {
        if (propSchema.minItems && value.length < propSchema.minItems) {
          errors.push(`${propPath}: array must have at least ${propSchema.minItems} items`);
        }
        for (let i = 0; i < value.length; i++) {
          const itemErrors = validateAgainstSchema(value[i], propSchema.items, `${propPath}[${i}]`);
          errors.push(...itemErrors);
        }
      }

      // Nested objects
      if (propSchema.type === 'object' && propSchema.properties && typeof value === 'object' && !Array.isArray(value)) {
        const nestedErrors = validateAgainstSchema(value, propSchema, propPath);
        errors.push(...nestedErrors);
      }
    }
  }

  return errors;
}

/**
 * Validate required markdown sections are present.
 */
function validateMarkdownSections(content, specType) {
  const errors = [];
  const requiredSections = REQUIRED_MARKDOWN_SECTIONS[specType];

  if (!requiredSections) {
    return errors;
  }

  for (const section of requiredSections) {
    const sectionPattern = new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'im');
    if (!sectionPattern.test(content)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  return errors;
}

/**
 * Validate a spec file.
 */
function validateSpecFile(filePath) {
  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings };
  }

  const content = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);

  // Handle JSON files (manifest.json)
  if (fileName.endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(content);
    } catch (err) {
      errors.push(`Invalid JSON: ${err.message}`);
      return { errors, warnings };
    }

    const specType = determineSpecType(filePath, null);
    if (!specType) {
      warnings.push('Could not determine spec type from path');
      return { errors, warnings };
    }

    const schema = loadSchema(specType);
    if (!schema) {
      warnings.push(`Schema not found for type: ${specType}`);
      return { errors, warnings };
    }

    const schemaErrors = validateAgainstSchema(data, schema);
    errors.push(...schemaErrors);

    return { errors, warnings };
  }

  // Handle Markdown files
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    warnings.push('No YAML frontmatter found');
    return { errors, warnings };
  }

  const specType = determineSpecType(filePath, frontmatter);

  if (!specType) {
    warnings.push('Could not determine spec type from path or frontmatter');
    return { errors, warnings };
  }

  const schema = loadSchema(specType);

  if (!schema) {
    warnings.push(`Schema not found for type: ${specType}`);
    return { errors, warnings };
  }

  console.error(`Validating as ${specType}...`);

  // For markdown files, only validate frontmatter fields
  const frontmatterFields = FRONTMATTER_FIELDS[specType];
  const schemaErrors = validateAgainstSchema(frontmatter, schema, '', frontmatterFields);
  errors.push(...schemaErrors);

  // Also validate required markdown sections
  const sectionErrors = validateMarkdownSections(content, specType);
  errors.push(...sectionErrors);

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: spec-schema-validate.mjs <spec-file>');
    console.error('Error: No file provided.');
    process.exit(1);
  }

  const filePath = resolve(args[0]);
  const { errors, warnings } = validateSpecFile(filePath);

  // Print warnings
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

  // Print errors
  for (const error of errors) {
    console.error(`Error: ${error}`);
  }

  if (errors.length > 0) {
    console.error(`\nValidation failed with ${errors.length} error(s).`);
    process.exit(1);
  }

  console.error(`Validation passed for ${basename(filePath)}.`);
  process.exit(0);
}

main();
