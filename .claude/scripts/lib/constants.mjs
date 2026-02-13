/**
 * Centralized constants for metaclaude scripts.
 *
 * All magic numbers and shared configuration live here.
 * Constants use descriptive names with units where applicable.
 */

// --- Output Formatting ---
export const OUTPUT_MAX_LINES = 50;
export const OUTPUT_HEAD_LINES = 10;
export const OUTPUT_TAIL_LINES = 40;
export const ERROR_MESSAGE_MAX_CHARS = 100;

// --- Registry & Hashing ---
export const HASH_LENGTH_CHARS = 8;
export const REGISTRY_FILENAME = 'metaclaude-registry.json';

// --- Validation ---
export const FRONTMATTER_DELIMITER = '---';
export const MIN_EVIDENCE_TABLE_ROWS = 1;
export const JOURNAL_PROMOTION_THRESHOLD = 3;

// --- Hook Input Schema ---
export const HOOK_INPUT_REQUIRED_FIELDS = ['tool_input'];

/**
 * Validate hook input JSON structure.
 * Returns { valid: boolean, data: object|null, error: string|null }
 */
export function validateHookInput(inputData) {
  if (typeof inputData !== 'object' || inputData === null) {
    return { valid: false, data: null, error: 'Input is not an object' };
  }
  // tool_input is expected but not strictly required — some hooks work without it
  return { valid: true, data: inputData, error: null };
}
