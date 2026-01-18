/**
 * Agent Task Status Handler Tests
 *
 * Tests for agent task real-time status API endpoints (AS-007).
 * Covers AC7.1-AC7.7 for real-time agent status functionality.
 */

import { HTTP_RESPONSE } from '@packages/backend-core';
import { AgentTaskNotFoundError } from '@packages/backend-core/agent-tasks';
import {
  createAgentTaskRepoFake,
  createMockAgentTask,
  createMockLogEntry,
  createMockRealtimeStatus,
  makeRequestContext,
  setBundledRuntime,
  type AgentTaskRepoFake,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const agentTaskRepoModule = vi.hoisted(
  (): { fake?: AgentTaskRepoFake } => ({}),
);

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/websocket.service', async () => {
  const { Effect } = await import('effect');
  return {
    broadcastTaskStatus: vi.fn().mockImplementation(() => Effect.void),
    getWebSocketManager: vi.fn().mockReturnValue({
      broadcastTaskStatusUpdate: vi.fn(),
    }),
  };
});

vi.mock('@/layers/app.layer', async () => {
  const { createAgentTaskRepoFake } = await import(
    '@packages/backend-core/testing'
  );
  const fake = createAgentTaskRepoFake();
  agentTaskRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

const getRepoFake = (): AgentTaskRepoFake => {
  if (!agentTaskRepoModule.fake) {
    throw new Error('AgentTaskRepoFake was not initialized');
  }
  return agentTaskRepoModule.fake;
};

const importUpdateStatusHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/agentTaskStatus.handler');
  return module.updateAgentTaskStatusRequestHandler;
};

const importGetStatusHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/agentTaskStatus.handler');
  return module.getAgentTaskStatusRequestHandler;
};

const importGetLogsHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/agentTaskStatus.handler');
  return module.getAgentTaskLogsRequestHandler;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updateAgentTaskStatusRequestHandler (AC7.1, AC7.2, AC7.3)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('updates task status and returns updated status (AC7.3)', async () => {
    // Arrange
    const handler = await importUpdateStatusHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const mockStatus = createMockRealtimeStatus({
      taskId: 'test-task-id',
      phase: 'running',
      progress: 50,
      message: 'Processing...',
    });
    repoFake.queueUpdateRealtimeStatusSuccess(mockStatus);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
      body: {
        phase: 'running',
        progress: 50,
        message: 'Processing...',
      },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as {
      success: boolean;
      status: { phase: string; progress?: number };
    };

    expect(body.success).toBe(true);
    expect(body.status.phase).toBe('running');
    expect(body.status.progress).toBe(50);
  });

  it('accepts status update with log entry (AC7.4)', async () => {
    // Arrange
    const handler = await importUpdateStatusHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const mockStatus = createMockRealtimeStatus({
      taskId: 'test-task-id',
      phase: 'running',
    });
    repoFake.queueUpdateRealtimeStatusSuccess(mockStatus);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
      body: {
        phase: 'running',
        logEntry: {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Started processing',
        },
      },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);

    // Verify the log entry was included in the call
    expect(repoFake.calls.updateRealtimeStatus).toHaveLength(1);
    expect(repoFake.calls.updateRealtimeStatus[0]?.logEntry).toBeDefined();
  });

  it('returns 404 when task not found', async () => {
    // Arrange
    const handler = await importUpdateStatusHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    repoFake.queueUpdateRealtimeStatusError(
      new AgentTaskNotFoundError({
        message: 'Agent task not found',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/agent-tasks/non-existent-id/status',
      params: { id: 'non-existent-id' },
      body: { phase: 'running' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });

  it('returns 400 for invalid phase value', async () => {
    // Arrange
    const handler = await importUpdateStatusHandler();

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
      body: { phase: 'invalid_phase' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
  });

  it('validates progress is between 0 and 100', async () => {
    // Arrange
    const handler = await importUpdateStatusHandler();

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
      body: { phase: 'running', progress: 150 },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
  });
});

describe('getAgentTaskStatusRequestHandler (AC7.7 - Polling Fallback)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns task status for polling fallback', async () => {
    // Arrange
    const handler = await importGetStatusHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const mockStatus = createMockRealtimeStatus({
      taskId: 'test-task-id',
      phase: 'running',
      progress: 75,
    });
    repoFake.queueGetRealtimeStatusSome(mockStatus);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as {
      status: { taskId: string; phase: string; progress?: number } | null;
    };

    expect(body.status).not.toBeNull();
    expect(body.status?.taskId).toBe('test-task-id');
    expect(body.status?.phase).toBe('running');
    expect(body.status?.progress).toBe(75);
  });

  it('returns null status when task has no realtime status', async () => {
    // Arrange
    const handler = await importGetStatusHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    repoFake.queueGetRealtimeStatusNone();

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/test-task-id/status',
      params: { id: 'test-task-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as { status: null };
    expect(body.status).toBeNull();
  });
});

describe('getAgentTaskLogsRequestHandler (AC7.4 - Task Logs)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns task logs for completed task', async () => {
    // Arrange
    const handler = await importGetLogsHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const mockTask = createMockAgentTask({ id: 'test-task-id' });
    repoFake.queueGetByIdSome(mockTask);

    const mockLogs = [
      createMockLogEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'info',
        message: 'Task started',
      }),
      createMockLogEntry({
        timestamp: '2024-01-01T00:01:00.000Z',
        level: 'info',
        message: 'Task completed',
      }),
    ];
    repoFake.queueGetLogsSuccess(mockLogs);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/test-task-id/logs',
      params: { id: 'test-task-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as {
      taskId: string;
      logs: Array<{ timestamp: string; level: string; message: string }>;
    };

    expect(body.taskId).toBe('test-task-id');
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0]?.message).toBe('Task started');
    expect(body.logs[1]?.message).toBe('Task completed');
  });

  it('returns 404 when task not found', async () => {
    // Arrange
    const handler = await importGetLogsHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    repoFake.queueGetByIdNone();

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/non-existent-id/logs',
      params: { id: 'non-existent-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });

  it('returns empty logs array when no logs exist', async () => {
    // Arrange
    const handler = await importGetLogsHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const mockTask = createMockAgentTask({ id: 'test-task-id' });
    repoFake.queueGetByIdSome(mockTask);
    repoFake.queueGetLogsSuccess([]);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/test-task-id/logs',
      params: { id: 'test-task-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as { logs: unknown[] };
    expect(body.logs).toHaveLength(0);
  });
});
