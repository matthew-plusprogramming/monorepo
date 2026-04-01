#!/usr/bin/env node

/**
 * Diagram YAML Stub Scaffolder
 *
 * Generates initial YAML stub files for the four diagram source types:
 * - data-models.yaml    (ERD diagram source)
 * - states/index.yaml   (State diagram source)
 * - security.yaml       (Security boundary diagram source)
 * - deployment.yaml     (Deployment topology diagram source)
 *
 * Each stub contains the schema_version header and minimal valid structure.
 * All four stubs are generated unconditionally (OQ-1 decision).
 * Creates the states/ subdirectory if it does not exist (INC-007).
 *
 * Placed as a separate script from docs-scaffold.mjs to maintain
 * separation of concerns (INC-008).
 *
 * Usage:
 *   node .claude/scripts/docs-scaffold-diagrams.mjs
 *   node .claude/scripts/docs-scaffold-diagrams.mjs --project-root /path
 *
 * Implements: REQ-023, AC-12.3, AC-12.4
 * Spec: sg-visual-prd-reports, Task 13
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStructuredDocsDir, resolveProjectRoot } from './lib/yaml-utils.mjs';

// =============================================================================
// Stub Content Definitions
// =============================================================================

const DATA_MODELS_STUB = `# Data Models (Entity-Relationship Diagram Source)
#
# Define your project's data entities, attributes, and relationships here.
# Run \`node .claude/scripts/docs-generate.mjs\` to generate an ERD diagram.
#
# See .claude/docs/STRUCTURED-DOCS.md for full schema documentation.
#
schema_version: 1
entities:
  # Example entity (remove or replace with your own):
  # - name: User
  #   attributes:
  #     - name: id
  #       type: uuid
  #       primary: true
  #     - name: email
  #       type: string
  #   relationships:
  #     - target: Organization
  #       type: many-to-one
  #       label: belongs to
  []
`;

const STATES_INDEX_STUB = `# State Machines (State Diagram Source)
#
# Define your project's state machines with states and transitions here.
# Run \`node .claude/scripts/docs-generate.mjs\` to generate state diagrams.
#
# See .claude/docs/STRUCTURED-DOCS.md for full schema documentation.
#
schema_version: 1
state_machines:
  # Example state machine (remove or replace with your own):
  # - name: order-lifecycle
  #   initial: created
  #   states:
  #     - name: created
  #     - name: processing
  #     - name: completed
  #   transitions:
  #     - from: created
  #       to: processing
  #       trigger: payment_confirmed
  #     - from: processing
  #       to: completed
  #       trigger: fulfillment_complete
  []
`;

const SECURITY_STUB = `# Security Boundaries (Security Diagram Source)
#
# WARNING: This file contains security boundary definitions.
# It uses _sync_policy: "never-sync" and will NOT propagate to consumer projects.
#
# Define your project's security zones, trust levels, and data flows here.
# Run \`node .claude/scripts/docs-generate.mjs\` to generate a security diagram.
#
# See .claude/docs/STRUCTURED-DOCS.md for full schema documentation.
#
schema_version: 1
zones:
  # Example zone (remove or replace with your own):
  # - name: public-internet
  #   trust_level: untrusted
  #   components:
  #     - cdn
  #     - load-balancer
  []
data_flows:
  # Example data flow (remove or replace with your own):
  # - from: public-internet
  #   to: dmz
  #   protocol: HTTPS
  #   data: API requests
  []
`;

const DEPLOYMENT_STUB = `# Deployment Topology (Deployment Diagram Source)
#
# Define your project's infrastructure nodes and connections here.
# Run \`node .claude/scripts/docs-generate.mjs\` to generate a deployment diagram.
#
# See .claude/docs/STRUCTURED-DOCS.md for full schema documentation.
#
schema_version: 1
nodes:
  # Example node (remove or replace with your own):
  # - name: web-server
  #   type: server
  #   services:
  #     - nginx
  #     - node-app
  []
connections:
  # Example connection (remove or replace with your own):
  # - from: web-server
  #   to: database
  #   protocol: TCP/5432
  #   label: SQL queries
  []
`;

// =============================================================================
// Stub Definitions
// =============================================================================

const STUBS = [
  {
    name: 'data-models.yaml',
    relativePath: 'data-models.yaml',
    content: DATA_MODELS_STUB,
  },
  {
    name: 'states/index.yaml',
    relativePath: join('states', 'index.yaml'),
    content: STATES_INDEX_STUB,
  },
  {
    name: 'security.yaml',
    relativePath: 'security.yaml',
    content: SECURITY_STUB,
  },
  {
    name: 'deployment.yaml',
    relativePath: 'deployment.yaml',
    content: DEPLOYMENT_STUB,
  },
];

// =============================================================================
// Main
// =============================================================================

/**
 * Scaffold diagram YAML stubs into the structured docs directory.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ created: string[], skipped: string[] }}
 */
export function scaffoldDiagramStubs(projectRoot) {
  const docsDir = getStructuredDocsDir(projectRoot);
  const created = [];
  const skipped = [];

  // Ensure structured docs directory exists
  mkdirSync(docsDir, { recursive: true });

  // INC-007: Create states/ subdirectory if it does not exist
  const statesDir = join(docsDir, 'states');
  mkdirSync(statesDir, { recursive: true });

  for (const stub of STUBS) {
    const targetPath = join(docsDir, stub.relativePath);

    if (existsSync(targetPath)) {
      skipped.push(stub.name);
      console.log(`  Skip ${stub.name}: file already exists`);
      continue;
    }

    // Ensure parent directory exists
    const parentDir = join(targetPath, '..');
    mkdirSync(parentDir, { recursive: true });

    writeFileSync(targetPath, stub.content);
    created.push(stub.name);
    console.log(`  Created ${stub.name}`);
  }

  return { created, skipped };
}

async function main() {
  try {
    const projectRoot = resolveProjectRoot();
    console.log('Scaffolding diagram YAML stubs...\n');

    const { created, skipped } = scaffoldDiagramStubs(projectRoot);

    console.log(`\nDone. Created ${created.length} stub(s), skipped ${skipped.length} existing file(s).`);

    if (created.length > 0) {
      console.log('\nNext steps:');
      console.log('  1. Edit the generated stubs with your project data');
      console.log('  2. Run: node .claude/scripts/docs-validate.mjs');
      console.log('  3. Run: node .claude/scripts/docs-generate.mjs');
    }

    process.exit(0);
  } catch (err) {
    console.error(`Scaffold failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('docs-scaffold-diagrams.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
