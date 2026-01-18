/**
 * Agent Task Types
 *
 * Defines types for agent webhook dispatch and task logging.
 * Supports TTL for automatic cleanup after 30 days.
 * Extended for real-time status updates via WebSocket (AS-007).
 */

import { z } from 'zod';

/**
 * Action types that can be dispatched to the agent.
 */
export const AgentAction = {
  IMPLEMENT: 'implement',
  TEST: 'test',
} as const;

export type AgentActionType = (typeof AgentAction)[keyof typeof AgentAction];

/**
 * Status of an agent task.
 */
export const AgentTaskStatus = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  ACKNOWLEDGED: 'acknowledged',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
} as const;

export type AgentTaskStatusType =
  (typeof AgentTaskStatus)[keyof typeof AgentTaskStatus];

/**
 * Task phase enum representing the real-time lifecycle of an agent task (AS-007).
 * AC7.3: Progress indicator shows task phase (starting, running, completing)
 */
export const TaskPhase = {
  STARTING: 'starting',
  RUNNING: 'running',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type TaskPhaseType = (typeof TaskPhase)[keyof typeof TaskPhase];

export const TaskPhaseSchema = z.enum([
  'starting',
  'running',
  'completing',
  'completed',
  'failed',
]);

/**
 * Log level for task log entries.
 */
export const LogLevel = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Agent task log entry schema (AC7.4).
 */
export const AgentTaskLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['info', 'warn', 'error', 'debug']),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentTaskLogEntry = z.infer<typeof AgentTaskLogEntrySchema>;

/**
 * Real-time status update schema for WebSocket broadcasts.
 */
export const AgentTaskRealtimeStatusSchema = z.object({
  taskId: z.string(),
  phase: TaskPhaseSchema,
  progress: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export type AgentTaskRealtimeStatus = z.infer<typeof AgentTaskRealtimeStatusSchema>;

/**
 * Status update input schema for POST /api/agent-tasks/:id/status
 */
export const AgentTaskStatusUpdateInputSchema = z.object({
  phase: TaskPhaseSchema,
  progress: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  logEntry: AgentTaskLogEntrySchema.optional(),
});

export type AgentTaskStatusUpdateInput = z.infer<typeof AgentTaskStatusUpdateInputSchema>;

/**
 * WebSocket message types for real-time updates (AC7.2).
 */
export const WebSocketMessageType = {
  TASK_STATUS_UPDATE: 'task_status_update',
  TASK_LOGS_UPDATE: 'task_logs_update',
  CONNECTION_STATUS: 'connection_status',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PING: 'ping',
  PONG: 'pong',
} as const;

export type WebSocketMessageTypeValue =
  (typeof WebSocketMessageType)[keyof typeof WebSocketMessageType];

/**
 * WebSocket message schema.
 */
export const WebSocketMessageSchema = z.object({
  type: z.enum([
    'task_status_update',
    'task_logs_update',
    'connection_status',
    'subscribe',
    'unsubscribe',
    'ping',
    'pong',
  ]),
  payload: z.unknown(),
  timestamp: z.string().datetime(),
});

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

/**
 * Task status update WebSocket payload.
 */
export const TaskStatusUpdatePayloadSchema = z.object({
  taskId: z.string(),
  status: AgentTaskRealtimeStatusSchema,
});

export type TaskStatusUpdatePayload = z.infer<typeof TaskStatusUpdatePayloadSchema>;

/**
 * Subscription request payload.
 */
export const SubscriptionPayloadSchema = z.object({
  taskId: z.string(),
});

export type SubscriptionPayload = z.infer<typeof SubscriptionPayloadSchema>;

/**
 * Connection status payload (AC7.5, AC7.6).
 */
export const ConnectionStatusPayloadSchema = z.object({
  connected: z.boolean(),
  reconnecting: z.boolean().optional(),
  reconnectAttempt: z.number().optional(),
});

export type ConnectionStatusPayload = z.infer<typeof ConnectionStatusPayloadSchema>;

/**
 * Context sent with webhook payload.
 */
export type AgentDispatchContext = {
  readonly specGroupId: string;
  readonly specGroupName?: string;
  readonly triggeredBy: string;
  readonly triggeredAt: string;
};

/**
 * Webhook payload sent to the agent endpoint.
 */
export type AgentWebhookPayload = {
  readonly specGroupId: string;
  readonly action: AgentActionType;
  readonly context: AgentDispatchContext;
};

/**
 * Represents an agent task record in DynamoDB.
 * TTL is set to 30 days from creation for automatic cleanup.
 */
export type AgentTask = {
  readonly id: string;
  readonly specGroupId: string;
  readonly action: AgentActionType;
  readonly status: AgentTaskStatusType;
  readonly context: AgentDispatchContext;
  readonly webhookUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt?: string;
  readonly acknowledgedAt?: string;
  readonly failedAt?: string;
  readonly errorMessage?: string;
  readonly responseStatus?: number;
  /**
   * TTL attribute for DynamoDB automatic expiration.
   * Set to 30 days (2592000 seconds) from creation.
   */
  readonly ttl: number;
};

/**
 * Input for creating a new agent task.
 */
export type CreateAgentTaskInput = {
  readonly id: string;
  readonly specGroupId: string;
  readonly action: AgentActionType;
  readonly context: AgentDispatchContext;
  readonly webhookUrl: string;
};

/**
 * Input for updating agent task status.
 */
export type UpdateAgentTaskStatusInput = {
  readonly taskId: string;
  readonly status: AgentTaskStatusType;
  readonly errorMessage?: string;
  readonly responseStatus?: number;
};

/**
 * Result of a webhook dispatch operation.
 */
export type WebhookDispatchResult = {
  readonly success: boolean;
  readonly taskId: string;
  readonly responseStatus?: number;
  readonly errorMessage?: string;
};

/**
 * TTL duration in seconds (30 days).
 */
export const AGENT_TASK_TTL_SECONDS = 30 * 24 * 60 * 60; // 2592000 seconds
