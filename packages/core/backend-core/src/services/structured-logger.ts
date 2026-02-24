/**
 * Structured Logger Core (AS-001)
 *
 * Provides a lightweight structured JSON logger for machine-parseable output.
 * Outputs single-line JSON to stdout via process.stdout.write.
 *
 * AC1.1: createStructuredLogger returns object with info, warn, error, debug methods
 * AC1.2: Each method writes single-line JSON to process.stdout.write (not console.log)
 * AC1.3: Each log entry contains timestamp (ISO 8601), service, component, env, version, level, message
 * AC1.4: Additional context spread into log entry after PII redaction
 * AC1.5: Sensitive fields recursively replaced with '[REDACTED]'
 * AC1.6: Circular references handled via WeakSet detector
 * AC1.7: parseLogLevel follows LOG_LEVEL > DEBUG=true > INFO chain
 * AC2.1: Log entries below configured level silently suppressed
 * AC2.2: Entries exceeding 8192 chars truncated with [TRUNCATED]
 * AC2.3: Caller context cannot override base fields (timestamp, level, service, component)
 * AC2.8: Conditional import of correlation-context -- no error if AS-002 not available
 */

import { SENSITIVE_KEYS } from '@/constants/sensitive-keys.js';

// --- Conditional correlation context import (AC2.8) ---
// The correlation-context module (AS-002) may not exist yet.
// We use a lazy loader that attempts import on first use and caches the result.
// The module path is constructed via a variable to prevent TypeScript from
// statically resolving it (which would cause a compile error if missing).

type CorrelationGetter = () =>
  | {
      requestId?: string;
      correlationId?: string;
      jobId?: string;
      workflowId?: string;
    }
  | undefined;

let correlationLoader: { tried: boolean; fn: CorrelationGetter | undefined } = {
  tried: false,
  fn: undefined,
};

function tryGetCorrelation():
  | {
      requestId?: string;
      correlationId?: string;
      jobId?: string;
      workflowId?: string;
    }
  | undefined {
  if (!correlationLoader.tried) {
    correlationLoader.tried = true;
    try {
      // Use require with a variable path to avoid TypeScript static analysis
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const modulePath = '@/services/correlation-context.js';
      const mod = require(modulePath) as { getCorrelation?: CorrelationGetter };
      correlationLoader.fn = mod.getCorrelation;
    } catch {
      // AC2.8: correlation-context not available, logger operates without enrichment
      correlationLoader.fn = undefined;
    }
  }
  return correlationLoader.fn?.();
}

// --- Types ---

/** Log severity levels in ascending order */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Additional structured context fields */
export type LogContext = Record<string, unknown>;

/** Configuration for creating a structured logger instance */
export type StructuredLoggerConfig = {
  service: string;
  component: string;
  env?: string;
  version?: string;
};

/** Shape of a structured log entry written to stdout */
export type StructuredLogEntry = {
  timestamp: string;
  service: string;
  component: string;
  env: string;
  version: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

/** Structured logger interface with methods for each severity level */
export type StructuredLogger = {
  readonly info: (message: string, context?: LogContext) => void;
  readonly warn: (message: string, context?: LogContext) => void;
  readonly error: (message: string, context?: LogContext) => void;
  readonly debug: (message: string, context?: LogContext) => void;
};

// --- PII / Sensitive Data Redaction ---

/** Maximum serialized log entry size in characters (AC2.2) */
const MAX_LOG_ENTRY_SIZE = 8192;

/**
 * Redacts sensitive values from a context object recursively.
 * Returns a new object with sensitive fields replaced with '[REDACTED]'.
 * Uses a WeakSet to detect circular references and avoid infinite recursion (AC1.6).
 */
export function redactSensitiveFields(
  obj: Record<string, unknown>,
  seen: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
  if (seen.has(obj)) {
    return { _circular: true };
  }
  seen.add(obj);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_KEYS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSensitiveFields(
        value as Record<string, unknown>,
        seen,
      );
    } else if (Array.isArray(value)) {
      result[key] = value.map((item): unknown =>
        typeof item === 'object' && item !== null
          ? redactSensitiveFields(item as Record<string, unknown>, seen)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// --- Level Filtering ---

/** Numeric hierarchy for log levels: lower number = more verbose */
const LEVEL_HIERARCHY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/**
 * Parses the configured log level from environment variables (AC1.7).
 *
 * Precedence chain:
 * 1. LOG_LEVEL env var (explicit, case-insensitive)
 * 2. DEBUG=true env var (fallback to DEBUG level)
 * 3. Default: INFO
 *
 * If LOG_LEVEL contains an invalid value, defaults to INFO and emits a
 * warning to stderr.
 */
export function parseLogLevel(raw?: string): LogLevel {
  const logLevelRaw = raw ?? process.env.LOG_LEVEL;

  if (logLevelRaw !== undefined && logLevelRaw !== '') {
    const normalized = logLevelRaw.toUpperCase();
    if (normalized in LEVEL_HIERARCHY) {
      return normalized as LogLevel;
    }
    process.stderr.write(
      `[structured-logger] Invalid LOG_LEVEL="${logLevelRaw}", defaulting to INFO\n`,
    );
    return 'INFO';
  }

  if (process.env.DEBUG?.toLowerCase() === 'true') {
    return 'DEBUG';
  }

  return 'INFO';
}

// --- Factory ---

/**
 * Creates a structured logger that outputs single-line JSON to stdout (AC1.1).
 *
 * @param config - Logger configuration (service name, component, optional env/version)
 */
export function createStructuredLogger(
  config: StructuredLoggerConfig,
): StructuredLogger {
  const configuredLevel = parseLogLevel();

  const env =
    config.env ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? 'unknown';

  const version = config.version ?? process.env.APP_VERSION ?? 'unknown';

  const shouldEmit = (level: LogLevel): boolean => {
    return LEVEL_HIERARCHY[level] >= LEVEL_HIERARCHY[configuredLevel];
  };

  const emit = (
    level: LogLevel,
    message: string,
    context?: LogContext,
  ): void => {
    if (!shouldEmit(level)) {
      return; // AC2.1: Silently suppress
    }

    // AC1.3: Base fields
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      service: config.service,
      component: config.component,
      env,
      version,
      level,
      message: String(message),
    };

    // AC1.4, AC2.3: Spread context, but base fields take precedence
    if (context) {
      const safeContext = redactSensitiveFields(
        context as Record<string, unknown>,
      );
      for (const [key, value] of Object.entries(safeContext)) {
        if (!(key in entry)) {
          entry[key] = value;
        }
      }
    }

    // Auto-enrich with correlation IDs if available (AC2.8)
    const correlation = tryGetCorrelation();
    if (correlation) {
      if (correlation.requestId) entry.request_id = correlation.requestId;
      if (correlation.correlationId)
        entry.correlation_id = correlation.correlationId;
      if (correlation.jobId) entry.job_id = correlation.jobId;
      if (correlation.workflowId) entry.workflow_id = correlation.workflowId;
    }

    // AC1.6: Serialize with circular reference protection
    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      const fallbackEntry: StructuredLogEntry = {
        timestamp: entry.timestamp,
        service: entry.service,
        component: entry.component,
        env: entry.env,
        version: entry.version,
        level: entry.level,
        message: entry.message,
        _serialization_error: true,
      };
      serialized = JSON.stringify(fallbackEntry);
    }

    // AC2.2: Size truncation
    if (serialized.length > MAX_LOG_ENTRY_SIZE) {
      const truncatedEntry: StructuredLogEntry = {
        timestamp: entry.timestamp,
        service: entry.service,
        component: entry.component,
        env: entry.env,
        version: entry.version,
        level: entry.level,
        message: `${entry.message} [TRUNCATED]`,
      };
      serialized = JSON.stringify(truncatedEntry);
    }

    // AC1.2: Single-line JSON to stdout
    process.stdout.write(serialized + '\n');
  };

  return {
    info: (message: string, context?: LogContext): void =>
      emit('INFO', message, context),
    warn: (message: string, context?: LogContext): void =>
      emit('WARN', message, context),
    error: (message: string, context?: LogContext): void =>
      emit('ERROR', message, context),
    debug: (message: string, context?: LogContext): void =>
      emit('DEBUG', message, context),
  };
}
