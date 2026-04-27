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
 * 3. Parse YAML frontmatter from markdown (via `yaml` package)
 * 4. Validate against appropriate schema using Ajv
 * 5. Report validation errors with field-qualified diagnostics
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
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

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
 * Parse YAML frontmatter from markdown content using the `yaml` package.
 * Returns null if no frontmatter found.
 *
 * Library-backed parse handles inline arrays, literal `null`, boolean literals,
 * nested objects, and multi-line structures that the former hand-rolled regex
 * parser could not reliably round-trip.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yamlContent = match[1];
  try {
    const parsed = YAML.parse(yamlContent);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
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
 * Required markdown sections for different spec types.
 */
const REQUIRED_MARKDOWN_SECTIONS = {
  'atomic-spec': ['## Description', '## Acceptance Criteria', '## Test Strategy', '## Atomicity Justification'],
  'workstream-spec': ['## Context', '## Requirements', '## Task List'],
  'master-spec': ['## Context', '## Workstreams'],
};

// Cache a single Ajv instance; Ajv compilation is O(schema size), so one
// instance + per-schema validator is cheap.
const _ajv = (() => {
  const instance = new Ajv({
    allErrors: true,
    strict: 'log',
    allowUnionTypes: true,
    verbose: true,
  });
  addFormats(instance);
  return instance;
})();

/**
 * Markdown-body fields that the schema requires but that live in the body
 * rather than the frontmatter. We drop them from `required` before compiling
 * a frontmatter-only validator so Ajv does not flag their absence.
 */
const MARKDOWN_BODY_ONLY_REQUIRED = new Set([
  'description',
  'acceptance_criteria',
  'atomicity_justification',
]);

function buildFrontmatterSchema(schema, specType) {
  if (specType === 'spec-group') return schema;
  if (!schema.required) return schema;
  const filteredRequired = schema.required.filter(
    (f) => !MARKDOWN_BODY_ONLY_REQUIRED.has(f),
  );
  return { ...schema, required: filteredRequired };
}

/**
 * Convert an Ajv error into a human-readable diagnostic string.
 *
 * Preserves the field-path + expected-value substring shape that the test
 * suite has historically asserted against.
 */
function formatAjvError(err) {
  const path = (err.instancePath || '').replace(/^\//, '').replace(/\//g, '.');
  const field = path || (err.params && err.params.missingProperty) || '(root)';

  switch (err.keyword) {
    case 'required':
      return `${err.params.missingProperty}: required field is missing`;
    case 'enum': {
      const allowed = err.params.allowedValues;
      return `${field}: value '${err.data}' is not in enum [${allowed.join(', ')}]`;
    }
    case 'type':
      return `${field}: expected type ${err.params.type}, got ${Array.isArray(err.data) ? 'array' : typeof err.data}`;
    case 'pattern':
      return `${field}: value '${err.data}' does not match pattern ${err.params.pattern}`;
    case 'minimum':
      return `${field}: ${err.data} is less than minimum ${err.params.limit}`;
    case 'maximum':
      return `${field}: ${err.data} exceeds maximum ${err.params.limit}`;
    case 'minLength':
      return `${field}: string length below minimum ${err.params.limit}`;
    case 'maxLength':
      return `${field}: string length above maximum ${err.params.limit}`;
    case 'minItems':
      return `${field}: array must have at least ${err.params.limit} items`;
    case 'maxItems':
      return `${field}: array must have at most ${err.params.limit} items`;
    case 'additionalProperties':
      return `${field || '(root)'}: unknown property '${err.params.additionalProperty}' (additionalProperties: false)`;
    case 'oneOf':
      return `${field || '(root)'}: value does not match any allowed oneOf branch`;
    case 'if':
      return `${field || '(root)'}: conditional validation failed`;
    case 'const':
      return `${field}: must equal ${JSON.stringify(err.params.allowedValue)}`;
    default:
      return `${field || '(root)'}: ${err.message}`;
  }
}

/**
 * Filter out redundant errors. Ajv emits both the outer `oneOf` failure AND
 * each branch's individual error. Prefer branch-level errors since they
 * identify the actual offending field / value.
 */
function filterAjvErrors(errors) {
  if (!errors || errors.length === 0) return [];
  const hasNonOneOf = errors.some((e) => e.keyword !== 'oneOf' && e.keyword !== 'if');
  if (hasNonOneOf) {
    return errors.filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'if');
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

    const validate = _ajv.compile(schema);
    if (!validate(data)) {
      const filtered = filterAjvErrors(validate.errors);
      for (const e of filtered) errors.push(formatAjvError(e));
    }

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

  // For markdown files, exclude required-markdown-body fields from `required`
  // so Ajv only enforces frontmatter-relevant constraints.
  const frontmatterSchema = buildFrontmatterSchema(schema, specType);
  const frontmatterValidator = _ajv.compile(frontmatterSchema);
  if (!frontmatterValidator(frontmatter)) {
    const filtered = filterAjvErrors(frontmatterValidator.errors);
    for (const e of filtered) errors.push(formatAjvError(e));
  }

  // Section validation only for files under .claude/specs/ — aligns with
  // spec-validate.mjs isUnderSpecsDirectory convention, so ad-hoc CLI
  // invocations on fixture files (tests, temp dirs) are not forced to carry
  // full section scaffolding. Resolve path first to prevent relative-path
  // or symlink-based evasion (e.g., ../evil/.claude/specs/foo.md).
  const resolvedPath = resolve(filePath);
  if (resolvedPath.includes('.claude/specs/')) {
    const sectionErrors = validateMarkdownSections(content, specType);
    errors.push(...sectionErrors);
  }

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

  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

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

// Export internals for testing
export {
  parseFrontmatter,
  determineSpecType,
  loadSchema,
  validateSpecFile,
  buildFrontmatterSchema,
  formatAjvError,
  filterAjvErrors,
};

// Only run main() when invoked as CLI (not when imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
