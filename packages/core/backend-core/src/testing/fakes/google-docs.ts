/**
 * Google Docs Service Fake
 *
 * A testable fake implementation of the GoogleDocsService
 * that allows queueing responses and tracking calls.
 */

import { Effect, Layer } from 'effect';

import { GoogleDocsApiError } from '@/prds/errors.js';
import type { GoogleDocContent } from '@/prds/types.js';
import {
  GoogleDocsService,
  type GoogleDocsServiceSchema,
} from '@/services/google-docs.js';

// Re-export GoogleDocsService for tests that need to reference it
export { GoogleDocsService };

type ResponseEntry =
  | { type: 'success'; value: GoogleDocContent }
  | { type: 'error'; error: GoogleDocsApiError };

export type GoogleDocsServiceFake = {
  readonly service: GoogleDocsServiceSchema;
  readonly layer: Layer.Layer<GoogleDocsService, never, never>;
  readonly queueSuccess: (docId: string, content: GoogleDocContent) => void;
  readonly queueFailure: (docId: string, error: GoogleDocsApiError) => void;
  readonly calls: ReadonlyArray<string>;
  readonly reset: () => void;
};

export const createGoogleDocsServiceFake = (): GoogleDocsServiceFake => {
  const responseQueues: Map<string, ResponseEntry[]> = new Map();
  const callHistory: string[] = [];

  const getQueue = (docId: string): ResponseEntry[] => {
    let queue = responseQueues.get(docId);
    if (!queue) {
      queue = [];
      responseQueues.set(docId, queue);
    }
    return queue;
  };

  const service: GoogleDocsServiceSchema = {
    getDocContent: (docId: string) =>
      Effect.sync(() => {
        callHistory.push(docId);
      }).pipe(
        Effect.flatMap(() => {
          const queue = getQueue(docId);
          const next = queue.shift();

          if (!next) {
            return Effect.fail(
              new GoogleDocsApiError({
                message: `No response queued for doc ID: ${docId}`,
                cause: undefined,
                retryable: false,
              }),
            );
          }

          if (next.type === 'success') {
            return Effect.succeed(next.value);
          }

          return Effect.fail(next.error);
        }),
      ),
  };

  return {
    service,
    layer: Layer.succeed(GoogleDocsService, service),
    queueSuccess: (docId: string, content: GoogleDocContent): void => {
      getQueue(docId).push({ type: 'success', value: content });
    },
    queueFailure: (docId: string, error: GoogleDocsApiError): void => {
      getQueue(docId).push({ type: 'error', error });
    },
    get calls(): ReadonlyArray<string> {
      return [...callHistory];
    },
    reset: (): void => {
      responseQueues.clear();
      callHistory.length = 0;
    },
  };
};
