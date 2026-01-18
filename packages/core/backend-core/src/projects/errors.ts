/**
 * Project Errors (AS-001)
 *
 * Re-exports error types from github module for project operations.
 */

// Re-export ProjectNotFoundError from github errors to avoid duplication
export { ProjectNotFoundError } from '../github/errors.js';
