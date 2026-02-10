#!/usr/bin/env node

/**
 * Validate artifacts.json registry against its schema.
 *
 * Logic:
 * 1. Accept registry file path as argument (defaults to .claude/registry/artifacts.json)
 * 2. Parse JSON
 * 3. Validate against .claude/registry/schema.json
 * 4. Perform semantic validations (supersession consistency, path existence)
 * 5. Report validation errors
 * 6. Exit 0 on valid, non-zero on invalid
 *
 * Usage:
 *   node registry-artifact-validate.mjs [artifacts.json]
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
const SCHEMA_PATH = join(CLAUDE_DIR, 'registry', 'schema.json');
const DEFAULT_REGISTRY_PATH = join(CLAUDE_DIR, 'registry', 'artifacts.json');

/**
 * Load the registry schema.
 */
function loadSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    return { error: `Schema file not found: ${SCHEMA_PATH}` };
  }

  try {
    return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  } catch (err) {
    return { error: `Error loading schema: ${err.message}` };
  }
}

/**
 * Simple JSON schema validator.
 * Validates required fields, types, enums, and patterns.
 */
function validateAgainstSchema(data, schema, path = '') {
  const errors = [];

  if (!schema || !data) {
    return errors;
  }

  // Check required fields
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (data[field] === undefined) {
        errors.push(`${path}${field}: required field is missing`);
      }
    }
  }

  // Check properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
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

      // Format checking (basic)
      if (propSchema.format && typeof value === 'string') {
        if (propSchema.format === 'date-time') {
          const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
          if (!dateRegex.test(value)) {
            errors.push(`${propPath}: value '${value}' is not a valid date-time format`);
          }
        }
      }

      // Array items - handle $ref
      if (propSchema.type === 'array' && propSchema.items && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          // Resolve $ref if present
          let itemSchema = propSchema.items;
          if (itemSchema.$ref) {
            // Simple $ref resolution for local definitions
            const refPath = itemSchema.$ref.replace('#/$defs/', '');
            itemSchema = schema.$defs?.[refPath] || itemSchema;
          }
          const itemErrors = validateAgainstSchema(value[i], itemSchema, `${propPath}[${i}].`);
          errors.push(...itemErrors);
        }
      }

      // Nested objects
      if (propSchema.type === 'object' && propSchema.properties && typeof value === 'object' && !Array.isArray(value)) {
        const nestedErrors = validateAgainstSchema(value, propSchema, `${propPath}.`);
        errors.push(...nestedErrors);
      }
    }
  }

  return errors;
}

/**
 * Perform semantic validations beyond schema.
 */
function validateSemantics(data, claudeDir) {
  const errors = [];
  const warnings = [];

  if (!data.spec_groups || !Array.isArray(data.spec_groups)) {
    return { errors, warnings };
  }

  const idSet = new Set();
  const idToEntry = new Map();

  // Build ID map and check for duplicates
  for (const entry of data.spec_groups) {
    if (idSet.has(entry.id)) {
      errors.push(`Duplicate spec group ID: ${entry.id}`);
    }
    idSet.add(entry.id);
    idToEntry.set(entry.id, entry);
  }

  // Validate each entry
  for (const entry of data.spec_groups) {
    // Check that superseded entries have valid superseded_by reference
    if (entry.status === 'superseded') {
      if (!entry.superseded_by) {
        errors.push(`${entry.id}: status is 'superseded' but superseded_by is missing or null`);
      } else if (!idSet.has(entry.superseded_by)) {
        errors.push(`${entry.id}: superseded_by '${entry.superseded_by}' does not exist in registry`);
      }
    }

    // Check that active entries don't have superseded_by
    if (entry.status === 'active' && entry.superseded_by) {
      warnings.push(`${entry.id}: status is 'active' but superseded_by is set to '${entry.superseded_by}'`);
    }

    // Validate supersedes references exist
    if (entry.supersedes && Array.isArray(entry.supersedes)) {
      for (const supersededId of entry.supersedes) {
        if (!idSet.has(supersededId)) {
          errors.push(`${entry.id}: supersedes '${supersededId}' does not exist in registry`);
        } else {
          // Check bidirectional consistency
          const supersededEntry = idToEntry.get(supersededId);
          if (supersededEntry && supersededEntry.superseded_by !== entry.id) {
            warnings.push(
              `${entry.id}: supersedes '${supersededId}' but ${supersededId}.superseded_by is '${supersededEntry.superseded_by}' (not '${entry.id}')`
            );
          }
        }
      }
    }

    // Check that spec group path exists (warning only, as it may not be created yet)
    const specGroupPath = join(claudeDir, '..', entry.path);
    if (!existsSync(specGroupPath)) {
      warnings.push(`${entry.id}: path '${entry.path}' does not exist on disk`);
    }

    // Check path matches ID
    const expectedPath = `.claude/specs/groups/${entry.id}`;
    if (entry.path !== expectedPath) {
      warnings.push(`${entry.id}: path '${entry.path}' does not match expected '${expectedPath}'`);
    }
  }

  // Check for circular supersession
  for (const entry of data.spec_groups) {
    if (entry.status === 'superseded' && entry.superseded_by) {
      const visited = new Set([entry.id]);
      let current = entry.superseded_by;
      while (current) {
        if (visited.has(current)) {
          errors.push(`Circular supersession detected involving: ${Array.from(visited).join(' -> ')} -> ${current}`);
          break;
        }
        visited.add(current);
        const nextEntry = idToEntry.get(current);
        current = nextEntry?.superseded_by || null;
      }
    }
  }

  return { errors, warnings };
}

/**
 * Validate the artifact registry.
 */
function validateRegistry(filePath) {
  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings };
  }

  // Verify it's a JSON file
  if (!filePath.endsWith('.json')) {
    warnings.push('File does not have .json extension');
  }

  // Parse JSON
  let data;
  try {
    const content = readFileSync(filePath, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    errors.push(`Invalid JSON: ${err.message}`);
    return { errors, warnings };
  }

  // Load schema
  const schema = loadSchema();
  if (schema.error) {
    errors.push(`Could not load registry schema: ${schema.error}`);
    return { errors, warnings };
  }

  // Validate against schema
  const schemaErrors = validateAgainstSchema(data, schema);
  errors.push(...schemaErrors);

  // Perform semantic validations
  const semantic = validateSemantics(data, CLAUDE_DIR);
  errors.push(...semantic.errors);
  warnings.push(...semantic.warnings);

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args[0] ? resolve(args[0]) : DEFAULT_REGISTRY_PATH;

  console.error(`Validating: ${basename(filePath)}`);

  const { errors, warnings } = validateRegistry(filePath);

  // Print warnings
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

  // Print errors
  for (const error of errors) {
    console.error(`Error: ${error}`);
  }

  if (errors.length === 0) {
    console.error(`Registry ${basename(filePath)} is valid.`);
  }

  if (errors.length > 0) {
    console.error('Validation failed.');
    process.exit(1);
  }

  process.exit(0);
}

main();
