import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { __ENTITY_PASCAL__Public } from '@packages/schemas/__ENTITY_SLUG__';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { __ENTITY_PASCAL__RepoFake } from '@/__tests__/fakes/__ENTITY_CAMEL__Repo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const repoModule = vi.hoisted((): { fake?: __ENTITY_PASCAL__RepoFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { create__ENTITY_PASCAL__RepoFake } = await import(
    '@/__tests__/fakes/__ENTITY_CAMEL__Repo'
  );
  const fake = create__ENTITY_PASCAL__RepoFake();
  repoModule.fake = fake;
  return { AppLayer: fake.layer };
});

const getRepoFake = (): __ENTITY_PASCAL__RepoFake => {
  if (!repoModule.fake) {
    throw new Error('__ENTITY_PASCAL__Repo fake was not initialized');
  }
  return repoModule.fake;
};

describe('get__ENTITY_PASCAL__RequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it.skip('returns 200 when the entity is found', async () => {
    const { req, res, captured } = makeRequestContext({
      params: {
        /**
         * TODO: align key with your router definition (e.g., `identifier`).
         */
        id: 'TODO: replace with a valid identifier',
      },
    });

    const { get__ENTITY_PASCAL__RequestHandler } = await import(
      '@/handlers/get__ENTITY_PASCAL__.handler'
    );

    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueGetSome({
      /**
       * TODO: replace placeholder fields once the schema is finalized.
       */
      id: 'placeholder-id',
    });

    await get__ENTITY_PASCAL__RequestHandler(req, res, vi.fn());

    expect(repoFake.calls.getById).toHaveLength(1);
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
  });

  it.skip('returns 502 when the entity is missing', async () => {
    const { req, res, captured } = makeRequestContext({
      params: {
        id: 'TODO: replace with a valid identifier',
      },
    });

    const { get__ENTITY_PASCAL__RequestHandler } = await import(
      '@/handlers/get__ENTITY_PASCAL__.handler'
    );

    const repoFake = getRepoFake();
    repoFake.reset();
    repoFake.queueGetNone();

    await get__ENTITY_PASCAL__RequestHandler(req, res, vi.fn());

    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  });
});
