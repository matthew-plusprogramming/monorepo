import { describe, expect, it } from 'vitest';

import { __ENTITY_CAMEL__RequestHandler } from '@/handlers/__ENTITY_CAMEL__.handler';
import { create__ENTITY_PASCAL__RepoFake } from '@/__tests__/fakes/__ENTITY_CAMEL__Repo';

describe('__ENTITY_CAMEL__RequestHandler', () => {
  it.skip('invokes the repository and returns a success response', async () => {
    // Arrange
    const repoFake = create__ENTITY_PASCAL__RepoFake();
    repoFake.queueCreateSuccess();

    // TODO: build a request object that reflects your route definition.
    const request = {
      body: {},
    } as unknown as Parameters<typeof __ENTITY_CAMEL__RequestHandler>[0];

    // Act
    const response = await __ENTITY_CAMEL__RequestHandler(request);

    // Assert
    expect(response.statusCode).toBe(200);
    expect(repoFake.calls.create).toHaveLength(1);
  });
});
