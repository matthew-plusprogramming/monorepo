/**
 * Google Docs API Service
 *
 * Provides an Effect-based interface for fetching Google Doc content.
 * Supports both API key and service account authentication.
 */

import { Context, Effect } from 'effect';

import { GoogleDocsApiError } from '@/prds/errors.js';
import type { GoogleDocContent } from '@/prds/types.js';

/**
 * Schema for the GoogleDocsService.
 */
export type GoogleDocsServiceSchema = {
  /**
   * Fetches the content of a Google Doc by its ID.
   * Returns the document title and plain text content.
   */
  readonly getDocContent: (
    docId: string,
  ) => Effect.Effect<GoogleDocContent, GoogleDocsApiError>;
};

export class GoogleDocsService extends Context.Tag('GoogleDocsService')<
  GoogleDocsService,
  GoogleDocsServiceSchema
>() {}

/**
 * Configuration for the Google Docs API client.
 */
export type GoogleDocsConfig = {
  readonly apiKey?: string;
  readonly serviceAccountKeyPath?: string;
};

/**
 * Creates the live implementation of the GoogleDocsService.
 *
 * Uses the Google Docs API to fetch document content.
 * Requires either GOOGLE_DOCS_API_KEY environment variable
 * or GOOGLE_SERVICE_ACCOUNT_KEY_PATH for service account auth.
 */
export const createGoogleDocsService = (
  config?: GoogleDocsConfig,
): GoogleDocsServiceSchema => {
  const apiKey = config?.apiKey ?? process.env.GOOGLE_DOCS_API_KEY;
  const serviceAccountKeyPath =
    config?.serviceAccountKeyPath ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;

  if (!apiKey && !serviceAccountKeyPath) {
    console.warn(
      'GoogleDocsService: No API key or service account configured. ' +
        'Set GOOGLE_DOCS_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH.',
    );
  }

  return {
    getDocContent: (docId: string) =>
      Effect.tryPromise({
        try: async () => {
          // Build the API URL
          const baseUrl = `https://docs.googleapis.com/v1/documents/${docId}`;
          const url = apiKey ? `${baseUrl}?key=${apiKey}` : baseUrl;

          const headers: Record<string, string> = {
            Accept: 'application/json',
          };

          // If using service account, we'd need to add OAuth token
          // For now, we support API key authentication
          if (!apiKey && serviceAccountKeyPath) {
            // TODO: Implement service account OAuth token generation
            // This would involve reading the service account JSON and generating a JWT
            throw new Error('Service account authentication not yet implemented');
          }

          const response = await fetch(url, {
            method: 'GET',
            headers,
          });

          if (!response.ok) {
            const errorBody = await response.text();
            throw {
              statusCode: response.status,
              message: `Google Docs API error: ${response.status} ${response.statusText}`,
              body: errorBody,
            };
          }

          const doc = (await response.json()) as GoogleDocsApiResponse;

          // Extract plain text content from the document structure
          const content = extractTextContent(doc);

          return {
            title: doc.title ?? 'Untitled Document',
            content,
          };
        },
        catch: (error) => {
          const errorObj = error as { statusCode?: number; message?: string };
          const statusCode = errorObj.statusCode;
          const retryable = statusCode ? statusCode >= 500 : false;

          return new GoogleDocsApiError({
            message: errorObj.message ?? 'Failed to fetch Google Doc content',
            cause: error,
            statusCode,
            retryable,
          });
        },
      }),
  };
};

/**
 * Google Docs API response structure (simplified).
 */
type GoogleDocsApiResponse = {
  readonly title?: string;
  readonly body?: {
    readonly content?: ReadonlyArray<{
      readonly paragraph?: {
        readonly elements?: ReadonlyArray<{
          readonly textRun?: {
            readonly content?: string;
          };
        }>;
      };
    }>;
  };
};

/**
 * Extracts plain text content from a Google Docs API response.
 */
const extractTextContent = (doc: GoogleDocsApiResponse): string => {
  const content = doc.body?.content ?? [];
  const textParts: string[] = [];

  for (const block of content) {
    if (block.paragraph?.elements) {
      for (const element of block.paragraph.elements) {
        if (element.textRun?.content) {
          textParts.push(element.textRun.content);
        }
      }
    }
  }

  return textParts.join('');
};
