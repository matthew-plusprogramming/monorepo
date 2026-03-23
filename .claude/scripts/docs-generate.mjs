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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
  checkFileSize,
} from './lib/yaml-utils.mjs';

// =============================================================================
// Diagram-Specific Constants (DEC-001)
// =============================================================================

/** Maximum YAML source file size for diagram generation (500KB) */
export const DIAGRAM_MAX_YAML_SIZE = 500 * 1024;

/** Maximum nesting depth for diagram YAML sources */
const DIAGRAM_MAX_NESTING_DEPTH = 10;

/** Entity count threshold for module grouping */
const ENTITY_GROUP_THRESHOLD = 50;

/** Node count threshold for text-only fallback */
const ENTITY_FALLBACK_THRESHOLD = 100;

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
 * - Mermaid comment markers (%%) (stripped) (AC-3.1)
 * - Click handler keywords at word boundaries (prefixed with underscore) (AC-3.2)
 * - JavaScript callback patterns and javascript: schemes (stripped/prefixed) (AC-3.3)
 * - href attributes (stripped/prefixed) (AC-3.4)
 * - Mermaid structural keywords at word boundaries (prefixed with underscore) (AC-3.5)
 * - Special syntax characters: (), [], {}, |, <> (replaced with safe equivalents) (AC-3.6)
 *
 * @param {string} label - Display label
 * @returns {string} Escaped label safe for Mermaid rendering
 */
export function escapeLabel(label) {
  let safe = label;
  // Replace double quotes with single quotes
  safe = safe.replace(/"/g, "'");
  // Strip newlines and carriage returns to prevent multi-line injection
  safe = safe.replace(/[\r\n]+/g, ' ');
  // AC-3.1: Strip Mermaid comment markers
  safe = safe.replace(/%%/g, '');
  // AC-3.3: Strip javascript: URI schemes
  safe = safe.replace(/javascript\s*:/gi, '');
  // AC-3.3: Neutralize callback patterns
  safe = safe.replace(/\bcallback\b/gi, '_callback');
  // AC-3.4: Strip href attribute assignments
  safe = safe.replace(/\bhref\s*=/gi, '');
  safe = safe.replace(/\bhref\b/gi, '_href');
  // AC-3.2: Neutralize click handler keywords at word boundaries
  safe = safe.replace(/\bclick\b/gi, '_click');
  // AC-3.5: Neutralize Mermaid structural keywords that could break diagram syntax
  // (only at word boundaries to avoid false positives in normal text)
  safe = safe.replace(/\b(end|subgraph|graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|erDiagram)\b/gi, '_$1');
  // AC-3.6: Sanitize special syntax characters with fullwidth Unicode equivalents
  safe = safe.replace(/\(/g, '\uFF08');
  safe = safe.replace(/\)/g, '\uFF09');
  safe = safe.replace(/\[/g, '\uFF3B');
  safe = safe.replace(/\]/g, '\uFF3D');
  safe = safe.replace(/\{/g, '\uFF5B');
  safe = safe.replace(/\}/g, '\uFF5D');
  safe = safe.replace(/\|/g, '\uFF5C');
  safe = safe.replace(/</g, '\uFF1C');
  safe = safe.replace(/>/g, '\uFF1E');
  return safe;
}

/**
 * Track labels for collision detection and return a unique label.
 *
 * Per-diagram label collision detection (AC-3.8): when two different
 * input strings map to the same sanitized output, append a numeric suffix
 * to disambiguate.
 *
 * @param {string} originalName - Original unsanitized name
 * @param {Map<string, string>} labelMap - Map of sanitizedLabel -> originalName
 * @returns {string} Unique sanitized label
 */
function uniqueLabel(originalName, labelMap) {
  const sanitized = escapeLabel(originalName);
  const existing = labelMap.get(sanitized);
  if (existing === undefined) {
    labelMap.set(sanitized, originalName);
    return sanitized;
  }
  if (existing === originalName) {
    return sanitized;
  }
  // Collision: find a unique suffix
  let suffix = 2;
  while (labelMap.has(`${sanitized}-${suffix}`)) {
    suffix++;
  }
  const uniqueSanitized = `${sanitized}-${suffix}`;
  labelMap.set(uniqueSanitized, originalName);
  return uniqueSanitized;
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
// Shared Diagram Utilities
// =============================================================================

/**
 * Compute the nesting depth of a parsed YAML object.
 *
 * @param {any} obj - Parsed YAML value
 * @param {number} [currentDepth=0] - Current depth counter
 * @returns {number} Maximum nesting depth
 */
function computeNestingDepth(obj, currentDepth = 0) {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return currentDepth;
  }
  let maxDepth = currentDepth;
  const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
  for (const [, value] of entries) {
    const childDepth = computeNestingDepth(value, currentDepth + 1);
    if (childDepth > maxDepth) {
      maxDepth = childDepth;
    }
  }
  return maxDepth;
}

/**
 * Pre-check YAML file size against diagram-specific limit (DEC-001).
 * Also checks nesting depth after parse (AC-2.7, AC-2.8).
 *
 * @param {string} filePath - Path to YAML file
 * @param {any} parsedData - Parsed YAML data (for depth check)
 * @throws {DocsError} If file exceeds size or depth limits
 */
function checkDiagramLimits(filePath, parsedData) {
  // AC-2.7: Check file size against diagram-specific 500KB limit
  try {
    const stats = statSync(filePath);
    if (stats.size > DIAGRAM_MAX_YAML_SIZE) {
      throw new DocsError(
        `File exceeds diagram size limit: ${filePath} is ${stats.size} bytes (max: ${DIAGRAM_MAX_YAML_SIZE} bytes)`,
        'Size limit',
        filePath,
        { fileSize: stats.size, maxBytes: DIAGRAM_MAX_YAML_SIZE },
      );
    }
  } catch (err) {
    if (err instanceof DocsError) throw err;
    // Let readAndParseYaml handle file-not-found
  }

  // AC-2.8: Check nesting depth
  if (parsedData !== null && parsedData !== undefined) {
    const depth = computeNestingDepth(parsedData);
    if (depth > DIAGRAM_MAX_NESTING_DEPTH) {
      throw new DocsError(
        `YAML nesting depth exceeds limit: ${filePath} has depth ${depth} (max: ${DIAGRAM_MAX_NESTING_DEPTH})`,
        'Depth limit',
        filePath,
        { actualDepth: depth, maxDepth: DIAGRAM_MAX_NESTING_DEPTH },
      );
    }
  }
}

// =============================================================================
// ERD Diagram Generation (AC-1.1)
// =============================================================================

/**
 * Map relationship type strings to Mermaid erDiagram cardinality notation.
 *
 * @param {string} relType - Relationship type (e.g., "one-to-many")
 * @returns {string} Mermaid cardinality symbol
 */
function toErdRelation(relType) {
  const map = {
    'one-to-one': '||--||',
    'one-to-many': '||--o{',
    'many-to-one': '}o--||',
    'many-to-many': '}o--o{',
  };
  return map[relType] || '||--||';
}

/**
 * Generate ERD .mmd content from parsed data-models.yaml.
 *
 * Produces a Mermaid erDiagram with entities, attributes, and relationships.
 * Implements AC-1.1, AC-1.6, AC-8.1, AC-8.2, AC-8.3, AC-8.4, AC-11.1.
 *
 * @param {any} doc - Parsed data-models.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateErdMmd(doc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];

  lines.push('erDiagram');

  // AC-11.1: Accessibility directives (must appear after diagram type keyword)
  lines.push('  accTitle: Entity-Relationship Diagram');
  lines.push('  accDescr: Data model showing entities, their attributes, and relationships');

  if (!doc || !Array.isArray(doc.entities) || doc.entities.length === 0) {
    lines.push('  %% No entities defined');
    return lines.join('\n') + '\n';
  }

  const entityNames = new Set(doc.entities.filter(e => e && e.name).map(e => e.name));
  const labelMap = new Map();

  // AC-8.3, AC-8.4: Large diagram handling
  if (doc.entities.length > ENTITY_FALLBACK_THRESHOLD) {
    // Text-only fallback
    lines.length = 0;
    lines.push(`${SOURCE_HASH_PREFIX}${hash}`);
    lines.push('%% FALLBACK: Diagram exceeded 100 entities after grouping (actual: ' + doc.entities.length + ')');
    lines.push('%% Text-only entity list with relationships follows');
    for (const entity of doc.entities) {
      if (!entity || !entity.name) continue;
      const rels = (entity.relationships || [])
        .filter(r => r && r.target && entityNames.has(r.target))
        .map(r => `${r.target} (${r.type || 'related'})`)
        .join(', ');
      lines.push(`%% Entity: ${entity.name}${rels ? ' -> ' + rels : ''}`);
    }
    return lines.join('\n') + '\n';
  }

  const useSubgroups = doc.entities.length > ENTITY_GROUP_THRESHOLD;

  // Build a mapping from original entity name to safe ERD ID (AC-3.5, AC-3.8)
  // In erDiagram, the entity identifier IS the display name. We sanitize by:
  // 1. Stripping special syntax chars entirely (parens, brackets, braces, pipes, angles)
  // 2. Prefixing structural keywords with _
  // 3. Replacing remaining non-alphanumeric chars with _
  // 4. Detecting collisions at the final ID level and appending numeric suffix
  const entityIdMap = new Map();
  const nodeIdOwner = new Map(); // nodeId -> first originalName that claimed it
  for (const entity of doc.entities) {
    if (!entity || !entity.name) continue;
    // Strip special syntax chars, then sanitize keywords, then collapse to ID
    let sanitized = entity.name;
    // Strip Mermaid comment markers
    sanitized = sanitized.replace(/%%/g, '');
    // Strip javascript: schemes
    sanitized = sanitized.replace(/javascript\s*:/gi, '');
    // Neutralize callback/click/href
    sanitized = sanitized.replace(/\bcallback\b/gi, '_callback');
    sanitized = sanitized.replace(/\bhref\b/gi, '_href');
    sanitized = sanitized.replace(/\bclick\b/gi, '_click');
    // AC-3.5: Prefix structural keywords
    sanitized = sanitized.replace(/\b(end|subgraph|graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|erDiagram)\b/gi, '_$1');
    // AC-3.6/AC-3.8: Strip special syntax chars entirely (for ID-level collision)
    sanitized = sanitized.replace(/[()[\]{}<>|]/g, '');
    // Collapse to safe node ID (non-alphanumeric -> _)
    // Keep leading underscores (they may be from keyword prefixing), only trim trailing
    let candidateId = sanitized.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+$/g, '') || '_';
    // AC-3.8: Collision detection at node ID level
    const existingOwner = nodeIdOwner.get(candidateId);
    if (existingOwner !== undefined && existingOwner !== entity.name) {
      let suffix = 2;
      while (nodeIdOwner.has(`${candidateId}_${suffix}`)) {
        suffix++;
      }
      candidateId = `${candidateId}_${suffix}`;
    }
    nodeIdOwner.set(candidateId, entity.name);
    entityIdMap.set(entity.name, candidateId);
  }

  // Helper to declare a single entity with attributes
  const declareEntity = (entity) => {
    if (!entity || !entity.name) return;
    const safeId = entityIdMap.get(entity.name);
    if (!safeId) return;

    if (Array.isArray(entity.attributes) && entity.attributes.length > 0) {
      lines.push(`  ${safeId} {`);
      for (const attr of entity.attributes) {
        if (!attr || !attr.name || !attr.type) continue;
        const pk = attr.primary ? 'PK' : '';
        const attrName = toNodeId(attr.name);
        lines.push(`    ${attr.type} ${attrName}${pk ? ' PK' : ''}`);
      }
      lines.push('  }');
    }
  };

  if (useSubgroups) {
    // AC-8.3: Group entities by module into subgraph blocks
    const groups = new Map();
    for (const entity of doc.entities) {
      if (!entity || !entity.name) continue;
      const group = entity.module || 'default';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entity);
    }
    lines.push('  %% Entities grouped by module (> 50 entities)');
    for (const [groupName, groupEntities] of groups) {
      const safeGroupId = toNodeId(groupName);
      lines.push(`  subgraph ${safeGroupId}["${escapeLabel(groupName)}"]`);
      for (const entity of groupEntities) {
        declareEntity(entity);
      }
      lines.push('  end');
    }
  } else {
    // Declare entities with attributes
    for (const entity of doc.entities) {
      declareEntity(entity);
    }
  }

  // Add relationships
  for (const entity of doc.entities) {
    if (!entity || !entity.name || !Array.isArray(entity.relationships)) continue;
    for (const rel of entity.relationships) {
      if (!rel || !rel.target || !rel.type) continue;
      // AC-8.1, AC-8.2: Dangling reference handling
      if (!entityNames.has(rel.target)) {
        lines.push(`  %% WARNING: dangling reference '${rel.target}' in relationship from '${entity.name}' - skipped`);
        continue;
      }
      const fromId = entityIdMap.get(entity.name) || toNodeId(entity.name);
      const toId = entityIdMap.get(rel.target) || toNodeId(rel.target);
      const relSymbol = toErdRelation(rel.type);
      const label = rel.label ? escapeLabel(rel.label) : '';
      lines.push(`  ${fromId} ${relSymbol} ${toId} : "${label}"`);
    }
  }

  return lines.join('\n') + '\n';
}

// =============================================================================
// State Diagram Generation (AC-1.2)
// =============================================================================

/**
 * Generate state diagram .mmd content from parsed states/index.yaml.
 *
 * Produces Mermaid stateDiagram-v2 for each state machine.
 * Implements AC-1.2, AC-1.6, AC-8.1, AC-8.2, AC-11.1.
 *
 * @param {any} doc - Parsed states/index.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {{ name: string, content: string }[]} Array of named diagram contents
 */
export function generateStateMmd(doc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const results = [];

  if (!doc || !Array.isArray(doc.state_machines) || doc.state_machines.length === 0) {
    const lines = [`${SOURCE_HASH_PREFIX}${hash}`];
    lines.push('stateDiagram-v2');
    lines.push('  accTitle: State Diagram');
    lines.push('  accDescr: State machine diagram showing states and transitions');
    lines.push('  %% No state machines defined');
    results.push({ name: 'state', content: lines.join('\n') + '\n' });
    return results;
  }

  for (const machine of doc.state_machines) {
    if (!machine || !machine.name) continue;
    const lines = [`${SOURCE_HASH_PREFIX}${hash}`];
    const labelMap = new Map();

    lines.push('stateDiagram-v2');

    // AC-11.1: Accessibility directives (must appear after diagram type keyword)
    const safeMachineName = escapeLabel(machine.name);
    lines.push(`  accTitle: State Diagram - ${safeMachineName}`);
    lines.push(`  accDescr: State machine '${safeMachineName}' showing states and transitions`);

    const stateNames = new Set();
    if (Array.isArray(machine.states)) {
      for (const state of machine.states) {
        if (state && state.name) stateNames.add(state.name);
      }
    }

    // Initial state marker
    if (machine.initial && stateNames.has(machine.initial)) {
      const initialId = toNodeId(machine.initial);
      lines.push(`  [*] --> ${initialId}`);
    }

    // Declare states
    if (Array.isArray(machine.states)) {
      for (const state of machine.states) {
        if (!state || !state.name) continue;
        const stateId = toNodeId(state.name);
        const stateLabel = uniqueLabel(state.name, labelMap);
        lines.push(`  ${stateId} : ${stateLabel}`);
      }
    }

    // Add transitions
    if (Array.isArray(machine.transitions)) {
      for (const trans of machine.transitions) {
        if (!trans || !trans.from || !trans.to) continue;
        // AC-8.1, AC-8.2: Dangling reference handling
        if (!stateNames.has(trans.from)) {
          lines.push(`  %% WARNING: dangling reference '${trans.from}' in transition source - skipped`);
          continue;
        }
        if (!stateNames.has(trans.to)) {
          lines.push(`  %% WARNING: dangling reference '${trans.to}' in transition target - skipped`);
          continue;
        }
        const fromId = toNodeId(trans.from);
        const toId = toNodeId(trans.to);
        const trigger = trans.trigger ? ` : ${escapeLabel(trans.trigger)}` : '';
        lines.push(`  ${fromId} --> ${toId}${trigger}`);
      }
    }

    const safeName = machine.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    results.push({ name: safeName, content: lines.join('\n') + '\n' });
  }

  return results;
}

// =============================================================================
// Security Boundary Diagram Generation (AC-1.3)
// =============================================================================

/**
 * Generate security boundary .mmd content from parsed security.yaml.
 *
 * Produces a Mermaid flowchart TD with subgraph security zones, trust boundary
 * annotations, and data flow edges.
 * Implements AC-1.3, AC-1.6, AC-8.1, AC-8.2, AC-11.1.
 *
 * @param {any} doc - Parsed security.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateSecurityMmd(doc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];

  // AC-11.1: Accessibility directives
  lines.push('  accTitle: Security Boundary Diagram');
  lines.push('  accDescr: Security zones with trust boundaries and data flow between zones');

  lines.push('flowchart TD');

  if (!doc || !Array.isArray(doc.zones) || doc.zones.length === 0) {
    lines.push('  %% No security zones defined');
    return lines.join('\n') + '\n';
  }

  // Mark derived-from for never-sync inheritance
  lines.push('  %% derived-from: security.yaml');

  const zoneNames = new Set(doc.zones.filter(z => z && z.name).map(z => z.name));
  const labelMap = new Map();

  // Trust level styling
  lines.push('  classDef untrusted fill:#ffcccc,stroke:#cc0000,stroke-dasharray:5 5');
  lines.push('  classDef semi_trusted fill:#ffffcc,stroke:#cccc00');
  lines.push('  classDef trusted fill:#ccffcc,stroke:#00cc00');
  lines.push('  classDef highly_trusted fill:#ccccff,stroke:#0000cc,stroke-width:3px');

  // Create subgraphs for each zone
  for (const zone of doc.zones) {
    if (!zone || !zone.name) continue;
    const zoneId = toNodeId(zone.name);
    const zoneLabel = uniqueLabel(zone.name, labelMap);
    const trustAnnotation = zone.trust_level ? ` [${escapeLabel(zone.trust_level)}]` : '';

    lines.push(`  subgraph ${zoneId}["${zoneLabel}${trustAnnotation}"]`);

    if (Array.isArray(zone.components)) {
      for (const comp of zone.components) {
        if (!comp) continue;
        const compId = toNodeId(`${zone.name}_${comp}`);
        const compLabel = uniqueLabel(comp, labelMap);
        lines.push(`    ${compId}["${compLabel}"]`);
      }
    }

    lines.push('  end');

    // Apply trust level class
    const trustClass = zone.trust_level ? zone.trust_level.replace(/-/g, '_') : '';
    if (trustClass) {
      lines.push(`  class ${zoneId} ${trustClass}`);
    }
  }

  // Add data flow edges
  if (Array.isArray(doc.data_flows)) {
    for (const flow of doc.data_flows) {
      if (!flow || !flow.from || !flow.to) continue;
      // AC-8.1, AC-8.2: Dangling reference handling
      if (!zoneNames.has(flow.from)) {
        lines.push(`  %% WARNING: dangling reference '${flow.from}' in data flow source - skipped`);
        continue;
      }
      if (!zoneNames.has(flow.to)) {
        lines.push(`  %% WARNING: dangling reference '${flow.to}' in data flow target - skipped`);
        continue;
      }
      const fromId = toNodeId(flow.from);
      const toId = toNodeId(flow.to);
      const label = flow.protocol || flow.data || '';
      const edgeLabel = label ? `|"${escapeLabel(label)}"|` : '';
      lines.push(`  ${fromId} -->${edgeLabel} ${toId}`);
    }
  }

  return lines.join('\n') + '\n';
}

// =============================================================================
// Deployment Topology Diagram Generation (AC-1.4)
// =============================================================================

/**
 * Map node types to Mermaid node shapes.
 *
 * @param {string} nodeType - Infrastructure node type
 * @returns {{ open: string, close: string }} Mermaid shape delimiters
 */
function nodeShape(nodeType) {
  const shapes = {
    server: { open: '["', close: '"]' },
    container: { open: '("', close: '")' },
    database: { open: '[("', close: '")]' },
    cdn: { open: '>"', close: '"]' },
    'load-balancer': { open: '{"', close: '"}' },
    cache: { open: '("', close: '")' },
    queue: { open: '[["', close: '"]]' },
  };
  return shapes[nodeType] || shapes.server;
}

/**
 * Generate deployment topology .mmd content from parsed deployment.yaml.
 *
 * Produces a Mermaid flowchart LR with infrastructure nodes and connectivity edges.
 * Implements AC-1.4, AC-1.6, AC-8.1, AC-8.2, AC-11.1.
 *
 * @param {any} doc - Parsed deployment.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateDeploymentMmd(doc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];

  // AC-11.1: Accessibility directives
  lines.push('  accTitle: Deployment Topology Diagram');
  lines.push('  accDescr: Infrastructure deployment showing nodes, services, and connectivity');

  lines.push('flowchart LR');

  if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    lines.push('  %% No deployment nodes defined');
    return lines.join('\n') + '\n';
  }

  const nodeNames = new Set(doc.nodes.filter(n => n && n.name).map(n => n.name));
  const labelMap = new Map();

  // Declare nodes with type-specific shapes
  for (const node of doc.nodes) {
    if (!node || !node.name) continue;
    const nodeId = toNodeId(node.name);
    const label = uniqueLabel(node.name, labelMap);
    const shape = nodeShape(node.type);
    const services = Array.isArray(node.services) && node.services.length > 0
      ? `\\n${node.services.map(s => escapeLabel(String(s))).join('\\n')}`
      : '';
    lines.push(`  ${nodeId}${shape.open}${label}${services}${shape.close}`);
  }

  // Add connections
  if (Array.isArray(doc.connections)) {
    for (const conn of doc.connections) {
      if (!conn || !conn.from || !conn.to) continue;
      // AC-8.1, AC-8.2: Dangling reference handling
      if (!nodeNames.has(conn.from)) {
        lines.push(`  %% WARNING: dangling reference '${conn.from}' in connection source - skipped`);
        continue;
      }
      if (!nodeNames.has(conn.to)) {
        lines.push(`  %% WARNING: dangling reference '${conn.to}' in connection target - skipped`);
        continue;
      }
      const fromId = toNodeId(conn.from);
      const toId = toNodeId(conn.to);
      const label = conn.protocol || conn.label || '';
      const edgeLabel = label ? `|"${escapeLabel(label)}"|` : '';
      lines.push(`  ${fromId} -->${edgeLabel} ${toId}`);
    }
  }

  return lines.join('\n') + '\n';
}

// =============================================================================
// C4-Style Component Diagram Generation (AC-1.5)
// =============================================================================

/**
 * Generate C4-style component .mmd content from parsed architecture.yaml.
 *
 * Produces a Mermaid flowchart TD with C4-style naming conventions
 * (System, Container, Component labels).
 * Implements AC-1.5, AC-1.6, AC-11.1.
 *
 * @param {any} archDoc - Parsed architecture.yaml document
 * @param {string} yamlContent - Raw YAML content for hash computation
 * @returns {string} Mermaid diagram content with source-hash header
 */
export function generateComponentMmd(archDoc, yamlContent) {
  const hash = computeSourceHash(yamlContent);
  const lines = [`${SOURCE_HASH_PREFIX}${hash}`];

  // AC-11.1: Accessibility directives
  lines.push('  accTitle: C4 Component Diagram');
  lines.push('  accDescr: C4-style component diagram showing system components and their relationships');

  lines.push('flowchart TD');

  if (!archDoc || !Array.isArray(archDoc.modules) || archDoc.modules.length === 0) {
    lines.push('  %% No modules defined');
    return lines.join('\n') + '\n';
  }

  const labelMap = new Map();
  const moduleNames = new Set();
  const moduleMap = new Map();

  for (const mod of archDoc.modules) {
    if (!mod || !mod.name) continue;
    moduleNames.add(mod.name);
    moduleMap.set(mod.name, mod);
  }

  // C4 styling
  lines.push('  classDef component fill:#438DD5,stroke:#2E6DB4,color:#fff');
  lines.push('  classDef external fill:#999999,stroke:#666666,color:#fff');

  // Declare components with C4 naming
  for (const mod of archDoc.modules) {
    if (!mod || !mod.name) continue;
    const id = toNodeId(mod.name);
    const label = uniqueLabel(mod.name, labelMap);
    const desc = mod.description ? `\\n${escapeLabel(mod.description)}` : '';
    lines.push(`  ${id}["Component: ${label}${desc}"]`);
    lines.push(`  class ${id} component`);
  }

  // Helper: get dependencies
  const getDeps = (mod) => {
    const deps = mod.depends_on || mod.dependencies;
    return Array.isArray(deps) ? deps : [];
  };

  // Add dependency edges
  for (const mod of archDoc.modules) {
    if (!mod || !mod.name) continue;
    for (const dep of getDeps(mod)) {
      if (!moduleNames.has(dep)) continue;
      const fromId = toNodeId(mod.name);
      const toId = toNodeId(dep);
      lines.push(`  ${fromId} --> ${toId}`);
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

  // --- Generate ERD diagram (AC-1.1, AC-1.10) ---
  const erdPath = join(docsDir, 'data-models.yaml');
  if (existsSync(erdPath)) {
    try {
      checkDiagramLimits(erdPath, null);
      const { data, content } = readAndParseYaml(erdPath);
      checkDiagramLimits(erdPath, data);
      const mmdContent = generateErdMmd(data, content);
      writeFileSync(join(generatedDir, 'erd.mmd'), mmdContent);
      diagramsGenerated++;
    } catch (err) {
      errors.push(`data-models.yaml: ${err.message}`);
    }
  }

  // --- Generate state diagrams (AC-1.2, AC-1.10) ---
  const statesPath = join(docsDir, 'states', 'index.yaml');
  if (existsSync(statesPath)) {
    try {
      checkDiagramLimits(statesPath, null);
      const { data, content } = readAndParseYaml(statesPath);
      checkDiagramLimits(statesPath, data);
      const diagrams = generateStateMmd(data, content);
      for (const diagram of diagrams) {
        writeFileSync(join(generatedDir, `state-${diagram.name}.mmd`), diagram.content);
        diagramsGenerated++;
      }
    } catch (err) {
      errors.push(`states/index.yaml: ${err.message}`);
    }
  }

  // --- Generate security boundary diagram (AC-1.3, AC-1.10) ---
  const securityPath = join(docsDir, 'security.yaml');
  if (existsSync(securityPath)) {
    try {
      checkDiagramLimits(securityPath, null);
      const { data, content } = readAndParseYaml(securityPath);
      checkDiagramLimits(securityPath, data);
      const mmdContent = generateSecurityMmd(data, content);
      writeFileSync(join(generatedDir, 'security.mmd'), mmdContent);
      diagramsGenerated++;
    } catch (err) {
      errors.push(`security.yaml: ${err.message}`);
    }
  }

  // --- Generate deployment topology diagram (AC-1.4, AC-1.10) ---
  const deployPath = join(docsDir, 'deployment.yaml');
  if (existsSync(deployPath)) {
    try {
      checkDiagramLimits(deployPath, null);
      const { data, content } = readAndParseYaml(deployPath);
      checkDiagramLimits(deployPath, data);
      const mmdContent = generateDeploymentMmd(data, content);
      writeFileSync(join(generatedDir, 'deployment.mmd'), mmdContent);
      diagramsGenerated++;
    } catch (err) {
      errors.push(`deployment.yaml: ${err.message}`);
    }
  }

  // --- Generate C4 component diagram (AC-1.5, AC-1.10) ---
  // Uses existing architecture.yaml as source (no new template needed)
  if (existsSync(archPath)) {
    try {
      const { data, content } = readAndParseYaml(archPath);
      const mmdContent = generateComponentMmd(data, content);
      writeFileSync(join(generatedDir, 'component-c4.mmd'), mmdContent);
      diagramsGenerated++;
    } catch (err) {
      errors.push(`architecture.yaml (C4 component): ${err.message}`);
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
