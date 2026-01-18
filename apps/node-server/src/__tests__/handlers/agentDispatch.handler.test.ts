/**
 * Agent Dispatch Handler Tests
 *
 * Tests for agent task dispatch API endpoints.
 * Covers AC6.2-AC6.7 for webhook dispatch functionality.
 */

import {
  AgentAction,
  AgentTaskNotFoundError,
  AgentTaskStatus,
  HTTP_RESPONSE,
  SpecGroupNotFoundError,
  SpecGroupState,
  WebhookDispatchError,
  WebhookNotConfiguredError,
  WebhookTimeoutError,
  type AgentTask,
} from '@packages/backend-core';
import {
  createAgentTaskRepoFake,
  createMockAgentTask,
  createMockSpecGroup,
  createSpecGroupRepoFake,
  createWebhookServiceFake,
  makeRequestContext,
  setBundledRuntime,
  type AgentTaskRepoFake,
  type SpecGroupRepoFake,
  type WebhookServiceFake,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import { Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const moduleFakes = vi.hoisted(
  (): {
    specGroupRepoFake?: SpecGroupRepoFake;
    agentTaskRepoFake?: AgentTaskRepoFake;
    webhookServiceFake?: WebhookServiceFake;
  } => ({}),
);

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createSpecGroupRepoFake, createAgentTaskRepoFake, createWebhookServiceFake } =
    await import('@packages/backend-core/testing');

  const specGroupRepoFake = createSpecGroupRepoFake();
  const agentTaskRepoFake = createAgentTaskRepoFake();
  const webhookServiceFake = createWebhookServiceFake();

  moduleFakes.specGroupRepoFake = specGroupRepoFake;
  moduleFakes.agentTaskRepoFake = agentTaskRepoFake;
  moduleFakes.webhookServiceFake = webhookServiceFake;

  const AppLayer = specGroupRepoFake.layer.pipe(
    Layer.merge(agentTaskRepoFake.layer),
    Layer.merge(webhookServiceFake.layer),
  );

  return { AppLayer };
});

const getSpecGroupRepoFake = (): SpecGroupRepoFake => {
  if (!moduleFakes.specGroupRepoFake) {
    throw new Error('SpecGroupRepoFake was not initialized');
  }
  return moduleFakes.specGroupRepoFake;
};

const getAgentTaskRepoFake = (): AgentTaskRepoFake => {
  if (!moduleFakes.agentTaskRepoFake) {
    throw new Error('AgentTaskRepoFake was not initialized');
  }
  return moduleFakes.agentTaskRepoFake;
};

const getWebhookServiceFake = (): WebhookServiceFake => {
  if (!moduleFakes.webhookServiceFake) {
    throw new Error('WebhookServiceFake was not initialized');
  }
  return moduleFakes.webhookServiceFake;
};

const importDispatchHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/agentDispatch.handler');
  return module.dispatchAgentTaskRequestHandler;
};

const importGetAgentTaskHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/agentDispatch.handler');
  return module.getAgentTaskRequestHandler;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dispatchAgentTaskRequestHandler (AC6.2, AC6.3, AC6.7)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('dispatches implement action and creates task (AC6.2, AC6.3, AC6.7)', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const agentTaskRepoFake = getAgentTaskRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    agentTaskRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({
      id: 'test-spec-group-id',
      name: 'Test Spec Group',
      state: SpecGroupState.APPROVED,
    });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlSuccess('http://localhost:3001/webhook');

    const createdTask = createMockAgentTask({
      id: 'new-task-id',
      specGroupId: 'test-spec-group-id',
      action: AgentAction.IMPLEMENT,
      status: AgentTaskStatus.PENDING,
    });
    agentTaskRepoFake.queueCreateSuccess(createdTask);

    webhookServiceFake.queueDispatchSuccess({
      success: true,
      taskId: 'new-task-id',
      responseStatus: 200,
    });

    const dispatchedTask = createMockAgentTask({
      ...createdTask,
      status: AgentTaskStatus.DISPATCHED,
      dispatchedAt: '2024-01-01T12:00:00.000Z',
    });
    agentTaskRepoFake.queueUpdateStatusSuccess(dispatchedTask);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
    const body = captured.sendBody as {
      task: AgentTask;
      message: string;
    };

    // AC6.3: Payload includes spec group ID, action type
    expect(body.task.specGroupId).toBe('test-spec-group-id');
    expect(body.task.action).toBe('implement');

    // AC6.7: Task logged to AgentTasks table
    expect(agentTaskRepoFake.calls.create).toHaveLength(1);
    expect(agentTaskRepoFake.calls.create[0]?.specGroupId).toBe('test-spec-group-id');
    expect(agentTaskRepoFake.calls.create[0]?.action).toBe('implement');

    // Verify webhook dispatch was called
    expect(webhookServiceFake.calls.dispatch).toHaveLength(1);
    expect(webhookServiceFake.calls.dispatch[0]?.specGroupId).toBe('test-spec-group-id');
    expect(webhookServiceFake.calls.dispatch[0]?.action).toBe('implement');

    expect(body.message).toBe('Implementation task dispatched successfully');
  });

  it('dispatches test action correctly', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const agentTaskRepoFake = getAgentTaskRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    agentTaskRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({ id: 'test-spec-group-id' });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlSuccess('http://localhost:3001/webhook');

    const createdTask = createMockAgentTask({
      id: 'new-task-id',
      specGroupId: 'test-spec-group-id',
      action: AgentAction.TEST,
    });
    agentTaskRepoFake.queueCreateSuccess(createdTask);

    webhookServiceFake.queueDispatchSuccess({
      success: true,
      taskId: 'new-task-id',
      responseStatus: 200,
    });

    const dispatchedTask = createMockAgentTask({
      ...createdTask,
      status: AgentTaskStatus.DISPATCHED,
    });
    agentTaskRepoFake.queueUpdateStatusSuccess(dispatchedTask);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'test' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
    const body = captured.sendBody as { task: AgentTask; message: string };
    expect(body.task.action).toBe('test');
    expect(body.message).toBe('Test task dispatched successfully');
  });

  it('returns 404 when spec group not found', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();

    specGroupRepoFake.reset();
    specGroupRepoFake.queueGetByIdNone();

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/non-existent-id/dispatch',
      params: { id: 'non-existent-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });

  it('returns 503 when webhook URL not configured', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({ id: 'test-spec-group-id' });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlError(
      new WebhookNotConfiguredError({
        message: 'AGENT_WEBHOOK_URL not configured',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.SERVICE_UNAVAILABLE);
  });

  it('returns 502 on webhook dispatch failure (AC6.6)', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const agentTaskRepoFake = getAgentTaskRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    agentTaskRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({ id: 'test-spec-group-id' });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlSuccess('http://localhost:3001/webhook');

    const createdTask = createMockAgentTask({
      id: 'new-task-id',
      specGroupId: 'test-spec-group-id',
    });
    agentTaskRepoFake.queueCreateSuccess(createdTask);

    webhookServiceFake.queueDispatchError(
      new WebhookDispatchError({
        message: 'Connection refused',
        cause: undefined,
      }),
    );

    // Queue the failed status update
    const failedTask = createMockAgentTask({
      ...createdTask,
      status: AgentTaskStatus.FAILED,
      errorMessage: 'Webhook dispatch failed',
    });
    agentTaskRepoFake.queueUpdateStatusSuccess(failedTask);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    const body = captured.sendBody as { error: string; retryable: boolean };
    expect(body.retryable).toBe(true);
  });

  it('returns 504 on webhook timeout (AC6.6)', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const agentTaskRepoFake = getAgentTaskRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    agentTaskRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({ id: 'test-spec-group-id' });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlSuccess('http://localhost:3001/webhook');

    const createdTask = createMockAgentTask({
      id: 'new-task-id',
      specGroupId: 'test-spec-group-id',
    });
    agentTaskRepoFake.queueCreateSuccess(createdTask);

    webhookServiceFake.queueDispatchError(
      new WebhookTimeoutError({
        message: 'Webhook timed out after 10000ms',
        cause: undefined,
      }),
    );

    // Queue the failed status update
    const failedTask = createMockAgentTask({
      ...createdTask,
      status: AgentTaskStatus.FAILED,
    });
    agentTaskRepoFake.queueUpdateStatusSuccess(failedTask);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(504); // Gateway Timeout
    const body = captured.sendBody as { error: string; retryable: boolean };
    expect(body.retryable).toBe(true);
  });

  it('validates action in request body', async () => {
    // Arrange
    const handler = await importDispatchHandler();

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'invalid-action' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
  });

  it('includes context with spec group name in dispatch (AC6.3)', async () => {
    // Arrange
    const handler = await importDispatchHandler();
    const specGroupRepoFake = getSpecGroupRepoFake();
    const agentTaskRepoFake = getAgentTaskRepoFake();
    const webhookServiceFake = getWebhookServiceFake();

    specGroupRepoFake.reset();
    agentTaskRepoFake.reset();
    webhookServiceFake.reset();

    const specGroup = createMockSpecGroup({
      id: 'test-spec-group-id',
      name: 'My Custom Spec Group',
    });
    specGroupRepoFake.queueGetByIdSome(specGroup);

    webhookServiceFake.queueGetWebhookUrlSuccess('http://localhost:3001/webhook');

    const createdTask = createMockAgentTask({
      id: 'new-task-id',
      context: {
        specGroupId: 'test-spec-group-id',
        specGroupName: 'My Custom Spec Group',
        triggeredBy: 'system',
        triggeredAt: '2024-01-01T00:00:00.000Z',
      },
    });
    agentTaskRepoFake.queueCreateSuccess(createdTask);

    webhookServiceFake.queueDispatchSuccess({
      success: true,
      taskId: 'new-task-id',
      responseStatus: 200,
    });

    agentTaskRepoFake.queueUpdateStatusSuccess({
      ...createdTask,
      status: AgentTaskStatus.DISPATCHED,
    });

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-spec-group-id/dispatch',
      params: { id: 'test-spec-group-id' },
      body: { action: 'implement' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);

    // Verify context in webhook dispatch call
    expect(webhookServiceFake.calls.dispatch[0]?.context.specGroupName).toBe(
      'My Custom Spec Group',
    );
  });
});

describe('getAgentTaskRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns agent task when found', async () => {
    // Arrange
    const handler = await importGetAgentTaskHandler();
    const agentTaskRepoFake = getAgentTaskRepoFake();

    agentTaskRepoFake.reset();

    const task = createMockAgentTask({
      id: 'existing-task-id',
      status: AgentTaskStatus.DISPATCHED,
    });
    agentTaskRepoFake.queueGetByIdSome(task);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/existing-task-id',
      params: { id: 'existing-task-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as { task: AgentTask };
    expect(body.task.id).toBe('existing-task-id');
    expect(body.task.status).toBe(AgentTaskStatus.DISPATCHED);
  });

  it('returns 404 when task not found', async () => {
    // Arrange
    const handler = await importGetAgentTaskHandler();
    const agentTaskRepoFake = getAgentTaskRepoFake();

    agentTaskRepoFake.reset();
    agentTaskRepoFake.queueGetByIdNone();

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/agent-tasks/non-existent-id',
      params: { id: 'non-existent-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });
});
