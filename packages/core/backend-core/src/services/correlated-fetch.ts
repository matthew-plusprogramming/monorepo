/**
 * Correlated Fetch Wrapper (AS-002)
 *
 * Wraps native `fetch` to automatically add correlation headers from the
 * current AsyncLocalStorage context. This is an explicit named export,
 * not a monkey-patch of global `fetch`.
 *
 * AC2.1: Adds x-request-id and x-correlation-id headers from ALS context
 * AC2.2: Caller-provided headers override correlation headers on key conflict
 * AC2.3: Handles Headers objects, string[][], and Record<string, string> formats
 * AC2.4: Outside ALS context, behaves identically to native fetch
 */

import { getCorrelationHeaders } from '@/services/correlation-context.js';

/**
 * Normalizes various HeadersInit formats into a plain Record.
 */
function normalizeHeaders(
  headers?: NonNullable<RequestInit['headers']>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Fetch wrapper that auto-injects correlation headers (AC2.1).
 *
 * - Injects x-request-id and x-correlation-id from ALS context
 * - Caller-provided headers override correlation headers on conflict (AC2.2)
 * - Handles Headers, string[][], and Record<string, string> formats (AC2.3)
 * - Outside ALS context, behaves identically to native fetch (AC2.4)
 */
export async function correlatedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const correlationHeaders = getCorrelationHeaders();
  const callerHeaders = normalizeHeaders(init?.headers);

  // Correlation headers first, caller headers override on conflict (AC2.2)
  const mergedHeaders: Record<string, string> = {
    ...correlationHeaders,
    ...callerHeaders,
  };

  const hasHeaders = Object.keys(mergedHeaders).length > 0;

  return fetch(input, {
    ...init,
    ...(hasHeaders ? { headers: mergedHeaders } : {}),
  });
}
