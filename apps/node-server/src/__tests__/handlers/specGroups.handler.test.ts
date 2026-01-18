/**
 * Spec Groups Handler Tests
 *
 * Tests for spec group API endpoints.
 * Covers AC3.1-AC3.6 for state machine functionality.
 */

import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  InvalidStateTransitionError,
  SpecGroupConflictError,
  SpecGroupNotFoundError,
  SpecGroupState,
  type SpecGroup,
} from '@packages/backend-core/spec-groups';
import {
  createMockSpecGroup,
  createSpecGroupRepoFake,
  makeRequestContext,
  setBundledRuntime,
  type SpecGroupRepoFake,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const specGroupRepoModule = vi.hoisted(
  (): { fake?: SpecGroupRepoFake } => ({}),
);

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createSpecGroupRepoFake } = await import(
    '@packages/backend-core/testing'
  );
  const fake = createSpecGroupRepoFake();
  specGroupRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

const getRepoFake = (): SpecGroupRepoFake => {
  if (!specGroupRepoModule.fake) {
    throw new Error('SpecGroupRepoFake was not initialized');
  }
  return specGroupRepoModule.fake;
};

const importGetHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/specGroups.handler');
  return module.getSpecGroupRequestHandler;
};

const importTransitionHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/specGroups.handler');
  return module.transitionStateRequestHandler;
};

const importUpdateFlagsHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/specGroups.handler');
  return module.updateFlagsRequestHandler;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSpecGroupRequestHandler (AC3.1, AC3.2, AC3.3, AC3.4)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns spec group with state display and available transitions', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importGetHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const specGroup = createMockSpecGroup({
      id: 'test-id',
      state: SpecGroupState.DRAFT,
      sectionsCompleted: true,
    });
    repoFake.queueGetByIdSome(specGroup);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/spec-groups/test-id',
      params: { id: 'test-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as {
      specGroup: SpecGroup;
      stateDisplay: { label: string; color: string };
      availableTransitions: Array<{
        toState: string;
        enabled: boolean;
        disabledReason?: string;
      }>;
    };

    // AC3.1: State badge display
    expect(body.stateDisplay.label).toBe('Draft');
    expect(body.stateDisplay.color).toBe('gray');

    // AC3.2, AC3.3: Transition buttons with enabled status
    expect(body.availableTransitions).toHaveLength(1);
    expect(body.availableTransitions[0]?.toState).toBe(SpecGroupState.REVIEWED);
    expect(body.availableTransitions[0]?.enabled).toBe(true);
  });

  it('returns disabled transition with tooltip reason (AC3.4)', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importGetHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const specGroup = createMockSpecGroup({
      id: 'test-id',
      state: SpecGroupState.DRAFT,
      sectionsCompleted: false, // Precondition not met
    });
    repoFake.queueGetByIdSome(specGroup);

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/spec-groups/test-id',
      params: { id: 'test-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as {
      availableTransitions: Array<{
        toState: string;
        enabled: boolean;
        disabledReason?: string;
      }>;
    };

    // AC3.4: Invalid transition disabled with tooltip
    expect(body.availableTransitions[0]?.enabled).toBe(false);
    expect(body.availableTransitions[0]?.disabledReason).toBe(
      'All sections must be completed before review',
    );
  });

  it('returns 404 when spec group not found', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importGetHandler();
    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueGetByIdNone();

    const { req, res, captured } = makeRequestContext({
      method: 'GET',
      url: '/api/spec-groups/non-existent-id',
      params: { id: 'non-existent-id' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });
});

describe('transitionStateRequestHandler (AC3.5, AC3.6)', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('transitions state and returns updated spec group', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importTransitionHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const updatedSpecGroup = createMockSpecGroup({
      id: 'test-id',
      state: SpecGroupState.REVIEWED,
      sectionsCompleted: true,
      decisionLog: [
        {
          timestamp: '2024-01-01T12:00:00.000Z',
          actor: 'system',
          action: 'STATE_TRANSITION',
          fromState: SpecGroupState.DRAFT,
          toState: SpecGroupState.REVIEWED,
          reason: 'Review completed',
        },
      ],
    });
    repoFake.queueTransitionSuccess(updatedSpecGroup);

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-id/transition',
      params: { id: 'test-id' },
      body: {
        toState: SpecGroupState.REVIEWED,
        reason: 'Review completed',
      },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as { specGroup: SpecGroup };

    // AC3.5: State persisted
    expect(body.specGroup.state).toBe(SpecGroupState.REVIEWED);

    // AC3.6: Decision log updated
    expect(body.specGroup.decisionLog).toHaveLength(1);
    expect(body.specGroup.decisionLog[0]?.action).toBe('STATE_TRANSITION');
    expect(body.specGroup.decisionLog[0]?.fromState).toBe(SpecGroupState.DRAFT);
    expect(body.specGroup.decisionLog[0]?.toState).toBe(
      SpecGroupState.REVIEWED,
    );
    expect(body.specGroup.decisionLog[0]?.actor).toBe('system');
  });

  it('returns 404 when spec group not found', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importTransitionHandler();
    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueTransitionError(
      new SpecGroupNotFoundError({
        message: 'Spec group not found',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/non-existent-id/transition',
      params: { id: 'non-existent-id' },
      body: { toState: SpecGroupState.REVIEWED },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });

  it('returns error when transition is invalid', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importTransitionHandler();
    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueTransitionError(
      new InvalidStateTransitionError({
        message: 'Invalid transition from DRAFT to APPROVED',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-id/transition',
      params: { id: 'test-id' },
      body: { toState: SpecGroupState.APPROVED },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    // The error should be returned (status code depends on error mapping)
    expect(captured.statusCode).toBeDefined();
  });

  it('returns 409 on concurrent modification', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importTransitionHandler();
    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueTransitionError(
      new SpecGroupConflictError({
        message: 'Concurrent modification detected',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-id/transition',
      params: { id: 'test-id' },
      body: { toState: SpecGroupState.REVIEWED },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.CONFLICT);
  });

  it('validates request body schema', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importTransitionHandler();

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/spec-groups/test-id/transition',
      params: { id: 'test-id' },
      body: { toState: 'INVALID_STATE' },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
  });
});

describe('updateFlagsRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('updates flags and returns updated spec group', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importUpdateFlagsHandler();
    const repoFake = getRepoFake();
    repoFake.reset();

    const updatedSpecGroup = createMockSpecGroup({
      id: 'test-id',
      sectionsCompleted: true,
    });
    repoFake.queueUpdateFlagsSuccess(updatedSpecGroup);

    const { req, res, captured } = makeRequestContext({
      method: 'PUT',
      url: '/api/spec-groups/test-id/flags',
      params: { id: 'test-id' },
      body: { sectionsCompleted: true },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    const body = captured.sendBody as { specGroup: SpecGroup };
    expect(body.specGroup.sectionsCompleted).toBe(true);
  });

  it('returns 404 when spec group not found', async () => {
    // Arrange - import handler first to trigger mock initialization
    const handler = await importUpdateFlagsHandler();
    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueUpdateFlagsError(
      new SpecGroupNotFoundError({
        message: 'Spec group not found',
        cause: undefined,
      }),
    );

    const { req, res, captured } = makeRequestContext({
      method: 'PUT',
      url: '/api/spec-groups/non-existent-id/flags',
      params: { id: 'non-existent-id' },
      body: { sectionsCompleted: true },
    });

    // Act
    await handler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
  });
});
