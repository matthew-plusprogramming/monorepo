/**
 * Template file loader for runtime connectivity archetypes.
 *
 * Reads the archetype template from
 * `.claude/templates/runtime-connectivity/<archetype>.template.mjs` by file
 * path (D-036: templates are NOT inlined in the agent prompt). Pure I/O —
 * no substitution, no validation beyond path existence.
 *
 * @module e2e-test-writer/template-loader
 * @contract runtime-connectivity-template-loading
 * @req REQ-F-001a
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARCHETYPES } from './archetype-selection.mjs';

/** Default directory relative to project root. */
export const DEFAULT_TEMPLATE_DIR = '.claude/templates/runtime-connectivity';

/** Error thrown when the archetype template file does not exist. */
export class TemplateNotFoundError extends Error {
  /**
   * @param {string} archetype
   * @param {string} path
   */
  constructor(archetype, path) {
    super(`Archetype template missing: ${archetype} expected at ${path}`);
    this.name = 'TemplateNotFoundError';
    /** @type {string} */
    this.archetype = archetype;
    /** @type {string} */
    this.path = path;
    /** @type {string} */
    this.code = 'E_TEMPLATE_NOT_FOUND';
  }
}

/**
 * Resolve the absolute template path for a given archetype.
 *
 * @param {string} archetype
 * @param {Object} [opts]
 * @param {string} [opts.projectRoot] - Absolute project root. Defaults to CWD.
 * @param {string} [opts.templateDir] - Override template directory (relative or absolute).
 * @returns {string} Absolute path.
 */
export function templatePathFor(archetype, opts = {}) {
  if (!ARCHETYPES.includes(archetype)) {
    throw new Error(
      `Unknown archetype: ${archetype}. Expected one of ${ARCHETYPES.join(', ')}.`,
    );
  }
  const projectRoot = opts.projectRoot || process.cwd();
  const templateDir = opts.templateDir || DEFAULT_TEMPLATE_DIR;
  const baseDir = resolve(projectRoot, templateDir);
  return join(baseDir, `${archetype}.template.mjs`);
}

/**
 * Load the raw template string for a given archetype.
 *
 * @param {string} archetype
 * @param {Object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {string} [opts.templateDir]
 * @returns {string} Raw template contents (UTF-8).
 * @throws {TemplateNotFoundError} when the file does not exist.
 */
export function loadTemplate(archetype, opts = {}) {
  const path = templatePathFor(archetype, opts);
  if (!existsSync(path)) {
    throw new TemplateNotFoundError(archetype, path);
  }
  return readFileSync(path, 'utf-8');
}
