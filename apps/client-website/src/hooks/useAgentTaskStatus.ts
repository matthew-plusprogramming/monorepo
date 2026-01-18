'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Task phase representing the lifecycle of an agent task (AS-007).
 */
type TaskPhase = 'starting' | 'running' | 'completing' | 'completed' | 'failed';

/**
 * Agent task real-time status.
 */
type AgentTaskRealtimeStatus = {
  readonly taskId: string;
  readonly phase: TaskPhase;
  readonly progress?: number;
  readonly message?: string;
  readonly updatedAt: string;
};

/**
 * Agent task log entry.
 */
type AgentTaskLogEntry = {
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
};

/**
 * WebSocket connection state (AC7.5, AC7.6).
 */
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * WebSocket message types.
 */
type WebSocketMessageType =
  | 'task_status_update'
  | 'task_logs_update'
  | 'connection_status'
  | 'subscribe'
  | 'unsubscribe'
  | 'ping'
  | 'pong';

/**
 * WebSocket message format.
 */
type WebSocketMessage = {
  readonly type: WebSocketMessageType;
  readonly payload: unknown;
  readonly timestamp: string;
};

/**
 * Configuration for the agent task status hook.
 */
type UseAgentTaskStatusConfig = {
  /** Task ID to subscribe to */
  readonly taskId: string;
  /** WebSocket URL (defaults to /ws/agent-status) */
  readonly wsUrl?: string;
  /** API URL for polling fallback (defaults to /api/agent-tasks) */
  readonly apiUrl?: string;
  /** Maximum reconnection attempts (default: 5) */
  readonly maxReconnectAttempts?: number;
  /** Base reconnection delay in ms (default: 1000) */
  readonly reconnectDelay?: number;
  /** Polling interval in ms when WebSocket unavailable (default: 5000, AC7.7) */
  readonly pollingInterval?: number;
  /** Enable/disable the hook */
  readonly enabled?: boolean;
};

/**
 * Return type for the agent task status hook.
 */
type UseAgentTaskStatusResult = {
  /** Current task status */
  readonly status: AgentTaskRealtimeStatus | null;
  /** Task logs */
  readonly logs: readonly AgentTaskLogEntry[];
  /** WebSocket connection state (AC7.6) */
  readonly connectionState: ConnectionState;
  /** Whether using polling fallback (AC7.7) */
  readonly isPolling: boolean;
  /** Current reconnection attempt number */
  readonly reconnectAttempt: number;
  /** Error message if any */
  readonly error: string | null;
  /** Manually refresh status */
  readonly refresh: () => Promise<void>;
};

const DEFAULT_API_URL = 'http://localhost:3000';

const getWsUrl = (baseUrl?: string): string => {
  const base = baseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;
  const wsProtocol = base.startsWith('https') ? 'wss' : 'ws';
  const wsBase = base.replace(/^https?/, wsProtocol);
  return `${wsBase}/ws/agent-status`;
};

const getApiUrl = (baseUrl?: string): string =>
  baseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;

/**
 * Hook for real-time agent task status updates (AS-007).
 *
 * Features:
 * - AC7.1: Agent panel shows active task with status indicator
 * - AC7.2: Status updates in real-time via WebSocket
 * - AC7.3: Progress indicator shows task phase
 * - AC7.4: Task logs accessible via expandable section
 * - AC7.5: WebSocket reconnects automatically on disconnect
 * - AC7.6: Reconnection indicator shown when connection drops
 * - AC7.7: Falls back to polling if WebSocket unavailable
 */
export const useAgentTaskStatus = (
  config: UseAgentTaskStatusConfig,
): UseAgentTaskStatusResult => {
  const {
    taskId,
    wsUrl,
    apiUrl,
    maxReconnectAttempts = 5,
    reconnectDelay = 1000,
    pollingInterval = 5000,
    enabled = true,
  } = config;

  const [status, setStatus] = useState<AgentTaskRealtimeStatus | null>(null);
  const [logs, setLogs] = useState<AgentTaskLogEntry[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isPolling, setIsPolling] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  /**
   * Fetch status via REST API (polling fallback, AC7.7).
   */
  const fetchStatus = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current || !taskId) {
      return;
    }

    try {
      const response = await fetch(
        `${getApiUrl(apiUrl)}/api/agent-tasks/${taskId}/status`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        },
      );

      if (response.ok) {
        const data = (await response.json()) as { status: AgentTaskRealtimeStatus | null };
        if (isMountedRef.current && data.status) {
          setStatus(data.status);
          setError(null);
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch status');
      }
    }
  }, [taskId, apiUrl]);

  /**
   * Fetch logs via REST API (AC7.4).
   */
  const fetchLogs = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current || !taskId) {
      return;
    }

    try {
      const response = await fetch(
        `${getApiUrl(apiUrl)}/api/agent-tasks/${taskId}/logs`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        },
      );

      if (response.ok) {
        const data = (await response.json()) as { logs: AgentTaskLogEntry[] };
        if (isMountedRef.current) {
          setLogs(data.logs);
        }
      }
    } catch {
      // Logs fetch failure is not critical
    }
  }, [taskId, apiUrl]);

  /**
   * Refresh status and logs manually.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([fetchStatus(), fetchLogs()]);
  }, [fetchStatus, fetchLogs]);

  /**
   * Start polling fallback (AC7.7).
   */
  const startPolling = useCallback((): void => {
    if (pollingIntervalRef.current) {
      return;
    }

    setIsPolling(true);
    fetchStatus(); // Fetch immediately

    pollingIntervalRef.current = setInterval(() => {
      fetchStatus();
    }, pollingInterval);
  }, [fetchStatus, pollingInterval]);

  /**
   * Stop polling fallback.
   */
  const stopPolling = useCallback((): void => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  /**
   * Connect to WebSocket.
   */
  const connect = useCallback((): void => {
    if (!enabled || !taskId) {
      return;
    }

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setConnectionState('connecting');
    setError(null);

    try {
      const ws = new WebSocket(getWsUrl(wsUrl));
      wsRef.current = ws;

      ws.onopen = (): void => {
        if (!isMountedRef.current) {
          return;
        }

        setConnectionState('connected');
        setReconnectAttempt(0);
        stopPolling();

        // Subscribe to task updates
        const subscribeMessage: WebSocketMessage = {
          type: 'subscribe',
          payload: { taskId },
          timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(subscribeMessage));

        // Fetch initial status and logs
        fetchStatus();
        fetchLogs();
      };

      ws.onmessage = (event): void => {
        if (!isMountedRef.current) {
          return;
        }

        try {
          const message = JSON.parse(event.data as string) as WebSocketMessage;

          switch (message.type) {
            case 'task_status_update': {
              const payload = message.payload as {
                taskId: string;
                status: AgentTaskRealtimeStatus;
              };
              if (payload.taskId === taskId) {
                setStatus(payload.status);

                // Fetch logs when task completes (AC7.4)
                if (
                  payload.status.phase === 'completed' ||
                  payload.status.phase === 'failed'
                ) {
                  fetchLogs();
                }
              }
              break;
            }

            case 'task_logs_update': {
              const payload = message.payload as {
                taskId: string;
                logs: AgentTaskLogEntry[];
              };
              if (payload.taskId === taskId) {
                setLogs(payload.logs);
              }
              break;
            }

            case 'connection_status': {
              const payload = message.payload as { connected: boolean };
              if (payload.connected) {
                setConnectionState('connected');
              }
              break;
            }

            case 'pong': {
              // Heartbeat response, no action needed
              break;
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = (): void => {
        if (!isMountedRef.current) {
          return;
        }

        setError('WebSocket connection error');
      };

      ws.onclose = (): void => {
        if (!isMountedRef.current) {
          return;
        }

        wsRef.current = null;

        // Attempt reconnection (AC7.5)
        if (reconnectAttempt < maxReconnectAttempts) {
          setConnectionState('reconnecting');
          setReconnectAttempt((prev) => prev + 1);

          // Exponential backoff
          const delay = reconnectDelay * Math.pow(2, reconnectAttempt);
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        } else {
          // Fall back to polling (AC7.7)
          setConnectionState('disconnected');
          startPolling();
        }
      };
    } catch {
      // WebSocket not supported, fall back to polling (AC7.7)
      setConnectionState('disconnected');
      startPolling();
    }
  }, [
    enabled,
    taskId,
    wsUrl,
    reconnectAttempt,
    maxReconnectAttempts,
    reconnectDelay,
    fetchStatus,
    fetchLogs,
    startPolling,
    stopPolling,
  ]);

  /**
   * Disconnect from WebSocket.
   */
  const disconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      // Unsubscribe before closing
      if (wsRef.current.readyState === WebSocket.OPEN) {
        const unsubscribeMessage: WebSocketMessage = {
          type: 'unsubscribe',
          payload: { taskId },
          timestamp: new Date().toISOString(),
        };
        wsRef.current.send(JSON.stringify(unsubscribeMessage));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    stopPolling();
    setConnectionState('disconnected');
  }, [taskId, stopPolling]);

  // Initialize connection on mount
  useEffect(() => {
    isMountedRef.current = true;

    if (enabled && taskId) {
      connect();
    }

    return () => {
      isMountedRef.current = false;
      disconnect();
    };
  }, [enabled, taskId, connect, disconnect]);

  // Set up ping interval for heartbeat
  useEffect(() => {
    if (connectionState !== 'connected' || !wsRef.current) {
      return;
    }

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const pingMessage: WebSocketMessage = {
          type: 'ping',
          payload: {},
          timestamp: new Date().toISOString(),
        };
        wsRef.current.send(JSON.stringify(pingMessage));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
    };
  }, [connectionState]);

  return useMemo(
    () => ({
      status,
      logs,
      connectionState,
      isPolling,
      reconnectAttempt,
      error,
      refresh,
    }),
    [status, logs, connectionState, isPolling, reconnectAttempt, error, refresh],
  );
};

export type {
  AgentTaskLogEntry,
  AgentTaskRealtimeStatus,
  ConnectionState,
  TaskPhase,
  UseAgentTaskStatusConfig,
  UseAgentTaskStatusResult,
};
