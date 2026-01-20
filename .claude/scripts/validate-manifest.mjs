#!/usr/bin/env node

/**
 * Validate manifest.json files against spec-group.schema.json.
 *
 * Logic:
 * 1. Accept manifest.json file path as argument
 * 2. Parse JSON
 * 3. Validate against .claude/specs/schema/spec-group.schema.json
 * 4. Report validation errors
 * 5. Exit 0 on valid, non-zero on invalid
 *
 * Usage:
 *   node validate-manifest.mjs <manifest.json>
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
const SCHEMA_PATH = join(CLAUDE_DIR, 'specs', 'schema', 'spec-group.schema.json');

/**
 * Load the spec-group schema.
 */
function loadSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`Schema file not found: ${SCHEMA_PATH}`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error loading schema: ${err.message}`);
    return null;
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
        if (propSchema.format === 'uri') {
          try {
            new URL(value);
          } catch {
            errors.push(`${propPath}: value '${value}' is not a valid URI`);
          }
        }
      }

      // Array items
      if (propSchema.type === 'array' && propSchema.items && Array.isArray(value)) {
        if (propSchema.minItems && value.length < propSchema.minItems) {
          errors.push(`${propPath}: array must have at least ${propSchema.minItems} items`);
        }
        for (let i = 0; i < value.length; i++) {
          const itemErrors = validateAgainstSchema(value[i], propSchema.items, `${propPath}[${i}].`);
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
 * Validate a manifest.json file.
 */
function validateManifest(filePath) {
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
  if (!schema) {
    errors.push('Could not load spec-group schema');
    return { errors, warnings };
  }

  // Validate against schema
  const schemaErrors = validateAgainstSchema(data, schema);
  errors.push(...schemaErrors);

  // Additional semantic validations

  // Check that review_state and work_state are compatible
  if (data.review_state && data.work_state) {
    if (data.review_state === 'DRAFT' && data.work_state !== 'PLAN_READY') {
      warnings.push(
        `Unusual state: review_state is DRAFT but work_state is ${data.work_state}. ` +
          `Typically work should not begin until spec is approved.`
      );
    }
    if (data.review_state !== 'APPROVED' && ['IMPLEMENTING', 'VERIFYING', 'READY_TO_MERGE'].includes(data.work_state)) {
      warnings.push(
        `State warning: work_state is ${data.work_state} but review_state is ${data.review_state}. ` +
          `Implementation should typically wait for APPROVED status.`
      );
    }
  }

  // Check convergence consistency
  if (data.convergence) {
    if (data.convergence.all_tests_passing && !data.convergence.all_acs_implemented) {
      warnings.push('Convergence inconsistency: all_tests_passing is true but all_acs_implemented is false');
    }
    if (data.convergence.unifier_passed && !data.convergence.all_tests_passing) {
      warnings.push('Convergence inconsistency: unifier_passed is true but all_tests_passing is false');
    }
  }

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: validate-manifest.mjs <manifest.json> [manifest2.json ...]');
    console.log('No files provided, nothing to validate.');
    process.exit(0);
  }

  let hasErrors = false;
  let hasWarnings = false;

  for (const arg of args) {
    const filePath = resolve(arg);
    console.log(`Validating: ${basename(filePath)}`);

    const { errors, warnings } = validateManifest(filePath);

    // Print warnings
    for (const warning of warnings) {
      hasWarnings = true;
      console.warn(`Warning: ${warning}`);
    }

    // Print errors
    for (const error of errors) {
      hasErrors = true;
      console.error(`Error: ${error}`);
    }

    if (errors.length === 0) {
      console.log(`Manifest ${basename(filePath)} is valid.`);
    }

    console.log('');
  }

  if (hasErrors) {
    console.error('Validation failed.');
    process.exit(1);
  }

  if (args.length > 1) {
    console.log(`Validated ${args.length} manifest(s) successfully.`);
  }

  process.exit(0);
}

main();
