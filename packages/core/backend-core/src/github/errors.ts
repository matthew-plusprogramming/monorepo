/**
 * GitHub Errors
 *
 * Error types for GitHub integration features.
 */

import { Data } from 'effect';

import type { GenericErrorPayload } from '@/types/errors/index.js';

/**
 * Error when a project is not found.
 */
export class ProjectNotFoundError extends Data.TaggedError(
  'ProjectNotFoundError',
)<GenericErrorPayload> {}

/**
 * Error when a project does not have a linked GitHub repository.
 */
export class NoLinkedRepoError extends Data.TaggedError(
  'NoLinkedRepoError',
)<GenericErrorPayload> {}

/**
 * Error when GitHub API request fails.
 */
export class GitHubApiError extends Data.TaggedError(
  'GitHubApiError',
)<GenericErrorPayload & { statusCode?: number }> {}

/**
 * Error when GitHub API token is missing or invalid.
 */
export class GitHubAuthError extends Data.TaggedError(
  'GitHubAuthError',
)<GenericErrorPayload> {}
