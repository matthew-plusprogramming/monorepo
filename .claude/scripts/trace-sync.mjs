#!/usr/bin/env node

/**
 * Trace Sync Script (Markdown-to-JSON)
 *
 * Parses structured sections from markdown trace files and updates
 * the corresponding JSON trace files. Freeform sections (those with
 * "(not synced)" in the heading) are explicitly ignored.
 *
 * Structured sections synced:
 *   - HTML comment metadata (trace-id, trace-version, last-generated, generated-by)
 *   - Dependencies (pipe-delimited: target | relationship-type | description)
 *   - Dependents (pipe-delimited: target | relationship-type | description)
 *   - Exports (pipe-delimited: symbol | type | line | signature)
 *   - Imports (pipe-delimited: source | symbols)
 *   - Function Calls (pipe-delimited: callerFile | callerLine | calleeName | calleeFile | calleeLine)
 *   - Events (pipe-delimited: file | line | eventName | type)
 *
 * Conflict detection (as-012):
 *   When both markdown and JSON have been modified since the last generation,
 *   the sync detects conflicts and reports them without auto-resolving.
 *   Use --force to override (markdown wins). Use --dry-run to preview changes.
 *
 * Usage:
 *   node .claude/scripts/trace-sync.mjs                  # Sync all (with conflict detection)
 *   node .claude/scripts/trace-sync.mjs --force          # Force sync (markdown wins, skip conflict checks)
 *   node .claude/scripts/trace-sync.mjs --dry-run        # Preview changes without writing
 *   node .claude/scripts/trace-sync.mjs --auto-merge     # Auto-merge additions; flag deletions/modifications
 *
 * Implements: REQ-AT-013, REQ-AT-014, REQ-AT-015, REQ-AT-016
 * Spec: as-011-trace-sync-core, as-012-trace-sync-conflicts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import {
  resolveProjectRoot,
  HIGH_LEVEL_TRACE_PATH,
  LOW_LEVEL_TRACE_DIR,
} from './lib/trace-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

const HIGH_LEVEL_MD_PATH = '.claude/traces/high-level.md';
const LOW_LEVEL_MD_DIR = '.claude/traces/low-level';

/**
 * Write sidecar calls file using atomic write-then-rename.
 *
 * AC-8.5: Writes calls data to sidecar file when sync updates calls.
 *
 * @param {string} jsonPath - Path to the main trace JSON file (used to derive sidecar path)
 * @param {object} updatedJson - Updated trace JSON (with callsFile reference)
 * @param {object} sidecarCalls - Per-file keyed calls data
 */
function writeSidecarCallsFile(jsonPath, updatedJson, sidecarCalls) {
  if (!updatedJson.callsFile) return;

  const dir = dirname(jsonPath);
  const sidecarPath = join(dir, updatedJson.callsFile);
  const sidecarTmpPath = `${sidecarPath}.tmp.${process.pid}`;

  try {
    writeFileSync(sidecarTmpPath, JSON.stringify(sidecarCalls, null, 2) + '\n');
    renameSync(sidecarTmpPath, sidecarPath);
  } catch (err) {
    process.stderr.write(
      `[trace-sync] WARNING: Failed to write sidecar ${updatedJson.callsFile}: ${err.message}\n`
    );
    try { unlinkSync(sidecarTmpPath); } catch { /* best-effort cleanup */ }
  }
}

// =============================================================================
// HTML Comment Metadata Parser
// =============================================================================

/**
 * Parse HTML comment metadata from markdown content.
 *
 * Extracts trace-id, trace-version, last-generated, generated-by from
 * HTML comments in the format: <!-- key: value -->
 *
 * AC-10.1: Syncs metadata changes back to JSON
 *
 * @param {string} markdown - Markdown file content
 * @returns {{ traceId: string|null, traceVersion: number|null, lastGenerated: string|null, generatedBy: string|null }}
 */
export function parseHtmlCommentMetadata(markdown) {
  const metadata = {
    traceId: null,
    traceVersion: null,
    lastGenerated: null,
    generatedBy: null,
  };

  const metadataPatterns = [
    { key: 'traceId', pattern: /<!--\s*trace-id:\s*(.+?)\s*-->/ },
    { key: 'traceVersion', pattern: /<!--\s*trace-version:\s*(.+?)\s*-->/ },
    { key: 'lastGenerated', pattern: /<!--\s*last-generated:\s*(.+?)\s*-->/ },
    { key: 'generatedBy', pattern: /<!--\s*generated-by:\s*(.+?)\s*-->/ },
  ];

  for (const { key, pattern } of metadataPatterns) {
    const match = markdown.match(pattern);
    if (match) {
      const value = match[1].trim();
      if (key === 'traceVersion') {
        const parsed = parseInt(value, 10);
        metadata[key] = Number.isNaN(parsed) ? null : parsed;
      } else {
        metadata[key] = value;
      }
    }
  }

  return metadata;
}

// =============================================================================
// Pipe-Delimited Line Parser
// =============================================================================

/**
 * Parse a single pipe-delimited line into an array of trimmed fields.
 *
 * AC-10.4: Reports structural errors for malformed lines (missing pipes, wrong column count).
 *
 * @param {string} line - A single pipe-delimited line (e.g., "target | relationship-type | description")
 * @param {number} expectedColumns - Expected number of columns
 * @param {string} context - Context string for error messages (e.g., "high-level.md:Dependencies:line 3")
 * @returns {{ fields: string[]|null, error: string|null }}
 */
export function parsePipeDelimitedLine(line, expectedColumns, context) {
  const trimmed = line.trim();

  // Skip empty lines, placeholder lines, and markdown emphasis lines
  if (!trimmed || trimmed === '(none)' || trimmed.startsWith('_')) {
    return { fields: null, error: null };
  }

  const fields = trimmed.split('|').map(f => f.trim());

  if (fields.length !== expectedColumns) {
    return {
      fields: null,
      error: `${context}: expected ${expectedColumns} columns, got ${fields.length} in line: "${trimmed}"`,
    };
  }

  // Note: Empty trailing fields are allowed (e.g., signature column for non-function exports,
  // calleeFile/calleeLine for unresolved calls). Section-specific parsers handle null/empty semantics.

  return { fields, error: null };
}

/**
 * Parse multiple pipe-delimited lines from a section, skipping the header line.
 *
 * @param {string[]} lines - Lines in the section (including header line)
 * @param {number} expectedColumns - Expected number of columns
 * @param {string} context - Context for error messages
 * @returns {{ entries: string[][], errors: string[] }}
 */
export function parsePipeDelimitedSection(lines, expectedColumns, context) {
  const entries = [];
  const errors = [];

  // Find the header line (first pipe-delimited line)
  let headerFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and non-data lines
    if (!line || line.startsWith('#') || line === '(none)' || line.startsWith('_')) {
      continue;
    }

    // Skip markdown table separator lines (e.g., "--- | --- | ---")
    if (line.includes('|') && /^[-|\s]+$/.test(line)) {
      continue;
    }

    // First pipe-delimited line is the header -- skip it
    if (!headerFound && line.includes('|')) {
      headerFound = true;
      continue;
    }

    // Subsequent pipe-delimited lines are data
    if (line.includes('|')) {
      const result = parsePipeDelimitedLine(line, expectedColumns, `${context}:line ${i + 1}`);
      if (result.error) {
        errors.push(result.error);
      } else if (result.fields) {
        entries.push(result.fields);
      }
    }
  }

  return { entries, errors };
}

// =============================================================================
// Section Extraction
// =============================================================================

/**
 * Check if a section heading contains "(not synced)" -- indicating freeform content.
 *
 * AC-10.2: Freeform sections are ignored during sync.
 *
 * @param {string} heading - Section heading text
 * @returns {boolean} True if the section should be skipped
 */
export function isNotSyncedSection(heading) {
  return heading.toLowerCase().includes('(not synced)');
}

/**
 * Split markdown into sections based on heading levels.
 *
 * @param {string} markdown - Full markdown content
 * @param {number} level - Heading level (2 = ##, 3 = ###)
 * @returns {Array<{ heading: string, lines: string[] }>}
 */
export function splitIntoSections(markdown, level) {
  const prefix = '#'.repeat(level) + ' ';
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith(prefix) && !line.startsWith(prefix + '#')) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: line.slice(prefix.length).trim(),
        lines: [],
      };
    } else if (current) {
      // Stop collecting if we hit a higher-level heading
      if (level > 2 && line.startsWith('## ') && !line.startsWith('### ')) {
        sections.push(current);
        current = null;
      } else {
        current.lines.push(line);
      }
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

// =============================================================================
// High-Level Markdown Parser
// =============================================================================

/**
 * Parse a high-level markdown trace file into structured data.
 *
 * Extracts metadata, and for each module: dependencies and dependents.
 * Ignores "(not synced)" sections.
 *
 * @param {string} markdown - High-level markdown content
 * @returns {{ metadata: object, modules: Array<{ id: string, dependencies: object[], dependents: object[] }>, errors: string[] }}
 */
export function parseHighLevelMarkdown(markdown) {
  const metadata = parseHtmlCommentMetadata(markdown);
  const errors = [];
  const modules = [];

  // Split by ## (level 2) to get module sections
  const moduleSections = splitIntoSections(markdown, 2);

  for (const section of moduleSections) {
    // Skip non-module sections and "(not synced)" sections
    if (!section.heading.startsWith('Module:')) {
      if (isNotSyncedSection(section.heading)) {
        continue; // AC-10.2: skip freeform
      }
      continue;
    }

    // Extract module ID from **ID**: <id> line
    const idMatch = section.lines.join('\n').match(/\*\*ID\*\*:\s*(\S+)/);
    if (!idMatch) {
      errors.push(`Module "${section.heading}": could not extract module ID`);
      continue;
    }

    const moduleId = idMatch[1];
    const dependencies = [];
    const dependents = [];

    // Split the module section into ### subsections
    const subSections = splitIntoSections(
      section.lines.join('\n'),
      3,
    );

    for (const sub of subSections) {
      // AC-10.2: skip "(not synced)" subsections
      if (isNotSyncedSection(sub.heading)) {
        continue;
      }

      if (sub.heading === 'Dependencies') {
        const result = parsePipeDelimitedSection(
          sub.lines,
          3,
          `high-level.md:${moduleId}:Dependencies`,
        );
        for (const [targetId, relationshipType, description] of result.entries) {
          dependencies.push({ targetId, relationshipType, description });
        }
        errors.push(...result.errors);
      }

      if (sub.heading === 'Dependents') {
        const result = parsePipeDelimitedSection(
          sub.lines,
          3,
          `high-level.md:${moduleId}:Dependents`,
        );
        for (const [targetId, relationshipType, description] of result.entries) {
          dependents.push({ targetId, relationshipType, description });
        }
        errors.push(...result.errors);
      }
    }

    modules.push({ id: moduleId, dependencies, dependents });
  }

  return { metadata, modules, errors };
}

// =============================================================================
// Low-Level Markdown Parser
// =============================================================================

/**
 * Parse a low-level markdown trace file into structured data.
 *
 * Extracts metadata, and for each file: exports, imports, calls, events.
 * Ignores "(not synced)" sections.
 *
 * @param {string} markdown - Low-level markdown content
 * @returns {{ metadata: object, files: Array<{ filePath: string, exports: object[], imports: object[], calls: object[], events: object[] }>, errors: string[] }}
 */
export function parseLowLevelMarkdown(markdown) {
  const metadata = parseHtmlCommentMetadata(markdown);
  const errors = [];
  const files = [];

  // Split by ## (level 2) to get file sections
  const fileSections = splitIntoSections(markdown, 2);

  for (const section of fileSections) {
    // Skip "(not synced)" sections
    if (isNotSyncedSection(section.heading)) {
      continue; // AC-10.2: skip freeform
    }

    // Extract file path from "File: <path>" heading
    if (!section.heading.startsWith('File:')) {
      continue;
    }

    const filePath = section.heading.slice('File:'.length).trim();
    if (!filePath) {
      errors.push(`Low-level markdown: empty file path in heading "${section.heading}"`);
      continue;
    }

    const fileEntry = {
      filePath,
      exports: [],
      imports: [],
      calls: [],
      events: [],
    };

    // Split into ### subsections
    const subSections = splitIntoSections(section.lines.join('\n'), 3);

    for (const sub of subSections) {
      // AC-10.2: skip "(not synced)" subsections
      if (isNotSyncedSection(sub.heading)) {
        continue;
      }

      if (sub.heading === 'Exports') {
        // INC-012: Generator renders 4 columns (symbol | type | line | signature);
        // parse all 4 to stay in sync with trace-generate.mjs
        const result = parsePipeDelimitedSection(sub.lines, 4, `${filePath}:Exports`);
        for (const [symbol, type, lineNum, signature] of result.entries) {
          const entry = { symbol, type };
          if (lineNum) entry.lineNumber = parseInt(lineNum, 10);
          if (signature) entry.signature = signature;
          fileEntry.exports.push(entry);
        }
        errors.push(...result.errors);
      }

      if (sub.heading === 'Imports') {
        const result = parsePipeDelimitedSection(sub.lines, 2, `${filePath}:Imports`);
        for (const [source, symbolsStr] of result.entries) {
          const symbols = symbolsStr === '(side-effect)'
            ? []
            : symbolsStr.split(',').map(s => s.trim()).filter(Boolean);
          fileEntry.imports.push({ source, symbols });
        }
        errors.push(...result.errors);
      }

      if (sub.heading === 'Function Calls') {
        // M1: Updated to 5-column format per contract-calls-events-schema
        // Columns: callerFile | callerLine | calleeName | calleeFile | calleeLine
        const result = parsePipeDelimitedSection(sub.lines, 5, `${filePath}:Function Calls`);
        for (const [callerFile, callerLineStr, calleeName, calleeFile, calleeLineStr] of result.entries) {
          fileEntry.calls.push({
            callerFile,
            callerLine: parseInt(callerLineStr, 10),
            calleeName,
            // Handle '(none)' placeholder as null (used for unresolved callees)
            calleeFile: calleeFile === '(none)' ? null : calleeFile,
            calleeLine: calleeLineStr === '(none)' ? null : parseInt(calleeLineStr, 10),
          });
        }
        errors.push(...result.errors);
      }

      if (sub.heading === 'Events') {
        // M1: Updated to 4-column format per contract-calls-events-schema
        // Columns: file | line | eventName | type
        const result = parsePipeDelimitedSection(sub.lines, 4, `${filePath}:Events`);
        for (const [evtFile, lineStr, eventName, type] of result.entries) {
          fileEntry.events.push({
            file: evtFile,
            line: parseInt(lineStr, 10),
            eventName,
            type,
          });
        }
        errors.push(...result.errors);
      }
    }

    files.push(fileEntry);
  }

  return { metadata, files, errors };
}

// =============================================================================
// Conflict Detection (as-012)
// =============================================================================

/**
 * Detect conflicts between parsed high-level markdown and current JSON state.
 *
 * A conflict occurs when a field differs between the parsed markdown and the
 * current JSON. This means both sides may have been edited independently.
 * The sync command reports these conflicts without auto-resolving them.
 *
 * AC-10.5: Reports conflict with both markdown state and JSON state.
 *
 * @param {object} existingJson - Current high-level.json content
 * @param {{ modules: Array<{ id: string, dependencies: object[], dependents: object[] }> }} parsedMd - Parsed markdown data
 * @returns {Array<{ module: string, field: string, jsonValue: object[], markdownValue: object[] }>}
 */
export function detectHighLevelConflicts(existingJson, parsedMd) {
  const conflicts = [];

  for (const parsedModule of parsedMd.modules) {
    const jsonModule = existingJson.modules.find(m => m.id === parsedModule.id);
    if (!jsonModule) {
      continue; // Module not in JSON -- not a conflict, just a skip
    }

    // Check dependencies for conflict
    if (!arraysDeepEqual(jsonModule.dependencies, parsedModule.dependencies)) {
      conflicts.push({
        module: parsedModule.id,
        field: 'dependencies',
        jsonValue: jsonModule.dependencies,
        markdownValue: parsedModule.dependencies,
      });
    }

    // Check dependents for conflict
    if (!arraysDeepEqual(jsonModule.dependents, parsedModule.dependents)) {
      conflicts.push({
        module: parsedModule.id,
        field: 'dependents',
        jsonValue: jsonModule.dependents,
        markdownValue: parsedModule.dependents,
      });
    }
  }

  return conflicts;
}

/**
 * Detect conflicts between parsed low-level markdown and current JSON state.
 *
 * A conflict occurs when any structured field (exports, imports, calls, events)
 * differs between parsed markdown and the current JSON. Both values are
 * reported for user resolution.
 *
 * AC-10.5: Reports conflict with both markdown state and JSON state.
 *
 * @param {object} existingJson - Current low-level/<module>.json content
 * @param {{ files: Array<{ filePath: string, exports: object[], imports: object[], calls: object[], events: object[] }> }} parsedMd - Parsed markdown data
 * @returns {Array<{ module: string, field: string, jsonValue: object[], markdownValue: object[] }>}
 */
export function detectLowLevelConflicts(existingJson, parsedMd) {
  const conflicts = [];

  for (const parsedFile of parsedMd.files) {
    const jsonFile = existingJson.files.find(f => f.filePath === parsedFile.filePath);
    if (!jsonFile) {
      continue; // File not in JSON -- not a conflict
    }

    const fields = ['exports', 'imports', 'calls', 'events'];
    for (const field of fields) {
      if (!arraysDeepEqual(jsonFile[field], parsedFile[field])) {
        conflicts.push({
          module: parsedFile.filePath,
          field,
          jsonValue: jsonFile[field],
          markdownValue: parsedFile[field],
        });
      }
    }
  }

  return conflicts;
}

// =============================================================================
// Auto-Merge Classification (REQ-024)
// =============================================================================

/**
 * Classify a conflict as addition, deletion, or modification.
 *
 * REQ-024: Additions-only divergence is auto-mergeable. Deletions and
 * modifications require manual confirmation.
 *
 * Classification rules:
 * - Addition: entry exists in markdown but not in JSON
 * - Deletion: entry exists in JSON but not in markdown
 * - Modification: entry exists in both but with different values
 *
 * @param {Array} jsonArray - Array from JSON side
 * @param {Array} mdArray - Array from markdown side
 * @param {function} keyFn - Function to extract a unique key from an entry
 * @returns {{ additions: Array, deletions: Array, modifications: Array }}
 */
export function classifyDivergence(jsonArray, mdArray, keyFn) {
  const jsonByKey = new Map();
  const mdByKey = new Map();

  for (const entry of jsonArray) {
    jsonByKey.set(keyFn(entry), entry);
  }
  for (const entry of mdArray) {
    mdByKey.set(keyFn(entry), entry);
  }

  const additions = [];
  const deletions = [];
  const modifications = [];

  // Entries in markdown but not in JSON => additions
  for (const [key, entry] of mdByKey) {
    if (!jsonByKey.has(key)) {
      additions.push(entry);
    } else {
      // Both have it -- check if values differ
      const jsonEntry = jsonByKey.get(key);
      if (JSON.stringify(jsonEntry) !== JSON.stringify(entry)) {
        modifications.push({ json: jsonEntry, markdown: entry });
      }
    }
  }

  // Entries in JSON but not in markdown => deletions
  for (const [key] of jsonByKey) {
    if (!mdByKey.has(key)) {
      deletions.push(jsonByKey.get(key));
    }
  }

  return { additions, deletions, modifications };
}

/**
 * Generate a key function for a given field type.
 *
 * Returns a function that extracts a unique identifier from an entry,
 * used for comparing JSON and markdown entries during auto-merge classification.
 *
 * @param {string} field - Field name ('exports', 'imports', 'calls', 'events', 'dependencies', 'dependents')
 * @returns {function} Key extraction function
 */
export function getKeyFn(field) {
  switch (field) {
    case 'exports':
      return (e) => e.symbol || '';
    case 'imports':
      return (e) => e.source || '';
    case 'calls':
      return (e) => `${e.callerFile || ''}:${e.callerLine || 0}->${e.calleeName || ''}`;
    case 'events':
      return (e) => `${e.file || ''}:${e.line || 0}:${e.eventName || ''}:${e.type || ''}`;
    case 'dependencies':
    case 'dependents':
      return (e) => e.targetId || '';
    default:
      return (e) => JSON.stringify(e);
  }
}

/**
 * Classify all conflicts for auto-merge eligibility.
 *
 * For each conflict, determines if it consists of additions-only (auto-mergeable)
 * or contains deletions/modifications (requires manual resolution).
 *
 * @param {Array<{ module: string, field: string, jsonValue: Array, markdownValue: Array }>} conflicts
 * @returns {{ autoMergeable: Array<{ conflict: object, additions: Array }>, manual: Array<{ conflict: object, deletions: Array, modifications: Array }> }}
 */
export function classifyConflictsForAutoMerge(conflicts) {
  const autoMergeable = [];
  const manual = [];

  for (const conflict of conflicts) {
    const keyFn = getKeyFn(conflict.field);
    const { additions, deletions, modifications } = classifyDivergence(
      conflict.jsonValue || [],
      conflict.markdownValue || [],
      keyFn,
    );

    if (deletions.length === 0 && modifications.length === 0 && additions.length > 0) {
      // Additions-only: safe to auto-merge
      autoMergeable.push({ conflict, additions });
    } else if (deletions.length > 0 || modifications.length > 0) {
      // Has deletions or modifications: requires manual resolution
      manual.push({ conflict, additions, deletions, modifications });
    }
    // If no changes at all (shouldn't happen since it's a conflict), skip
  }

  return { autoMergeable, manual };
}

/**
 * Apply auto-merge for additions-only conflicts.
 *
 * Merges additions from markdown into the JSON data (JSON + markdown additions).
 * Returns the merged array and a log entry describing what was merged.
 *
 * @param {Array} jsonArray - Current JSON array
 * @param {Array} additions - Entries to add from markdown
 * @returns {Array} Merged array (JSON entries + additions)
 */
export function applyAutoMerge(jsonArray, additions) {
  // Return JSON entries plus new additions from markdown
  return [...jsonArray, ...additions];
}

/**
 * Format an auto-merge dry-run log.
 *
 * REQ-024: After auto-merge, produce a dry-run log showing what was merged.
 *
 * @param {Array<{ conflict: object, additions: Array }>} mergedItems - Items that were auto-merged
 * @param {Array<{ conflict: object, deletions: Array, modifications: Array }>} manualItems - Items requiring manual resolution
 * @returns {string[]} Array of log lines
 */
export function formatAutoMergeLog(mergedItems, manualItems) {
  const lines = [];

  if (mergedItems.length > 0) {
    lines.push('Auto-merged (additions-only):');
    for (const item of mergedItems) {
      const { conflict, additions } = item;
      lines.push(`  ${conflict.module} -> ${conflict.field}: +${additions.length} addition(s)`);
      for (const addition of additions) {
        lines.push(`    + ${JSON.stringify(addition)}`);
      }
    }
  }

  if (manualItems.length > 0) {
    lines.push('');
    lines.push('Requires manual resolution (deletions/modifications detected):');
    for (const item of manualItems) {
      const { conflict, deletions, modifications } = item;
      const parts = [];
      if (deletions.length > 0) parts.push(`${deletions.length} deletion(s)`);
      if (modifications.length > 0) parts.push(`${modifications.length} modification(s)`);
      lines.push(`  ${conflict.module} -> ${conflict.field}: ${parts.join(', ')}`);
    }
  }

  return lines;
}

/**
 * Detect whether JSON and markdown have diverged from the same generation.
 *
 * When markdown is generated from JSON, both share the same lastGenerated
 * timestamp. If the JSON is later regenerated (updating its lastGenerated),
 * but the markdown still has the old timestamp, the two have diverged.
 * Any field differences in this state are conflicts.
 *
 * @param {string|null} jsonLastGenerated - lastGenerated from JSON file
 * @param {string|null} mdLastGenerated - lastGenerated parsed from markdown
 * @returns {boolean} True if JSON was regenerated after markdown was last synced
 */
export function jsonDivergedFromMarkdown(jsonLastGenerated, mdLastGenerated) {
  // If either is missing, cannot determine divergence -- assume safe
  if (!jsonLastGenerated || !mdLastGenerated) {
    return false;
  }

  // If timestamps match, JSON and markdown are from the same generation
  if (jsonLastGenerated === mdLastGenerated) {
    return false;
  }

  // Timestamps differ -- JSON was regenerated since markdown was last generated
  return true;
}

/**
 * Check if a JSON file has been modified since its lastGenerated timestamp.
 *
 * Used to determine if the JSON was independently modified (e.g., by re-running
 * trace generate) since the markdown was last generated from it. If the file's
 * mtime is significantly newer than lastGenerated, the JSON was modified.
 *
 * @param {string} jsonPath - Absolute path to the JSON file
 * @param {string|null} lastGenerated - ISO 8601 timestamp from JSON metadata
 * @returns {boolean} True if JSON was modified after lastGenerated
 */
export function jsonModifiedSinceGeneration(jsonPath, lastGenerated) {
  if (!lastGenerated) {
    return false; // No baseline -- cannot determine modification
  }

  try {
    const stat = statSync(jsonPath);
    const generatedTime = new Date(lastGenerated).getTime();
    if (Number.isNaN(generatedTime)) {
      return false;
    }

    // Allow 1 second tolerance for filesystem timestamp precision
    const TOLERANCE_MS = 1000;
    return stat.mtimeMs > generatedTime + TOLERANCE_MS;
  } catch {
    return false;
  }
}

/**
 * Format a conflict report for display.
 *
 * AC-10.5: Displays both markdown state and JSON state for each conflict.
 *
 * @param {Array<{ module: string, field: string, jsonValue: object[], markdownValue: object[] }>} conflicts
 * @returns {string[]} Array of formatted conflict lines
 */
export function formatConflictReport(conflicts) {
  const lines = [];

  for (const conflict of conflicts) {
    lines.push(`CONFLICT: ${conflict.module} -> ${conflict.field}`);
    lines.push(`  JSON value:     ${JSON.stringify(conflict.jsonValue)}`);
    lines.push(`  Markdown value: ${JSON.stringify(conflict.markdownValue)}`);
  }

  return lines;
}

// =============================================================================
// JSON Update Logic
// =============================================================================

/**
 * Apply parsed high-level markdown data to existing JSON.
 *
 * AC-10.1: Updates dependencies/dependents in JSON from parsed markdown.
 *
 * @param {object} existingJson - Current high-level.json content
 * @param {{ metadata: object, modules: Array }} parsedMd - Parsed markdown data
 * @returns {{ updatedJson: object, changes: string[] }}
 */
export function applyHighLevelSync(existingJson, parsedMd) {
  const changes = [];
  const updatedJson = JSON.parse(JSON.stringify(existingJson)); // Deep clone

  for (const parsedModule of parsedMd.modules) {
    const jsonModule = updatedJson.modules.find(m => m.id === parsedModule.id);
    if (!jsonModule) {
      changes.push(`Skipped module "${parsedModule.id}" (not found in JSON)`);
      continue;
    }

    // Compare and update dependencies
    const depsChanged = !arraysDeepEqual(jsonModule.dependencies, parsedModule.dependencies);
    if (depsChanged) {
      const oldCount = jsonModule.dependencies.length;
      const newCount = parsedModule.dependencies.length;
      jsonModule.dependencies = parsedModule.dependencies;
      changes.push(
        `Updated ${newCount} dependencies in ${parsedModule.id} (was ${oldCount})`,
      );
    }

    // Compare and update dependents
    const dependentsChanged = !arraysDeepEqual(jsonModule.dependents, parsedModule.dependents);
    if (dependentsChanged) {
      const oldCount = jsonModule.dependents.length;
      const newCount = parsedModule.dependents.length;
      jsonModule.dependents = parsedModule.dependents;
      changes.push(
        `Updated ${newCount} dependents in ${parsedModule.id} (was ${oldCount})`,
      );
    }
  }

  return { updatedJson, changes };
}

/**
 * Apply parsed low-level markdown data to existing JSON.
 *
 * @param {object} existingJson - Current low-level/<module>.json content
 * @param {{ metadata: object, files: Array }} parsedMd - Parsed markdown data
 * @returns {{ updatedJson: object, changes: string[] }}
 */
export function applyLowLevelSync(existingJson, parsedMd) {
  const changes = [];
  const updatedJson = JSON.parse(JSON.stringify(existingJson)); // Deep clone

  // AC-8.5: Track sidecar calls data separately from main JSON
  // Load existing sidecar data if callsFile reference exists
  let sidecarCalls = {};
  const hasSidecarFormat = typeof updatedJson.callsFile === 'string';

  // If existing JSON already has sidecar format, initialize sidecar with existing file data
  if (hasSidecarFormat) {
    for (const file of updatedJson.files) {
      sidecarCalls[file.filePath] = []; // Initialize empty
    }
  }

  let callsChanged = false;

  for (const parsedFile of parsedMd.files) {
    const jsonFile = updatedJson.files.find(f => f.filePath === parsedFile.filePath);
    if (!jsonFile) {
      changes.push(`Skipped file "${parsedFile.filePath}" (not found in JSON)`);
      continue;
    }

    // Compare and update exports
    if (!arraysDeepEqual(jsonFile.exports, parsedFile.exports)) {
      jsonFile.exports = parsedFile.exports;
      changes.push(`Updated exports in ${parsedFile.filePath}`);
    }

    // Compare and update imports
    if (!arraysDeepEqual(jsonFile.imports, parsedFile.imports)) {
      jsonFile.imports = parsedFile.imports;
      changes.push(`Updated imports in ${parsedFile.filePath}`);
    }

    // AC-8.5: Compare and update calls -- write to sidecar, not inline
    // For comparison, use existing inline calls or empty (sidecar format has no inline calls)
    const existingCalls = Array.isArray(jsonFile.calls) ? jsonFile.calls : [];
    if (!arraysDeepEqual(existingCalls, parsedFile.calls)) {
      callsChanged = true;
      changes.push(`Updated function calls in ${parsedFile.filePath}`);
    }
    // Always populate sidecar data with parsed calls
    sidecarCalls[parsedFile.filePath] = parsedFile.calls;

    // AC-8.5: Remove inline calls from main JSON (never re-introduce)
    delete jsonFile.calls;

    // Compare and update events
    if (!arraysDeepEqual(jsonFile.events, parsedFile.events)) {
      jsonFile.events = parsedFile.events;
      changes.push(`Updated events in ${parsedFile.filePath}`);
    }
  }

  // AC-8.5: Ensure callsFile reference exists on main JSON
  if (!updatedJson.callsFile && updatedJson.moduleId) {
    updatedJson.callsFile = `${updatedJson.moduleId}.calls.json`;
  }

  return { updatedJson, changes, sidecarCalls, callsChanged };
}

// =============================================================================
// Utility: Deep Comparison
// =============================================================================

/**
 * Deep compare two arrays of objects for equality.
 *
 * @param {Array} a - First array
 * @param {Array} b - Second array
 * @returns {boolean} True if arrays are deeply equal
 */
export function arraysDeepEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// =============================================================================
// Sync Summary (as-012, AC-10.3)
// =============================================================================

/**
 * Build a sync completion summary.
 *
 * AC-10.3: Outputs summary including modules updated, fields changed per module,
 * conflicts detected, and parsing errors encountered.
 *
 * @param {object} params
 * @param {string[]} params.changes - List of change descriptions
 * @param {string[]} params.errors - List of parsing errors
 * @param {Array<{ module: string, field: string }>} params.conflicts - Detected conflicts
 * @param {number} params.filesUpdated - Number of JSON files written
 * @param {boolean} params.dryRun - Whether this was a dry-run
 * @returns {{ text: string, modulesUpdated: number, fieldsChanged: number, conflictsDetected: number, errorsEncountered: number }}
 */
export function buildSyncSummary({ changes, errors, conflicts, filesUpdated, dryRun }) {
  // Count fields changed per module
  const moduleFieldCounts = {};
  for (const change of changes) {
    // Extract module name from change strings like "Updated 2 dependencies in dev-team (was 1)"
    // or "[dev-team] Updated exports in path/file.py"
    const bracketMatch = change.match(/^\[([^\]]+)\]/);
    const inMatch = change.match(/in\s+(\S+)/);
    const moduleName = bracketMatch ? bracketMatch[1] : (inMatch ? inMatch[1] : 'unknown');
    moduleFieldCounts[moduleName] = (moduleFieldCounts[moduleName] || 0) + 1;
  }

  const modulesUpdated = Object.keys(moduleFieldCounts).length;
  const fieldsChanged = changes.filter(c => !c.startsWith('Skipped')).length;
  const conflictsDetected = conflicts.length;
  const errorsEncountered = errors.length;

  const lines = [];
  const prefix = dryRun ? '[DRY RUN] ' : '';

  lines.push(`${prefix}Trace sync summary:`);
  lines.push(`  Modules updated:    ${modulesUpdated}`);
  lines.push(`  Fields changed:     ${fieldsChanged}`);
  lines.push(`  Conflicts detected: ${conflictsDetected}`);
  lines.push(`  Parsing errors:     ${errorsEncountered}`);

  if (Object.keys(moduleFieldCounts).length > 0) {
    lines.push('');
    lines.push('  Changes per module:');
    for (const [mod, count] of Object.entries(moduleFieldCounts)) {
      lines.push(`    ${mod}: ${count} field(s)`);
    }
  }

  const text = lines.join('\n');
  return { text, modulesUpdated, fieldsChanged, conflictsDetected, errorsEncountered };
}

// =============================================================================
// Main Sync Orchestration
// =============================================================================

/**
 * Sync all markdown trace files back to their corresponding JSON files.
 *
 * AC-10.1: Edits in structured markdown sections update JSON
 * AC-10.2: Freeform "(not synced)" sections are ignored
 * AC-10.4: Structural parsing errors are reported, malformed entries skipped
 * AC-10.5: Conflicts between markdown and JSON are detected and reported (as-012)
 * AC-10.3: Sync completion summary is output (as-012)
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Project root override
 * @param {boolean} [options.force] - Force sync, markdown wins (skip conflict checks)
 * @param {boolean} [options.dryRun] - Preview changes without writing
 * @param {boolean} [options.autoMerge] - Auto-merge additions-only; flag deletions/modifications for manual
 * @returns {{ allChanges: string[], allErrors: string[], allConflicts: Array<{ module: string, field: string, jsonValue: object[], markdownValue: object[] }>, filesUpdated: number, summary: object, autoMergeLog: string[] }}
 */
export function syncAll(options = {}) {
  const projectRoot = options.projectRoot || resolveProjectRoot();
  const force = options.force || false;
  const dryRun = options.dryRun || false;
  const autoMerge = options.autoMerge || false;
  const allChanges = [];
  const allErrors = [];
  const allConflicts = [];
  const autoMergeLog = [];
  let filesUpdated = 0;

  // 1. Sync high-level.md -> high-level.json
  const highLevelMdPath = join(projectRoot, HIGH_LEVEL_MD_PATH);
  const highLevelJsonPath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);

  if (existsSync(highLevelMdPath) && existsSync(highLevelJsonPath)) {
    try {
      const mdContent = readFileSync(highLevelMdPath, 'utf-8');
      const jsonContent = JSON.parse(readFileSync(highLevelJsonPath, 'utf-8'));

      const parsed = parseHighLevelMarkdown(mdContent);
      allErrors.push(...parsed.errors);

      // AC-10.5: Detect conflicts only when JSON and markdown have diverged.
      // A conflict means JSON was regenerated (updating its lastGenerated)
      // while markdown still reflects an older generation. If only markdown
      // was edited (normal use case with matching lastGenerated), sync proceeds.
      const hasDiverged = jsonDivergedFromMarkdown(
        jsonContent.lastGenerated || null,
        parsed.metadata.lastGenerated,
      );

      if (hasDiverged && !force) {
        const conflicts = detectHighLevelConflicts(jsonContent, parsed);
        if (conflicts.length > 0) {
          if (autoMerge) {
            // REQ-024: Classify conflicts and auto-merge additions-only
            const { autoMergeable, manual } = classifyConflictsForAutoMerge(conflicts);

            // Auto-merge additions-only conflicts
            if (autoMergeable.length > 0) {
              const updatedJson = JSON.parse(JSON.stringify(jsonContent));
              for (const item of autoMergeable) {
                const jsonModule = updatedJson.modules.find(m => m.id === item.conflict.module);
                if (jsonModule) {
                  jsonModule[item.conflict.field] = applyAutoMerge(
                    jsonModule[item.conflict.field] || [],
                    item.additions,
                  );
                  allChanges.push(
                    `Auto-merged ${item.additions.length} addition(s) to ${item.conflict.field} in ${item.conflict.module}`,
                  );
                }
              }
              if (!dryRun) {
                writeFileSync(highLevelJsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
              }
              filesUpdated++;
            }

            // Report remaining manual conflicts
            if (manual.length > 0) {
              allConflicts.push(...manual.map(m => m.conflict));
            }

            // Build auto-merge log
            autoMergeLog.push(...formatAutoMergeLog(autoMergeable, manual));
          } else {
            // Report conflicts without auto-resolving
            allConflicts.push(...conflicts);
            // Do not apply changes -- user must resolve or use --force
          }
        } else {
          // JSON was modified but no field differences -- safe to proceed
          const { updatedJson, changes } = applyHighLevelSync(jsonContent, parsed);
          if (changes.length > 0) {
            if (!dryRun) {
              writeFileSync(highLevelJsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
            }
            allChanges.push(...changes);
            filesUpdated++;
          }
        }
      } else {
        // JSON not independently modified or --force: apply sync directly
        const { updatedJson, changes } = applyHighLevelSync(jsonContent, parsed);
        if (changes.length > 0) {
          if (!dryRun) {
            writeFileSync(highLevelJsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
          }
          allChanges.push(...changes);
          filesUpdated++;
        }
      }
    } catch (err) {
      allErrors.push(`Failed to sync high-level trace: ${err.message}`);
    }
  }

  // 2. Sync low-level/<module-id>.md -> low-level/<module-id>.json
  const lowLevelDir = join(projectRoot, LOW_LEVEL_MD_DIR);
  if (existsSync(lowLevelDir)) {
    let mdFiles;
    try {
      mdFiles = readdirSync(lowLevelDir).filter(f => f.endsWith('.md'));
    } catch {
      mdFiles = [];
    }

    for (const mdFile of mdFiles) {
      const moduleId = basename(mdFile, '.md');
      const mdPath = join(lowLevelDir, mdFile);
      const jsonPath = join(lowLevelDir, `${moduleId}.json`);

      if (!existsSync(jsonPath)) {
        allErrors.push(`No JSON file found for low-level module "${moduleId}" -- skipping`);
        continue;
      }

      try {
        const mdContent = readFileSync(mdPath, 'utf-8');
        const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8'));

        const parsed = parseLowLevelMarkdown(mdContent);
        allErrors.push(...parsed.errors);

        // AC-10.5: Detect conflicts only when JSON and markdown have diverged
        const hasDiverged = jsonDivergedFromMarkdown(
          jsonContent.lastGenerated || null,
          parsed.metadata.lastGenerated,
        );

        if (hasDiverged && !force) {
          const conflicts = detectLowLevelConflicts(jsonContent, parsed);
          if (conflicts.length > 0) {
            if (autoMerge) {
              // REQ-024: Classify conflicts and auto-merge additions-only
              const { autoMergeable, manual } = classifyConflictsForAutoMerge(conflicts);

              // Auto-merge additions-only conflicts
              if (autoMergeable.length > 0) {
                const updatedJson = JSON.parse(JSON.stringify(jsonContent));
                for (const item of autoMergeable) {
                  const jsonFile = updatedJson.files.find(f => f.filePath === item.conflict.module);
                  if (jsonFile) {
                    jsonFile[item.conflict.field] = applyAutoMerge(
                      jsonFile[item.conflict.field] || [],
                      item.additions,
                    );
                    allChanges.push(
                      `[${moduleId}] Auto-merged ${item.additions.length} addition(s) to ${item.conflict.field} in ${item.conflict.module}`,
                    );
                  }
                }
                if (!dryRun) {
                  writeFileSync(jsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
                }
                filesUpdated++;
              }

              // Report remaining manual conflicts
              if (manual.length > 0) {
                allConflicts.push(...manual.map(m => ({
                  ...m.conflict,
                  module: `[${moduleId}] ${m.conflict.module}`,
                })));
              }

              // Build auto-merge log
              const scopedAutoMergeable = autoMergeable.map(a => ({
                ...a,
                conflict: { ...a.conflict, module: `[${moduleId}] ${a.conflict.module}` },
              }));
              const scopedManual = manual.map(m => ({
                ...m,
                conflict: { ...m.conflict, module: `[${moduleId}] ${m.conflict.module}` },
              }));
              autoMergeLog.push(...formatAutoMergeLog(scopedAutoMergeable, scopedManual));
            } else {
              // Report conflicts without auto-resolving
              allConflicts.push(...conflicts.map(c => ({
                ...c,
                module: `[${moduleId}] ${c.module}`,
              })));
              // Do not apply changes for this module
            }
          } else {
            // JSON was modified but no field differences -- safe to proceed
            const { updatedJson, changes, sidecarCalls } = applyLowLevelSync(jsonContent, parsed);
            if (changes.length > 0) {
              if (!dryRun) {
                writeFileSync(jsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
                // AC-8.5: Write calls to sidecar file
                writeSidecarCallsFile(jsonPath, updatedJson, sidecarCalls);
              }
              allChanges.push(...changes.map(c => `[${moduleId}] ${c}`));
              filesUpdated++;
            }
          }
        } else {
          // JSON not independently modified or --force: apply sync directly
          const { updatedJson, changes, sidecarCalls } = applyLowLevelSync(jsonContent, parsed);
          if (changes.length > 0) {
            if (!dryRun) {
              writeFileSync(jsonPath, JSON.stringify(updatedJson, null, 2) + '\n');
              // AC-8.5: Write calls to sidecar file
              writeSidecarCallsFile(jsonPath, updatedJson, sidecarCalls);
            }
            allChanges.push(...changes.map(c => `[${moduleId}] ${c}`));
            filesUpdated++;
          }
        }
      } catch (err) {
        allErrors.push(`Failed to sync low-level module "${moduleId}": ${err.message}`);
      }
    }
  }

  // AC-10.3: Build sync completion summary
  const summary = buildSyncSummary({
    changes: allChanges,
    errors: allErrors,
    conflicts: allConflicts,
    filesUpdated,
    dryRun,
  });

  return { allChanges, allErrors, allConflicts, filesUpdated, summary, autoMergeLog };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Parse CLI arguments for --force, --dry-run, and --auto-merge flags.
 *
 * @param {string[]} argv - Process arguments (process.argv)
 * @returns {{ force: boolean, dryRun: boolean, autoMerge: boolean }}
 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  return {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    autoMerge: args.includes('--auto-merge'),
  };
}

async function main() {
  try {
    const { force, dryRun, autoMerge } = parseCliArgs(process.argv);
    const result = syncAll({ force, dryRun, autoMerge });

    // Report errors to stderr (AC-10.4)
    for (const error of result.allErrors) {
      process.stderr.write(`ERROR: ${error}\n`);
    }

    // REQ-024: Display auto-merge log
    if (result.autoMergeLog.length > 0) {
      console.log('');
      for (const line of result.autoMergeLog) {
        console.log(line);
      }
    }

    // AC-10.5: Report conflicts to stderr
    if (result.allConflicts.length > 0) {
      process.stderr.write('\n');
      const conflictLines = formatConflictReport(result.allConflicts);
      for (const line of conflictLines) {
        process.stderr.write(`${line}\n`);
      }
      process.stderr.write(`\nUse --force to override conflicts (markdown wins).\n`);
      if (!autoMerge) {
        process.stderr.write(`Use --auto-merge to auto-merge additions and flag deletions/modifications.\n`);
      }
    }

    // AC-10.3: Output sync completion summary to stdout
    console.log(result.summary.text);

    // Report individual changes
    if (result.allChanges.length > 0) {
      console.log('');
      console.log('Changes:');
      for (const change of result.allChanges) {
        console.log(`  - ${change}`);
      }
    }

    // Exit with error code if there are errors or unresolved conflicts
    const hasIssues = result.allErrors.length > 0 || result.allConflicts.length > 0;
    process.exit(hasIssues ? 1 : 0);
  } catch (err) {
    process.stderr.write(`Trace sync failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Run main only if executed directly (not imported as a module by tests)
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-sync.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
