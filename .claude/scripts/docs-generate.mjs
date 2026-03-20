#!/usr/bin/env node

/**
 * Structured Documentation Mermaid Generator
 *
 * Generates Mermaid .mmd diagram files from structured YAML documentation:
 * - architecture.yaml -> generated/architecture.mmd (flowchart TD)
 * - flows/*.yaml -> generated/flow-<name>.mmd (sequenceDiagram)
 *
 * Each .mmd file embeds a source-hash comment on the first line for freshness detection.
 * Hash = first 8 chars of SHA-256 over LF-normalized YAML source content.
 *
 * Usage:
 *   node .claude/scripts/docs-generate.mjs                    # Generate all diagrams
 *   node .claude/scripts/docs-generate.mjs --project-root /p  # Override project root
 *
 * Implements: REQ-009
 * Spec: sg-structured-docs, Tasks 8-9
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  readAndParseYaml,
  computeSourceHash,
  confineToFlowsDir,
  getStructuredDocsDir,
  getGeneratedDir,
  resolveProjectRoot,
  DocsError,
  SOURCE_HASH_PREFIX,
} from './lib/yaml-utils.mjs';

// =============================================================================
// Architecture Diagram Generation (AC-6.1, AC-6.3, AC-6.4)
// =============================================================================

/**
 * Sanitize a module name for use as a Mermaid node ID.
 *
 * Replaces non-alphanumeric characters with underscores.
 *
 * @param {string} name - Module name
 * @returns {string} Safe Mermaid node ID
 */
function toNodeId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Escape a label for Mermaid display (handle special chars).
 *
 * Sanitizes against Mermaid injection by stripping/replacing:
 * - Double quotes (replaced with single quotes)
 * - Newlines and carriage returns (replaced with spaces)
 * - Mermaid comment markers (%%) (stripped)
 * - Mermaid structural keywords at word boundaries (prefixed with underscore)
 *
 * @param {string} label - Display label
 * @returns {string} Escaped label safe for Mermaid rendering
 */
function escapeLabel(label) {
  let safe = label;
  // Replace double quotes with single quotes
  safe = safe.replace(/"/g, "'");
  // Strip newlines and carriage returns to prevent multi-line injection
  safe = safe.replace(/[\r\n]+/g, ' ');
  // Strip Mermaid comment markers
  safe = safe.replace(/%%/g, '');
  // Neutralize Mermaid structural keywords that could break diagram syntax
  // (only at word boundaries to avoid false positives in normal text)
  safe = safe.replace(/\b(end|subgraph|graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|erDiagram)\b/gi, '_$1');
  return safe;
}

/**
 * Generate architecture.mmd content from parsed architecture.yaml.
 *
 * Produces a flowchart TD (top-down) with:
 * - Modules as nodes
 * - Dependencies as directed edges
 * - Circular dependencies as bidirectional edges
 * - Unconnected nodes appear as standalone (AC-6.4)
 *
 * @param {any} archDoc - Parsed architecture.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateArchitectureMmd(archDoc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];
  lines.push('flowchart TD');

  if (!archDoc || !Array.isArray(archDoc.modules) || archDoc.modules.length === 0) {
    lines.push('  %% No modules defined');
    return lines.join('\n') + '\n';
  }

  const moduleNames = new Set();
  const moduleMap = new Map();

  // Declare all module nodes
  for (const mod of archDoc.modules) {
    if (!mod.name) continue;
    const id = toNodeId(mod.name);
    const label = escapeLabel(mod.name);
    lines.push(`  ${id}["${label}"]`);
    moduleNames.add(mod.name);
    moduleMap.set(mod.name, mod);
  }

  // Helper: get dependencies from either field name
  const getDeps = (mod) => {
    const deps = mod.depends_on || mod.dependencies;
    return Array.isArray(deps) ? deps : [];
  };

  // Detect bidirectional edges for circular deps
  const edgeSet = new Set();
  const biDirectional = new Set();

  for (const mod of archDoc.modules) {
    if (!mod.name) continue;
    for (const dep of getDeps(mod)) {
      if (!moduleNames.has(dep)) continue;
      const forward = `${mod.name}|${dep}`;
      const reverse = `${dep}|${mod.name}`;

      if (edgeSet.has(reverse)) {
        biDirectional.add(forward);
        biDirectional.add(reverse);
      }
      edgeSet.add(forward);
    }
  }

  // Add edges
  for (const mod of archDoc.modules) {
    if (!mod.name) continue;
    for (const dep of getDeps(mod)) {
      if (!moduleNames.has(dep)) continue;
      const fromId = toNodeId(mod.name);
      const toId = toNodeId(dep);
      const forward = `${mod.name}|${dep}`;
      const reverse = `${dep}|${mod.name}`;

      // For bidirectional edges, only render once with <-->
      if (biDirectional.has(forward)) {
        // Only render this pair once (alphabetical order)
        if (mod.name < dep) {
          lines.push(`  ${fromId} <--> ${toId}`);
        }
      } else {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

// =============================================================================
// Flow Diagram Generation (AC-6.2, AC-6.3)
// =============================================================================

/**
 * Sanitize a module name for use as a Mermaid participant ID.
 *
 * @param {string} name
 * @returns {string}
 */
function toParticipantId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Generate a flow .mmd content from parsed flow YAML.
 *
 * Produces a sequenceDiagram with:
 * - Modules as participants
 * - Steps as messages between participants
 *
 * @param {any} flowDoc - Parsed flow YAML document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateFlowMmd(flowDoc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];
  lines.push('sequenceDiagram');
  lines.push('  autonumber');

  if (!flowDoc || !Array.isArray(flowDoc.steps) || flowDoc.steps.length === 0) {
    lines.push('  %% No steps defined');
    return lines.join('\n') + '\n';
  }

  // Collect unique participants in order of appearance
  const participants = [];
  const participantSet = new Set();

  // Sort steps by order
  const sortedSteps = [...flowDoc.steps].sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const step of sortedSteps) {
    if (step.module && !participantSet.has(step.module)) {
      participantSet.add(step.module);
      participants.push(step.module);
    }
  }

  // Declare participants
  for (const p of participants) {
    const id = toParticipantId(p);
    lines.push(`  participant ${id} as ${p}`);
  }

  // Add step messages
  for (let i = 0; i < sortedSteps.length; i++) {
    const step = sortedSteps[i];
    const nextStep = sortedSteps[i + 1];

    if (!step.module || !step.action) continue;

    const fromId = toParticipantId(step.module);

    // If next step has a different module, draw arrow to next module
    // If same module or last step, draw self-arrow (note)
    if (nextStep && nextStep.module && nextStep.module !== step.module) {
      const toId = toParticipantId(nextStep.module);
      const action = escapeLabel(step.action);
      lines.push(`  ${fromId}->>+${toId}: ${action}`);
    } else {
      const action = escapeLabel(step.action);
      lines.push(`  Note over ${fromId}: ${action}`);
    }
  }

  return lines.join('\n') + '\n';
}

// =============================================================================
// Main Generation Pipeline
// =============================================================================

/**
 * Generate all Mermaid diagrams from structured YAML docs.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ diagramsGenerated: number, errors: string[] }}
 */
export function generateAll(projectRoot) {
  const docsDir = getStructuredDocsDir(projectRoot);
  const generatedDir = getGeneratedDir(projectRoot);
  let diagramsGenerated = 0;
  const errors = [];

  if (!existsSync(docsDir)) {
    return { diagramsGenerated, errors: ['No structured docs directory found.'] };
  }

  // Ensure generated directory exists
  mkdirSync(generatedDir, { recursive: true });

  // --- Generate architecture.mmd (AC-6.1) ---
  const archPath = join(docsDir, 'architecture.yaml');
  if (existsSync(archPath)) {
    try {
      const { data, content } = readAndParseYaml(archPath);
      const mmdContent = generateArchitectureMmd(data, content);
      writeFileSync(join(generatedDir, 'architecture.mmd'), mmdContent);
      diagramsGenerated++;
    } catch (err) {
      errors.push(`architecture.yaml: ${err.message}`);
    }
  }

  // --- Generate flow diagrams (AC-6.2) ---
  const flowsDir = join(docsDir, 'flows');
  const flowsIndexPath = join(flowsDir, 'index.yaml');

  if (existsSync(flowsIndexPath)) {
    try {
      const { data: indexData } = readAndParseYaml(flowsIndexPath);

      if (indexData && Array.isArray(indexData.flows)) {
        for (const flowEntry of indexData.flows) {
          if (!flowEntry.file || !flowEntry.name) continue;

          // Path confinement check: ensure flow file reference stays within flows/ directory
          try {
            confineToFlowsDir(flowEntry.file, flowsDir, projectRoot);
          } catch (err) {
            errors.push(`Flow "${flowEntry.name}": path confinement violation for "${flowEntry.file}" — skipping`);
            continue;
          }

          const flowPath = join(flowsDir, flowEntry.file);
          if (!existsSync(flowPath)) {
            errors.push(`Flow "${flowEntry.name}": referenced file "${flowEntry.file}" not found`);
            continue;
          }

          try {
            const { data: flowData, content: flowContent } = readAndParseYaml(flowPath);

            // Sanitize flow name for filename
            const safeName = flowEntry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const mmdContent = generateFlowMmd(flowData, flowContent);
            writeFileSync(join(generatedDir, `flow-${safeName}.mmd`), mmdContent);
            diagramsGenerated++;
          } catch (err) {
            errors.push(`Flow "${flowEntry.name}": ${err.message}`);
          }
        }
      }
    } catch (err) {
      errors.push(`flows/index.yaml: ${err.message}`);
    }
  }

  return { diagramsGenerated, errors };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  try {
    const projectRoot = resolveProjectRoot();
    const result = generateAll(projectRoot);

    console.log(`Generated ${result.diagramsGenerated} diagram(s).`);

    if (result.errors.length > 0) {
      console.error('\nErrors:');
      for (const err of result.errors) {
        console.error(`  ${err}`);
      }
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error(`Generation failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('docs-generate.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
