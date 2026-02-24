/**
 * Shared sensitive field names for PII redaction.
 *
 * AC1.5: Both the structured logger and logging middleware import from this
 * shared constant. Fields matching these keys are recursively replaced with
 * '[REDACTED]' before log serialization.
 *
 * This is the single source of truth for sensitive field detection across
 * the codebase.
 */
export const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'address',
  'dob',
  'ssn',
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'cookie',
  'session',
  'credit_card',
  'creditcard',
  'credit-card',
  'apikey',
  'api_key',
  'api-key',
  'accesstoken',
  'access_token',
  'access-token',
  'refreshtoken',
  'refresh_token',
  'refresh-token',
  'bearer',
]);
