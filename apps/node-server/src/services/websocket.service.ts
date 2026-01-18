/**
 * WebSocket Service
 *
 * Manages WebSocket connections for real-time agent status updates (AS-007).
 * AC7.2: Status updates in real-time via WebSocket
 * AC7.5: WebSocket reconnects automatically on disconnect
 *
 * Security: Validates session tokens on connection to prevent unauthorized access.
 */

import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';

import {
  type AgentTaskRealtimeStatus,
  WebSocketMessageType,
  type WebSocketMessage,
} from '@packages/backend-core/agent-tasks';
import { Effect } from 'effect';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Simple logger for WebSocket service.
 */
const logger = {
  info: (...args: unknown[]): void => {
    console.info('[WebSocket]', ...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn('[WebSocket]', ...args);
  },
  error: (message: string, context?: Record<string, unknown>): void => {
    console.error('[WebSocket]', message, context);
  },
  debug: (message: string, context?: Record<string, unknown>): void => {
    if (process.env.DEBUG?.toLowerCase() === 'true') {
      console.info('[WebSocket]', message, context);
    }
  },
};

/**
 * Parse cookies from request headers.
 */
const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce(
    (cookies, cookie) => {
      const [name, ...rest] = cookie.trim().split('=');
      if (name && rest.length > 0) {
        cookies[name] = rest.join('=');
      }
      return cookies;
    },
    {} as Record<string, string>,
  );
};

/**
 * Validates a session token from the WebSocket upgrade request.
 * Returns true if the session is valid, false otherwise.
 *
 * Security: Uses constant-time comparison to prevent timing attacks.
 */
const validateSessionToken = (request: IncomingMessage): boolean => {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    logger.error('SESSION_SECRET not configured');
    return false;
  }

  const cookies = parseCookies(request.headers.cookie);
  const sessionToken = cookies['dashboard_session'];

  if (!sessionToken) {
    return false;
  }

  try {
    // Session token format: payload.signature
    const parts = sessionToken.split('.');
    if (parts.length !== 2) {
      return false;
    }

    const [payloadBase64, signatureHex] = parts;
    if (!payloadBase64 || !signatureHex) {
      return false;
    }

    // Verify signature using constant-time comparison
    const expectedSignature = crypto
      .createHmac('sha256', sessionSecret)
      .update(payloadBase64)
      .digest('hex');

    if (signatureHex.length !== expectedSignature.length) {
      return false;
    }

    const valid = crypto.timingSafeEqual(
      Buffer.from(signatureHex),
      Buffer.from(expectedSignature),
    );

    if (!valid) {
      return false;
    }

    // Verify expiration
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
};

/**
 * Configuration for the WebSocket service.
 */
export type WebSocketServiceConfig = {
  /** Ping interval in milliseconds (default: 30000) */
  readonly pingInterval?: number;
  /** Path for WebSocket connections (default: '/ws') */
  readonly path?: string;
};

/**
 * Connected client with subscription info.
 */
type ConnectedClient = {
  readonly ws: WebSocket;
  readonly subscribedTaskIds: Set<string>;
  lastPing: number;
  isAlive: boolean;
};

/**
 * WebSocket manager for handling real-time updates.
 */
class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ConnectedClient> = new Map();
  private pingIntervalId: NodeJS.Timeout | null = null;
  private readonly pingInterval: number;
  private readonly path: string;

  constructor(config: WebSocketServiceConfig = {}) {
    this.pingInterval = config.pingInterval ?? 30000;
    this.path = config.path ?? '/ws';
  }

  /**
   * Initialize the WebSocket server attached to an HTTP server.
   */
  initialize(server: Server): void {
    if (this.wss) {
      logger.warn('WebSocket server already initialized');
      return;
    }

    this.wss = new WebSocketServer({
      server,
      path: this.path,
    });

    this.wss.on('connection', (ws, request) => {
      this.handleConnection(ws, request);
    });

    this.wss.on('error', (error) => {
      logger.error('WebSocket server error', { error: error.message });
    });

    // Start heartbeat ping/pong
    this.startHeartbeat();

    logger.info(`WebSocket server initialized on path ${this.path}`);
  }

  /**
   * Handle new WebSocket connection.
   * Security: Validates session token before accepting connection.
   */
  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    // Security fix: Validate session before accepting connection
    if (!validateSessionToken(request)) {
      logger.warn('WebSocket connection rejected: invalid or missing session', {
        path: request.url,
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

    const client: ConnectedClient = {
      ws,
      subscribedTaskIds: new Set(),
      lastPing: Date.now(),
      isAlive: true,
    };

    this.clients.set(ws, client);

    logger.info('WebSocket client connected', {
      path: request.url,
      totalClients: this.clients.size,
    });

    // Send connection confirmation
    this.sendMessage(ws, {
      type: WebSocketMessageType.CONNECTION_STATUS,
      payload: { connected: true },
      timestamp: new Date().toISOString(),
    });

    ws.on('message', (data) => {
      this.handleMessage(ws, data.toString());
    });

    ws.on('pong', () => {
      const client = this.clients.get(ws);
      if (client) {
        client.isAlive = true;
        client.lastPing = Date.now();
      }
    });

    ws.on('close', () => {
      this.handleClose(ws);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket client error', { error: error.message });
      this.handleClose(ws);
    });
  }

  /**
   * Handle incoming WebSocket message.
   */
  private handleMessage(ws: WebSocket, data: string): void {
    try {
      const message = JSON.parse(data) as WebSocketMessage;
      const client = this.clients.get(ws);

      if (!client) {
        return;
      }

      switch (message.type) {
        case WebSocketMessageType.SUBSCRIBE: {
          const payload = message.payload as { taskId: string };
          if (payload.taskId) {
            client.subscribedTaskIds.add(payload.taskId);
            logger.debug('Client subscribed to task', { taskId: payload.taskId });
          }
          break;
        }

        case WebSocketMessageType.UNSUBSCRIBE: {
          const payload = message.payload as { taskId: string };
          if (payload.taskId) {
            client.subscribedTaskIds.delete(payload.taskId);
            logger.debug('Client unsubscribed from task', {
              taskId: payload.taskId,
            });
          }
          break;
        }

        case WebSocketMessageType.PING: {
          this.sendMessage(ws, {
            type: WebSocketMessageType.PONG,
            payload: {},
            timestamp: new Date().toISOString(),
          });
          break;
        }

        default:
          logger.debug('Unknown message type', { type: message.type });
      }
    } catch (error) {
      logger.error('Failed to parse WebSocket message', {
        error: error instanceof Error ? error.message : 'Unknown error',
        data,
      });
    }
  }

  /**
   * Handle WebSocket close event.
   */
  private handleClose(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (client) {
      this.clients.delete(ws);
      logger.info('WebSocket client disconnected', {
        subscribedTasks: client.subscribedTaskIds.size,
        totalClients: this.clients.size,
      });
    }
  }

  /**
   * Start heartbeat ping interval.
   */
  private startHeartbeat(): void {
    this.pingIntervalId = setInterval(() => {
      this.clients.forEach((client, ws) => {
        if (!client.isAlive) {
          logger.debug('Terminating unresponsive WebSocket client');
          ws.terminate();
          this.clients.delete(ws);
          return;
        }

        client.isAlive = false;
        ws.ping();
      });
    }, this.pingInterval);
  }

  /**
   * Send a message to a WebSocket client.
   */
  private sendMessage(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast task status update to subscribed clients (AC7.2).
   */
  broadcastTaskStatusUpdate(status: AgentTaskRealtimeStatus): void {
    const message: WebSocketMessage = {
      type: WebSocketMessageType.TASK_STATUS_UPDATE,
      payload: {
        taskId: status.taskId,
        status,
      },
      timestamp: new Date().toISOString(),
    };

    let broadcastCount = 0;

    this.clients.forEach((client) => {
      if (client.subscribedTaskIds.has(status.taskId)) {
        this.sendMessage(client.ws, message);
        broadcastCount++;
      }
    });

    logger.debug('Broadcast task status update', {
      taskId: status.taskId,
      phase: status.phase,
      clientsNotified: broadcastCount,
    });
  }

  /**
   * Broadcast to all clients subscribed to a specific task.
   */
  broadcastToTask(taskId: string, message: WebSocketMessage): void {
    this.clients.forEach((client) => {
      if (client.subscribedTaskIds.has(taskId)) {
        this.sendMessage(client.ws, message);
      }
    });
  }

  /**
   * Get the number of connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of subscribers for a specific task.
   */
  getTaskSubscriberCount(taskId: string): number {
    let count = 0;
    this.clients.forEach((client) => {
      if (client.subscribedTaskIds.has(taskId)) {
        count++;
      }
    });
    return count;
  }

  /**
   * Shutdown the WebSocket server.
   */
  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pingIntervalId) {
        clearInterval(this.pingIntervalId);
        this.pingIntervalId = null;
      }

      if (this.wss) {
        // Close all clients
        this.clients.forEach((client) => {
          client.ws.close(1001, 'Server shutting down');
        });
        this.clients.clear();

        this.wss.close(() => {
          logger.info('WebSocket server shut down');
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Singleton WebSocket manager instance.
 */
let webSocketManager: WebSocketManager | null = null;

/**
 * Get or create the WebSocket manager instance.
 */
export const getWebSocketManager = (
  config?: WebSocketServiceConfig,
): WebSocketManager => {
  if (!webSocketManager) {
    webSocketManager = new WebSocketManager(config);
  }
  return webSocketManager;
};

/**
 * Initialize WebSocket server with an HTTP server.
 */
export const initializeWebSocket = (
  server: Server,
  config?: WebSocketServiceConfig,
): Effect.Effect<WebSocketManager, never, never> =>
  Effect.sync(() => {
    const manager = getWebSocketManager(config);
    manager.initialize(server);
    return manager;
  });

/**
 * Broadcast a task status update via WebSocket.
 */
export const broadcastTaskStatus = (
  status: AgentTaskRealtimeStatus,
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    const manager = getWebSocketManager();
    manager.broadcastTaskStatusUpdate(status);
  });

/**
 * Shutdown the WebSocket server.
 */
export const shutdownWebSocket = (): Effect.Effect<void, never, never> =>
  Effect.promise(async () => {
    if (webSocketManager) {
      await webSocketManager.shutdown();
      webSocketManager = null;
    }
  });

export { WebSocketManager };
