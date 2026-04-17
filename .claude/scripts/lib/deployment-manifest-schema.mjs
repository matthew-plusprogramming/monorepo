/**
 * Deployment Manifest Zod Schema
 *
 * Validates the deployment manifest shape per the Data Model Contract:
 * Deployment Manifest Schema (sg-deployment-verification-gaps, REQ-013).
 *
 * Schema validates at parser boundary per code-quality.md.
 * Exports both the Zod validator and parsed type inference.
 *
 * Key constraints:
 * - schema_version: z.literal("1.0") -- exact match, not forward-compatible (DEC-INV-008)
 * - base_url: z.string() (NOT z.string().url()) -- permits protocol-less forms (DEC-INV-005)
 * - service: alphanumeric plus . - _, max 128 chars
 * - routes: non-empty array with method enum, path, optional fields
 * - deployment_env_allowlist: optional string array, defaults to []
 *
 * Implements: AC-13.5
 * Spec: sg-deployment-verification-gaps
 */

import { z } from 'zod';

// =============================================================================
// Constants -- Method-Default Expected Status Allowlists (AC-13.2)
// =============================================================================

/** Default pass status codes per HTTP method. */
export const METHOD_DEFAULT_STATUS = {
  GET: [200, 401, 403],
  POST: [200, 201, 400, 401, 403, 422],
  PUT: [200, 201, 400, 401, 403, 422],
  DELETE: [200, 204, 401, 403, 404],
  PATCH: [200, 204, 400, 401, 403, 422],
};

/** Default per-route timeout in milliseconds. */
export const DEFAULT_PER_ROUTE_TIMEOUT_MS = 5000;

/** Overall batch timeout for all probes (NF5). */
export const BATCH_TIMEOUT_MS = 30_000;

// =============================================================================
// Route Schema
// =============================================================================

const RouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  path: z.string().min(1),
  expected_status: z.array(z.number().int().min(100).max(599)).optional(),
  body_skeleton: z.record(z.unknown()).optional(),
  timeout_ms: z.number().int().positive().optional().default(DEFAULT_PER_ROUTE_TIMEOUT_MS),
  headers: z.record(z.string()).optional(),
}).strict();

// =============================================================================
// Deployment Manifest Schema
// =============================================================================

/** Service name: alphanumeric plus . - _, max 128 chars. */
const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const DeploymentManifestSchema = z.object({
  // AC-13.5: Exact literal "1.0" (DEC-INV-008)
  schema_version: z.literal('1.0'),
  service: z.string()
    .min(1)
    .max(128)
    .regex(SERVICE_NAME_PATTERN, 'Service name must be alphanumeric plus . - _ only'),
  // AC-13.5: z.string() NOT z.string().url() -- permits protocol-less forms (DEC-INV-005)
  base_url: z.string().min(1),
  // F-3 fix: Cap routes array at 50 to bound probe batch size. body_skeleton depth
  // is uncapped (acceptable for v1 -- JSON.stringify handles arbitrary nesting).
  routes: z.array(RouteSchema).min(1).max(50),
  // REQ-014: Env-var keys for expected_env_hash computation
  deployment_env_allowlist: z.array(z.string()).optional().default([]),
}).strict();

// =============================================================================
// Exports
// =============================================================================

/**
 * Parse and validate a deployment manifest.
 *
 * @param {unknown} data - Raw manifest data to validate
 * @returns {{ success: true, data: object } | { success: false, error: import('zod').ZodError }}
 */
export function parseManifest(data) {
  const result = DeploymentManifestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
