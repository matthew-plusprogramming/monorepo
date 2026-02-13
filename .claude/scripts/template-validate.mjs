#!/usr/bin/env node

/**
 * Ensure template files maintain required placeholders.
 *
 * Logic:
 * 1. Accept template file path as argument
 * 2. Based on template type (from filename), check for required placeholders:
 *    - agent.template.md: <agent-name>, <primary responsibility>, sections
 *    - atomic-spec.template.md: id:, title:, status:, sections
 *    - requirements.template.md: Required sections
 *    - task-spec.template.md: Required sections
 *    - workstream-spec.template.md: Required sections
 *    - prd.template.md: Required PRD sections
 *    - SKILL.template.md or skill templates: name:, description:, allowed-tools:, user-invocable:
 * 3. Report missing placeholders/sections
 * 4. Exit 0 if valid, non-zero if missing required elements
 *
 * Usage:
 *   node template-validate.mjs <template-file>
 *
 * Exit codes:
 *   0 - Template is valid
 *   1 - Template is missing required elements
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * Template requirements by type.
 * Each entry specifies required placeholders and/or sections.
 */
const TEMPLATE_REQUIREMENTS = {
  'agent.template.md': {
    placeholders: ['<agent-name>', '<primary responsibility>'],
    sections: ['## Your Role', '## Your Responsibilities', '## Guidelines', '## Constraints'],
    frontmatterFields: ['name:', 'description:', 'tools:', 'model:'],
  },

  'atomic-spec.template.md': {
    placeholders: [],
    sections: [
      '## Description',
      '## Acceptance Criteria',
      '## Test Strategy',
      '## Atomicity Justification',
      '## Pre-Implementation Evidence Table',
      '## Contracts & Schemas',
      '## Dependencies',
      '## Implementation Evidence',
      '## Test Evidence',
    ],
    frontmatterFields: ['id:', 'title:', 'status:'],
  },

  'requirements.template.md': {
    placeholders: [],
    sections: ['## Source', '## Requirements', '## Traceability', '## Open Questions'],
    frontmatterFields: ['spec_group:', 'source:'],
  },

  'task-spec.template.md': {
    placeholders: [],
    sections: ['## Context', '## Goal', '## Requirements', '## Acceptance Criteria', '## Task List', '## Test Plan'],
    frontmatterFields: ['id:', 'title:', 'date:', 'status:'],
  },

  'workstream-spec.template.md': {
    placeholders: [],
    sections: [
      '## Context',
      '## Goals / Non-goals',
      '## Requirements',
      '## Core Flows',
      '## Task List',
      '## Testing',
      '## Open Questions',
    ],
    frontmatterFields: ['id:', 'title:', 'owner:', 'status:'],
  },

  'prd.template.md': {
    placeholders: [],
    sections: [
      '## 1. Problem Statement',
      '## 2. Product Intent',
      '## 3. Requirements',
      '## 4. Constraints',
      '## 5. Assumptions',
      '## 6. Tradeoffs',
      '## 7. User Experience',
      '## 8. Scope',
      '## 9. Risks & Mitigations',
      '## 10. Success Criteria',
    ],
    frontmatterFields: ['id:', 'title:', 'version:', 'state:'],
  },

  // Skill template patterns
  'SKILL.template.md': {
    placeholders: [],
    sections: [],
    frontmatterFields: ['name:', 'description:', 'allowed-tools:', 'user-invocable:'],
  },
};

/**
 * Determine template type from filename.
 */
function getTemplateType(fileName) {
  // Direct match
  if (TEMPLATE_REQUIREMENTS[fileName]) {
    return fileName;
  }

  // Check for skill template patterns
  if (fileName.toLowerCase().includes('skill') && fileName.endsWith('.md')) {
    return 'SKILL.template.md';
  }

  // Try matching by base name pattern
  for (const templateName of Object.keys(TEMPLATE_REQUIREMENTS)) {
    const baseName = templateName.replace('.template.md', '').toLowerCase();
    if (fileName.toLowerCase().includes(baseName)) {
      return templateName;
    }
  }

  return null;
}

/**
 * Validate a template file.
 */
function validateTemplate(filePath) {
  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings };
  }

  const fileName = basename(filePath);
  const templateType = getTemplateType(fileName);

  if (!templateType) {
    warnings.push(`Unknown template type for: ${fileName}`);
    warnings.push(
      `Known types: ${Object.keys(TEMPLATE_REQUIREMENTS)
        .map((t) => t.replace('.template.md', ''))
        .join(', ')}`
    );
    return { errors, warnings };
  }

  const requirements = TEMPLATE_REQUIREMENTS[templateType];
  const content = readFileSync(filePath, 'utf-8');

  console.error(`Validating as ${templateType}...`);

  // Check for required placeholders
  if (requirements.placeholders) {
    for (const placeholder of requirements.placeholders) {
      if (!content.includes(placeholder)) {
        errors.push(`Missing required placeholder: ${placeholder}`);
      }
    }
  }

  // Check for required sections (case-insensitive)
  if (requirements.sections) {
    for (const section of requirements.sections) {
      const sectionPattern = new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (!sectionPattern.test(content)) {
        errors.push(`Missing required section: ${section}`);
      }
    }
  }

  // Check for required frontmatter fields
  if (requirements.frontmatterFields) {
    // Extract frontmatter if present
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      for (const field of requirements.frontmatterFields) {
        if (!frontmatter.includes(field)) {
          errors.push(`Missing required frontmatter field: ${field}`);
        }
      }
    } else {
      errors.push('Missing YAML frontmatter');
    }
  }

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: template-validate.mjs <template-file>');
    console.error('Error: No file provided.');
    console.error('\nSupported template types:');
    for (const templateName of Object.keys(TEMPLATE_REQUIREMENTS)) {
      console.error(`  - ${templateName}`);
    }
    process.exit(1);
  }

  let hasErrors = false;
  let hasWarnings = false;

  for (const arg of args) {
    const filePath = resolve(arg);
    const { errors, warnings } = validateTemplate(filePath);

    // Print warnings
    for (const warning of warnings) {
      hasWarnings = true;
      console.error(`Warning in ${basename(filePath)}: ${warning}`);
    }

    // Print errors
    for (const error of errors) {
      hasErrors = true;
      console.error(`Error in ${basename(filePath)}: ${error}`);
    }

    if (errors.length === 0 && warnings.length === 0) {
      console.error(`Template ${basename(filePath)} is valid.`);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  if (args.length > 1) {
    console.error(`\nValidated ${args.length} template(s) successfully.`);
  }

  process.exit(0);
}

main();
