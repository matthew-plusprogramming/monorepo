#!/usr/bin/env node

/**
 * Contract Completeness Validation Hook (PostToolUse)
 *
 * Validates structural completeness of contracts in spec files.
 * Triggered on writes to .claude/specs/**\/*.md files.
 *
 * Logic:
 * 1. Detect `## Interfaces & Contracts` heading in spec markdown
 * 2. Accept "N/A -- no boundary crossings" as valid (REQ-016)
 * 3. Parse each fenced `yaml:contract` block
 * 4. Read the referenced template's `_schema:` block for required fields
 * 5. Validate required fields are present and non-empty
 * 6. Validate security field presence based on boundary_visibility (REQ-017)
 * 7. Scan context: freeform fields for contradictions with core fields (REQ-013)
 * 8. Read per-spec-group escalation state (REQ-011, REQ-024)
 * 9. Emit warnings (exit 0) or blocks (exit 2) based on escalation state
 * 10. Update per-spec-group counter (REQ-024)
 * 11. Handle missing/corrupt state file (REQ-023)
 *
 * Exit codes:
 *   0 - Validation passed (or warn-only mode)
 *   2 - Validation failed in blocker mode
 *
 * Implements: AC-8.1 through AC-8.11, AC-9.1 through AC-9.8, AC-12.1
 * Spec: sg-contract-system, Tasks 11-12
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseYaml, readAndParseYaml, resolveProjectRoot } from './lib/yaml-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Security-relevant keywords for contradiction scanning */
const SECURITY_KEYWORDS = ['auth', 'token', 'secret', 'cors', 'csp', 'rate-limit', 'rate_limit'];

/** Negation patterns that indicate contradiction with a defined core field */
const NEGATION_PATTERNS = [
  /\bno\s+auth/i,
  /\bno\s+authentication/i,
  /\bno\s+authorization/i,
  /\bunauthenticated/i,
  /\bpublic\s+access/i,
  /\bno\s+rate.?limit/i,
  /\bno\s+cors/i,
  /\bno\s+csp/i,
  /\bno\s+token/i,
  /\bno\s+secret/i,
];

/** Fields that indicate non-trivial auth when set */
const AUTH_POSITIVE_VALUES = ['bearer-token', 'api-key', 'cookie-session', 'oauth2'];

/**
 * Security fields handled by validateSecurityFields() with boundary_visibility-aware logic.
 * These are excluded from the generic required-fields check in validateContract() to avoid
 * duplicate/confusing error messages when a field is missing.
 */
const SECURITY_HANDLED_FIELDS = new Set([
  'auth_method', 'auth_scope', 'required_headers', 'rate_limit_tier',
  'error_sanitization', 'channel_access_control', 'data_classification', 'pii_fields',
]);

/** Warn-to-blocker transition thresholds */
const CLEAN_VALIDATION_THRESHOLD = 10;
const DAYS_TO_BLOCKER = 30;

/** State file path (relative to project root) */
const STATE_FILE_REL = '.claude/coordination/contract-validation-state.json';

/** Templates directory (relative to project root) */
const TEMPLATES_DIR_REL = '.claude/contracts/templates';

// =============================================================================
// Template Loading
// =============================================================================

/**
 * Load all contract templates and their _schema blocks.
 * Returns a map of template name -> { required: string[], optional: string[] }
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {Map<string, { required: string[], optional: string[] }>}
 */
function loadTemplateSchemas(projectRoot) {
  const schemas = new Map();
  const templatesDir = join(projectRoot, TEMPLATES_DIR_REL);

  if (!existsSync(templatesDir)) {
    return schemas;
  }

  // Read all .template.yaml files
  const files = readdirSyncSafe(templatesDir).filter(f => f.endsWith('.template.yaml'));

  for (const file of files) {
    const templateName = file.replace('.template.yaml', '');
    const filePath = join(templatesDir, file);

    try {
      const { data } = readAndParseYaml(filePath);
      if (data && data._schema) {
        schemas.set(templateName, {
          required: data._schema.required || [],
          optional: data._schema.optional || [],
        });
      }
    } catch {
      // Skip unparseable templates -- fail-open
    }
  }

  return schemas;
}

/**
 * Safe readdir that returns empty array on error.
 * @param {string} dirPath
 * @returns {string[]}
 */
function readdirSyncSafe(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

// =============================================================================
// Markdown Parsing
// =============================================================================

/**
 * Extract the "## Interfaces & Contracts" section content from markdown.
 * Returns null if section not found.
 *
 * @param {string} content - Full markdown content
 * @returns {string | null} Section content or null
 */
function extractContractsSection(content) {
  const headingPattern = /^## Interfaces & Contracts\s*$/m;
  const match = content.match(headingPattern);
  if (!match) return null;

  const startIdx = match.index + match[0].length;

  // Find the next ## heading (end of this section)
  const nextHeading = content.slice(startIdx).match(/^## /m);
  const endIdx = nextHeading ? startIdx + nextHeading.index : content.length;

  return content.slice(startIdx, endIdx).trim();
}

/**
 * Check if section content indicates no boundary crossings.
 *
 * @param {string} sectionContent
 * @returns {boolean}
 */
function isNoBoundaryCrossings(sectionContent) {
  return /N\/A\s*--\s*no boundary crossings/i.test(sectionContent);
}

/**
 * Extract all yaml:contract fenced blocks from section content.
 * Returns array of { yaml: string, lineOffset: number } objects.
 *
 * @param {string} sectionContent
 * @returns {{ yaml: string, lineOffset: number }[]}
 */
function extractContractBlocks(sectionContent) {
  const blocks = [];
  const pattern = /```yaml:contract\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = pattern.exec(sectionContent)) !== null) {
    const yamlContent = match[1];
    const lineOffset = sectionContent.slice(0, match.index).split('\n').length;
    blocks.push({ yaml: yamlContent, lineOffset });
  }

  return blocks;
}

// =============================================================================
// Validation Logic
// =============================================================================

/**
 * Validate a single contract block against its template schema.
 *
 * @param {object} contractData - Parsed YAML data from contract block
 * @param {Map<string, { required: string[], optional: string[] }>} schemas
 * @returns {{ warnings: string[], errors: string[] }}
 */
function validateContract(contractData, schemas) {
  const warnings = [];
  const errors = [];

  if (!contractData || typeof contractData !== 'object') {
    errors.push('Contract block is empty or not a valid YAML object');
    return { warnings, errors };
  }

  // Determine template type
  const templateName = contractData._template;
  if (!templateName) {
    warnings.push('Contract block missing _template field -- cannot determine required fields');
    return { warnings, errors };
  }

  const schema = schemas.get(templateName);
  if (!schema) {
    warnings.push(`Unknown template type: ${templateName} -- skipping field validation`);
    return { warnings, errors };
  }

  // Check required fields (skip security fields handled by validateSecurityFields)
  for (const field of schema.required) {
    if (SECURITY_HANDLED_FIELDS.has(field)) continue;
    if (contractData[field] === undefined || contractData[field] === null) {
      errors.push(`Missing required field: ${field} (template: ${templateName}). Add '${field}: <value>' to the yaml:contract block. See .claude/contracts/templates/${templateName}.template.yaml for the required schema.`);
    } else if (contractData[field] === '' || contractData[field] === 'TODO' || contractData[field] === 'TBD') {
      errors.push(`Empty or placeholder value for required field: ${field} (template: ${templateName}). Replace the placeholder with an actual value. Example values are in .claude/contracts/templates/${templateName}.template.yaml under _example.`);
    }
  }

  // Check security fields based on boundary_visibility (AC-8.4, AC-8.5)
  const boundaryVisibility = contractData.boundary_visibility || 'external'; // Default to external
  validateSecurityFields(contractData, templateName, boundaryVisibility, warnings, errors);

  // Scan context for contradictions (AC-8.6, AC-8.7)
  if (contractData.context) {
    validateContextContradictions(contractData, warnings);
  }

  return { warnings, errors };
}

/**
 * Validate security field presence based on boundary visibility.
 *
 * @param {object} contractData
 * @param {string} templateName
 * @param {string} boundaryVisibility
 * @param {string[]} warnings
 * @param {string[]} errors
 */
function validateSecurityFields(contractData, templateName, boundaryVisibility, warnings, errors) {
  // Security fields vary by template type
  const securityFieldsByTemplate = {
    'rest-api': {
      always: ['auth_method'],
      external: ['auth_scope', 'required_headers', 'rate_limit_tier', 'error_sanitization'],
    },
    'event': {
      always: ['auth_method'],
      external: ['channel_access_control'],
    },
    'data-model': {
      always: ['data_classification', 'pii_fields'],
      external: [],
    },
    'behavioral': {
      always: ['rate_limit_tier'],
      external: [],
    },
  };

  const fields = securityFieldsByTemplate[templateName];
  if (!fields) return;

  // Always-required security fields
  for (const field of fields.always) {
    if (contractData[field] === undefined || contractData[field] === null) {
      errors.push(`Missing security field: ${field} (required for all ${templateName} contracts). Add '${field}: <value>' to the yaml:contract block. For external boundaries, all security fields are required. For internal, only auth_method is required.`);
    }
  }

  // External-only security fields
  if (boundaryVisibility === 'external') {
    for (const field of fields.external) {
      if (contractData[field] === undefined || contractData[field] === null) {
        warnings.push(`Missing security field: ${field} (required for external ${templateName} contracts). Add '${field}: <value>' to the yaml:contract block. For external boundaries, all security fields are required. For internal, only auth_method is required.`);
      }
    }
  }
}

/**
 * Scan context fields for contradictions with core fields.
 *
 * @param {object} contractData
 * @param {string[]} warnings
 */
function validateContextContradictions(contractData, warnings) {
  const contextStr = JSON.stringify(contractData.context).toLowerCase();

  // Check for auth contradictions
  const authMethod = contractData.auth_method;
  if (authMethod && AUTH_POSITIVE_VALUES.includes(authMethod)) {
    for (const pattern of NEGATION_PATTERNS) {
      if (pattern.test(contextStr)) {
        warnings.push(
          `Context field may contradict core auth_method "${authMethod}": ` +
          `found negation pattern "${pattern.source}" in context`
        );
        break;
      }
    }
  }

  // Check for security keyword contradictions
  for (const keyword of SECURITY_KEYWORDS) {
    if (contextStr.includes(keyword)) {
      // Check if context mentions "no <keyword>" style patterns
      const noPattern = new RegExp(`\\bno\\s+${keyword.replace(/[-_]/g, '[-_\\\\s]?')}`, 'i');
      if (noPattern.test(contextStr)) {
        // Check if a corresponding core field has a positive value
        const relatedFields = getRelatedCoreFields(keyword);
        for (const field of relatedFields) {
          if (contractData[field] && contractData[field] !== 'none' && contractData[field] !== 'public') {
            warnings.push(
              `Context may contradict core field "${field}" (value: "${contractData[field]}"): ` +
              `found "no ${keyword}" in context`
            );
          }
        }
      }
    }
  }
}

/**
 * Map security keywords to related core field names.
 *
 * @param {string} keyword
 * @returns {string[]}
 */
function getRelatedCoreFields(keyword) {
  const mapping = {
    'auth': ['auth_method', 'auth_scope'],
    'token': ['auth_method'],
    'secret': ['auth_method', 'error_sanitization'],
    'cors': ['required_headers'],
    'csp': ['required_headers'],
    'rate-limit': ['rate_limit_tier'],
    'rate_limit': ['rate_limit_tier'],
  };
  return mapping[keyword] || [];
}

// =============================================================================
// Escalation State Management
// =============================================================================

/**
 * Read escalation state from state file.
 * Returns default state on missing/corrupt file (fail-open, REQ-023).
 *
 * @param {string} projectRoot
 * @returns {{ groups: object, recovered: boolean }}
 */
function readEscalationState(projectRoot) {
  const statePath = join(projectRoot, STATE_FILE_REL);

  try {
    if (!existsSync(statePath)) {
      return { groups: {}, recovered: true };
    }

    const content = readFileSync(statePath, 'utf-8');
    const data = JSON.parse(content);

    if (typeof data !== 'object' || data === null) {
      return { groups: {}, recovered: true };
    }

    return { groups: data, recovered: false };
  } catch {
    // Corrupt/unparseable JSON -- fail-open (REQ-023)
    return { groups: {}, recovered: true };
  }
}

/**
 * Write escalation state to state file.
 *
 * @param {string} projectRoot
 * @param {object} groups
 */
function writeEscalationState(projectRoot, groups) {
  const statePath = join(projectRoot, STATE_FILE_REL);
  const stateDir = dirname(statePath);

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  writeFileSync(statePath, JSON.stringify(groups, null, 2) + '\n');
}

/**
 * Determine if a spec group should be in blocker mode.
 *
 * @param {object} groupState - { consecutive_clean_count, first_deployment_date, last_validation_date }
 * @returns {boolean}
 */
function isBlockerMode(groupState) {
  if (!groupState) return false;

  // Check consecutive clean count threshold
  if (groupState.consecutive_clean_count >= CLEAN_VALIDATION_THRESHOLD) {
    return true;
  }

  // Check time-based threshold
  if (groupState.first_deployment_date) {
    const firstDate = new Date(groupState.first_deployment_date);
    const now = new Date();
    const daysDiff = (now - firstDate) / (1000 * 60 * 60 * 24);
    if (daysDiff >= DAYS_TO_BLOCKER) {
      return true;
    }
  }

  return false;
}

/**
 * Extract spec group ID from a spec file path.
 * Expected path pattern: .claude/specs/groups/<spec-group-id>/...
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function extractSpecGroupId(filePath) {
  const match = filePath.match(/\.claude\/specs\/groups\/([^/]+)\//);
  return match ? match[1] : null;
}

// =============================================================================
// Main Validation
// =============================================================================

/**
 * Validate a spec file for contract completeness.
 *
 * @param {string} filePath - Absolute path to spec file
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ warnings: string[], errors: string[], specGroupId: string | null, hasContracts: boolean }}
 */
function validateSpecFile(filePath, projectRoot) {
  const warnings = [];
  const errors = [];

  if (!existsSync(filePath)) {
    return { warnings, errors, specGroupId: null, hasContracts: false };
  }

  const content = readFileSync(filePath, 'utf-8');
  const specGroupId = extractSpecGroupId(filePath);

  // Extract contracts section
  const sectionContent = extractContractsSection(content);

  if (!sectionContent) {
    // No contracts section -- exit cleanly (AC-8.11)
    return { warnings, errors, specGroupId, hasContracts: false };
  }

  // Check for "N/A -- no boundary crossings" (AC-8.8)
  if (isNoBoundaryCrossings(sectionContent)) {
    return { warnings, errors, specGroupId, hasContracts: false };
  }

  // Load template schemas (AC-8.10 -- supports new templates via _schema)
  const schemas = loadTemplateSchemas(projectRoot);

  // Extract and validate each yaml:contract block (AC-8.1)
  const blocks = extractContractBlocks(sectionContent);

  if (blocks.length === 0) {
    warnings.push(
      'Interfaces & Contracts section found but no yaml:contract blocks detected. ' +
      'Use fenced ```yaml:contract blocks or mark as "N/A -- no boundary crossings".'
    );
    return { warnings, errors, specGroupId, hasContracts: true };
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      const { data } = safeParseYaml(block.yaml, `${basename(filePath)}:contract-block-${i + 1}`);
      const result = validateContract(data, schemas);
      warnings.push(...result.warnings.map(w => `[contract ${i + 1}] ${w}`));
      errors.push(...result.errors.map(e => `[contract ${i + 1}] ${e}`));
    } catch (parseErr) {
      errors.push(`[contract ${i + 1}] YAML parse error: ${parseErr.message}. Fix the YAML syntax in the contract block. Ensure proper indentation and valid YAML.`);
    }
  }

  return { warnings, errors, specGroupId, hasContracts: true };
}

/**
 * Main entry point.
 */
function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0) {
      console.error('Usage: contract-validate.mjs <spec-file>');
      process.exit(0); // Fail-open for missing args
    }

    const filePath = resolve(args[0]);
    const projectRoot = resolveProjectRoot();

    // Validate
    const { warnings, errors, specGroupId, hasContracts } = validateSpecFile(filePath, projectRoot);

    // If no contracts section, exit cleanly
    if (!hasContracts && warnings.length === 0 && errors.length === 0) {
      process.exit(0);
    }

    // Read escalation state
    const { groups, recovered } = readEscalationState(projectRoot);

    if (recovered) {
      console.error('Warning: contract-validation-state.json missing or corrupt -- defaulting to warn-only mode');
    }

    // Initialize group state if needed
    const groupId = specGroupId || 'unknown';
    if (!groups[groupId]) {
      groups[groupId] = {
        consecutive_clean_count: 0,
        first_deployment_date: new Date().toISOString(),
        last_validation_date: new Date().toISOString(),
      };
    }

    const groupState = groups[groupId];
    const blockerMode = isBlockerMode(groupState);

    // Update state based on validation result
    groupState.last_validation_date = new Date().toISOString();

    if (errors.length === 0) {
      // Clean validation -- increment counter
      groupState.consecutive_clean_count += 1;
    } else {
      // Failed validation -- reset counter (AC-9.4)
      groupState.consecutive_clean_count = 0;
    }

    // Persist state
    try {
      writeEscalationState(projectRoot, groups);
    } catch {
      // State write failure is non-fatal
      console.error('Warning: Failed to write contract-validation-state.json');
    }

    // Emit diagnostics
    for (const w of warnings) {
      console.error(`Contract warning: ${w}`);
    }

    for (const e of errors) {
      console.error(`Contract error: ${e}`);
    }

    // Determine exit code
    if (errors.length > 0) {
      if (blockerMode) {
        console.error(`\nContract validation BLOCKED (${errors.length} error(s), blocker mode for ${groupId}). Fix all errors above, then save the spec file again. The validation will re-run automatically.`);
        process.exit(2);
      } else {
        console.error(`\nContract validation WARNING (${errors.length} error(s), warn-only mode for ${groupId})`);
        process.exit(0);
      }
    }

    if (warnings.length > 0) {
      console.error(`\nContract validation passed with ${warnings.length} warning(s)`);
    }

    process.exit(0);
  } catch (err) {
    // Top-level fail-open: unexpected errors must not block spec writes
    console.error(`contract-validate: unexpected error: ${err.message}`);
    process.exit(0);
  }
}

// =============================================================================
// Exports (for unit testing)
// =============================================================================

export {
  validateContract,
  extractContractsSection,
  validateSecurityFields,
  validateContextContradictions,
  isBlockerMode,
  validateSpecFile,
};

// =============================================================================
// CLI entry point (only when run as a script, not when imported)
// =============================================================================

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
