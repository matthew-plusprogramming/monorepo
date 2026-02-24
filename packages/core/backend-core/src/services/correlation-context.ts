/**
 * Correlation Context via AsyncLocalStorage (AS-002)
 *
 * Provides AsyncLocalStorage-based correlation context for threading
 * request/correlation IDs through async operations. The structured logger
 * imports from this module to auto-enrich log entries.
 *
 * AC1.1: CorrelationStore interface with requestId?, correlationId?, jobId?, workflowId?
 * AC1.2: Module-scoped singleton AsyncLocalStorage instance (not exported directly)
 * AC1.3: runWithCorrelation sets ALS context for fn and all async descendants
 * AC1.4: getCorrelation returns CorrelationStore within ALS context
 * AC1.5: getCorrelation returns undefined outside ALS context (no error thrown)
 * AC1.6: getCorrelationHeaders returns Record<string, string> with x-request-id, x-correlation-id
 * AC1.7: getCorrelationHeaders returns {} outside ALS context
 * AC2.5: Correlation IDs validated with regex ^[a-zA-Z0-9._-]{1,128}$
 * AC2.6: Only imports from node:async_hooks (zero external dependencies)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// --- Types ---

/**
 * Shape of the correlation data stored in AsyncLocalStorage (AC1.1).
 * All fields are optional -- a context may have only a requestId (HTTP)
 * or only a correlationId, or both, or neither.
 */
export interface CorrelationStore {
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  workflowId?: string;
}

// --- Singleton ALS instance (AC1.2) ---

/** Module-scoped singleton -- not exported directly */
const als = new AsyncLocalStorage<CorrelationStore>();

// --- Correlation ID validation (AC2.5) ---

const CORRELATION_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Validates a correlation ID against the allowed format (AC2.5).
 * Use at ingest boundaries to reject malformed IDs.
 *
 * @param id - Correlation ID to validate
 * @returns true if the ID matches ^[a-zA-Z0-9._-]{1,128}$
 */
export function validateCorrelationId(id: string): boolean {
  return CORRELATION_ID_REGEX.test(id);
}

/**
 * Run a function within an AsyncLocalStorage context containing
 * the given correlation data (AC1.3). All async descendants of fn will
 * have access to the store via getCorrelation().
 */
export function runWithCorrelation<T>(store: CorrelationStore, fn: () => T): T {
  return als.run(store, fn);
}

/**
 * Retrieve the current correlation store from AsyncLocalStorage (AC1.4).
 * Returns undefined if called outside any ALS context (AC1.5).
 * No error is thrown -- graceful degradation.
 */
export function getCorrelation(): CorrelationStore | undefined {
  return als.getStore();
}

/**
 * Build HTTP headers from the current ALS context for cross-service
 * propagation (AC1.6). Returns an empty object if no ALS context exists (AC1.7).
 *
 * Only requestId and correlationId are propagated as headers -- never
 * jobId or workflowId (security: no sensitive data in headers).
 */
export function getCorrelationHeaders(): Record<string, string> {
  const store = als.getStore();
  if (!store) {
    return {};
  }

  const headers: Record<string, string> = {};
  if (store.requestId) {
    headers['x-request-id'] = store.requestId;
  }
  if (store.correlationId) {
    headers['x-correlation-id'] = store.correlationId;
  }
  return headers;
}
